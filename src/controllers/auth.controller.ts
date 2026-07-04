import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2";
import { v4 as uuidv4 } from "uuid";
import { evaluateSubscription } from "../lib/subscription";
import { issueOtp, verifyOtp, isSmsConfigured } from "../lib/otp";
import { sendSmsOtp } from "../services/comm/sms.service";
import { addMonths, addDays } from "../lib/dates";

// Free-trial length (days) for a newly created depot. Configurable.
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "14", 10) || 14;

// Best-effort decode of a bearer token to see if the caller is a SUPER_ADMIN.
// Used so only a super admin can grant a PAID subscription at depot creation;
// everyone else (public self-signup) gets the free trial.
function callerIsSuperAdmin(req: Request): boolean {
    try {
        const h = req.headers.authorization;
        if (!h || !h.startsWith("Bearer ")) return false;
        const decoded: any = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET as string);
        return decoded?.role === "SUPER_ADMIN";
    } catch {
        return false;
    }
}

// When set to "false", the legacy phone-only password reset is disabled and an
// OTP code becomes mandatory. Defaults to enabled so existing apps keep working.
const ALLOW_LEGACY_RESET = process.env.ALLOW_LEGACY_RESET !== "false";

// ── Helper: generate tokens ───────────────────────────────────────
const generateTokens = (
    userId: string,
    role: string,
    depotId: string | null
) => {
    const accessOptions: SignOptions = { expiresIn: '24h' };
    const refreshOptions: SignOptions = { expiresIn: '30d' };

    const accessToken = jwt.sign(
        { userId, role, depotId },
        process.env.JWT_SECRET as string,
        accessOptions
    );
    const refreshToken = jwt.sign(
        { userId, role, depotId },
        process.env.JWT_REFRESH_SECRET as string,
        refreshOptions
    );

    return { accessToken, refreshToken };
};

// ─── LOGIN ────────────────────────────────────────────────────────
export const login = async (req: Request, res: Response) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ message: 'Phone and password required' });
        }

        const user = await prisma.user.findFirst({
            where: { phone, isActive: true },
            include: {
                depot: {
                    select: {
                        isActive: true,
                        subscriptionStatus: true,
                        subscriptionEndsAt: true,
                        trialEndsAt: true,
                        gracePeriodDays: true,
                        blockedReason: true,
                    },
                },
            },
        });

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // ── Subscription gate (super admin bypasses) ──────────────────
        let subscription: ReturnType<typeof evaluateSubscription> | null = null;
        if (user.role !== 'SUPER_ADMIN' && user.depot) {
            subscription = evaluateSubscription(user.depot);
            if (subscription.blocked) {
                return res.status(403).json({
                    message: subscription.message,
                    code: 'SUBSCRIPTION_REQUIRED',
                    reason: subscription.reason,
                });
            }
        }

        const { accessToken, refreshToken } = generateTokens(
            user.id,
            user.role,
            user.depotId
        );

        await prisma.user.update({
            where: { id: user.id },
            data: { refreshToken },
        });

        return res.status(200).json({
            token: accessToken,
            refreshToken,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone,
                role: user.role,
                depotId: user.depotId,
            },
            subscription: subscription
                ? {
                      status: subscription.status,
                      pastDue: subscription.pastDue,
                      message: subscription.pastDue ? subscription.message : null,
                  }
                : null,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────
export const refreshToken = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(401).json({ message: 'Refresh token required' });
        }

        let decoded: any;
        try {
            decoded = jwt.verify(
                refreshToken,
                process.env.JWT_REFRESH_SECRET as string
            );
        } catch {
            return res.status(401).json({ message: 'Invalid or expired refresh token' });
        }

        const user = await prisma.user.findFirst({
            where: { id: decoded.userId, refreshToken, isActive: true },
        });

        if (!user) {
            return res.status(401).json({ message: 'Refresh token revoked' });
        }

        const tokens = generateTokens(user.id, user.role, user.depotId);

        await prisma.user.update({
            where: { id: user.id },
            data: { refreshToken: tokens.refreshToken },
        });

        return res.status(200).json({
            token: tokens.accessToken,
            refreshToken: tokens.refreshToken,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ─── LOGOUT ───────────────────────────────────────────────────────
export const logout = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        await prisma.user.update({
            where: { id: user.userId },
            data: { refreshToken: null },
        });
        return res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ─── FORGOT PASSWORD ──────────────────────────────────────────────
// Step 1: verify phone exists
export const verifyPhone = async (req: Request, res: Response) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ message: 'Phone number required' });
        }

        const user = await prisma.user.findFirst({
            where: { phone, isActive: true },
            select: { id: true, name: true, phone: true },
        });

        if (!user) {
            // Return 404 so the Flutter app knows the phone doesn't exist
            return res.status(404).json({ message: 'No account found with this phone number' });
        }

        // Issue and send an OTP if SMS is configured. Never fail the request if
        // SMS delivery fails — legacy clients can still proceed (see resetPassword).
        let otpSent = false;
        if (isSmsConfigured()) {
            try {
                const code = await issueOtp(user.phone!, 'PASSWORD_RESET');
                await sendSmsOtp(user.phone!, code);
                otpSent = true;
            } catch (smsErr: any) {
                console.error('[verifyPhone] OTP send failed:', smsErr?.message);
            }
        }

        // Phone exists — Flutter can now show the new password fields
        return res.status(200).json({
            message: 'Account found',
            phone: user.phone,
            otpSent,
            otpRequired: !ALLOW_LEGACY_RESET,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// Optional intermediate step: verify an OTP before allowing reset.
export const verifyPasswordOtp = async (req: Request, res: Response) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) {
            return res.status(400).json({ message: 'Phone and code required' });
        }
        const ok = await verifyOtp(phone, String(code), 'PASSWORD_RESET');
        if (!ok) {
            return res
                .status(400)
                .json({ message: 'Invalid or expired code', code: 'OTP_INVALID' });
        }
        return res.status(200).json({ message: 'Code verified', verified: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// Step 2: reset password. When a `code` is supplied it is verified (secure path).
// When it is absent, the legacy phone-only reset is used only if enabled.
export const resetPassword = async (req: Request, res: Response) => {
    try {
        const { phone, newPassword, code } = req.body;

        if (!phone || !newPassword) {
            return res.status(400).json({ message: 'Phone and new password required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const user = await prisma.user.findFirst({
            where: { phone, isActive: true },
        });

        if (!user) {
            return res.status(404).json({ message: 'Account not found' });
        }

        // Enforce OTP verification unless legacy mode is explicitly allowed.
        if (code) {
            const ok = await verifyOtp(phone, String(code), 'PASSWORD_RESET');
            if (!ok) {
                return res
                    .status(400)
                    .json({ message: 'Invalid or expired code', code: 'OTP_INVALID' });
            }
        } else if (!ALLOW_LEGACY_RESET) {
            return res.status(400).json({
                message: 'Verification code required',
                code: 'OTP_REQUIRED',
            });
        } else {
            console.warn(
                `[resetPassword] Legacy (code-less) reset used for ${phone}. ` +
                    `Set ALLOW_LEGACY_RESET=false once clients send OTP codes.`
            );
        }

        const hashed = await bcrypt.hash(newPassword, 10);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashed,
                // Invalidate all existing sessions
                refreshToken: null,
            },
        });

        return res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ─── CREATE DEPOT ─────────────────────────────────────────────────
export const createDepot = async (req: Request, res: Response) => {
    try {
        const {
            depotName,
            depotCity,
            depotAddress,
            depotPhone,
            ownerName,
            ownerPhone,
            password,
        } = req.body;

        console.log(`🏪 createDepot: name=${depotName}, hasFile=${!!req.file}`);

        if (!depotName || !ownerName || !ownerPhone || !password) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const existing = await prisma.user.findFirst({ where: { phone: ownerPhone } });
        if (existing) {
            return res.status(400).json({ message: "Phone already in use" });
        }

        // ── Decide the initial subscription ───────────────────────────
        // Default: a free trial of TRIAL_DAYS (2 weeks). A super admin may
        // instead grant a PAID subscription for a chosen number of months.
        const {
            subscriptionType, // "TRIAL" | "PAID"
            subscriptionMonths, // integer number of months for PAID
            subscriptionPlan,
        } = req.body;

        const isAdmin = callerIsSuperAdmin(req);
        const now = new Date();
        let subFields: any;

        if (isAdmin && String(subscriptionType).toUpperCase() === "PAID") {
            const months = Math.max(1, Math.round(Number(subscriptionMonths) || 1));
            subFields = {
                subscriptionStatus: "ACTIVE",
                subscriptionEndsAt: addMonths(now, months),
                trialEndsAt: null,
                ...(subscriptionPlan ? { subscriptionPlan } : {}),
            };
        } else {
            // Free trial (default for everyone, including public self-signup).
            subFields = {
                subscriptionStatus: "TRIAL",
                trialEndsAt: addDays(now, TRIAL_DAYS),
                subscriptionEndsAt: null,
            };
        }

        let logoUrl: string | undefined;
        if (req.file) {
            try {
                const key = `depots/${uuidv4()}-${req.file.originalname}`;
                await r2Client.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME!,
                        Key: key,
                        Body: req.file.buffer,
                        ContentType: req.file.mimetype,
                    })
                );
                logoUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
            } catch (uploadErr: any) {
                console.error(`❌ Depot logo upload failed: ${uploadErr.message}`);
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const depot = await prisma.depot.create({
            data: {
                name: depotName,
                city: depotCity || null,
                address: depotAddress || null,
                phone: depotPhone || null,
                ...(logoUrl && { logoUrl }),
                ...subFields,
                users: {
                    create: {
                        name: ownerName,
                        phone: ownerPhone,
                        password: hashedPassword,
                        role: "OWNER",
                    },
                },
            },
            include: {
                users: {
                    where: { role: "OWNER" },
                    select: { id: true, name: true, phone: true, role: true },
                },
            },
        });

        return res.status(201).json({
            message: "Depot created successfully",
            user: depot.users[0],
            depot: {
                id: depot.id,
                name: depot.name,
                city: depot.city,
                logoUrl: depot.logoUrl,
                subscriptionStatus: depot.subscriptionStatus,
                trialEndsAt: depot.trialEndsAt,
                subscriptionEndsAt: depot.subscriptionEndsAt,
            },
        });
    } catch (error) {
        console.error("createDepot error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── CHANGE PASSWORD (authenticated) ─────────────────────────────
export const changePassword = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Both passwords required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Minimum 6 characters' });
        }

        const existingUser = await prisma.user.findUnique({
            where: { id: user.userId },
        });
        if (!existingUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isValid = await bcrypt.compare(currentPassword, existingUser.password);
        if (!isValid) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: user.userId },
            data: { password: hashed, refreshToken: null },
        });

        return res.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error' });
    }
};