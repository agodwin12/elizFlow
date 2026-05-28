import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";

// ─── CREATE USER ──────────────────────────────────────────────────
export const createUser = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { name, phone, password, role } = req.body;

        console.log(`👤 createUser: name=${name}, role=${role}, hasFile=${!!req.file}`);

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        if (!["CASHIER", "DRIVER", "ADMIN"].includes(role)) {
            return res.status(400).json({
                message: "Invalid role. Allowed: CASHIER, DRIVER, ADMIN",
            });
        }

        if (!name || !phone || !password) {
            return res.status(400).json({ message: "Name, phone and password required" });
        }

        const existing = await prisma.user.findUnique({ where: { phone } });
        if (existing) {
            return res.status(400).json({ message: "Phone number already in use" });
        }

        // ── Upload image to R2 if provided ────────────────────────
        let imageUrl: string | undefined;
        if (req.file) {
            try {
                console.log(`📤 Uploading user image, size=${req.file.size}...`);
                const key = `users/${user.depotId}/${uuidv4()}-${req.file.originalname}`;
                await r2Client.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME!,
                        Key: key,
                        Body: req.file.buffer,
                        ContentType: req.file.mimetype,
                    })
                );
                imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
                console.log(`✅ User image uploaded: ${imageUrl}`);
            } catch (uploadErr: any) {
                console.error(`❌ User image upload failed (continuing without): ${uploadErr.message}`);
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = await prisma.user.create({
            data: {
                name,
                phone,
                password: hashedPassword,
                role,
                depotId: user.depotId!,
                ...(imageUrl && { imageUrl }),
            },
            select: {
                id: true,
                name: true,
                phone: true,
                role: true,
                depotId: true,
                imageUrl: true,
                createdAt: true,
            },
        });

        console.log(`✅ User created: ${newUser.id}`);
        return res.status(201).json({ message: "User created", user: newUser });
    } catch (error) {
        console.error("createUser error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET ALL USERS ────────────────────────────────────────────────
export const getUsers = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const users = await prisma.user.findMany({
            where: { depotId: user.depotId!, isActive: true },
            select: {
                id: true,
                name: true,
                phone: true,
                role: true,
                imageUrl: true,
                createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        });

        return res.status(200).json({ users });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SINGLE USER ──────────────────────────────────────────────
export const getUser = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const foundUser = await prisma.user.findFirst({
            where: { id, depotId: user.depotId! },
            select: {
                id: true,
                name: true,
                phone: true,
                role: true,
                imageUrl: true,
                createdAt: true,
                sales: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                    select: {
                        id: true,
                        totalAmount: true,
                        totalProfit: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!foundUser) {
            return res.status(404).json({ message: "User not found" });
        }

        return res.status(200).json({ user: foundUser });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── UPDATE USER ──────────────────────────────────────────────────
export const updateUser = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;
        const { name, phone, role } = req.body;

        console.log(`👤 updateUser: id=${id}, hasFile=${!!req.file}`);

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const existing = await prisma.user.findFirst({
            where: { id, depotId: user.depotId! },
        });
        if (!existing) {
            return res.status(404).json({ message: "User not found" });
        }

        if (role === "OWNER") {
            return res.status(400).json({ message: "Cannot assign OWNER role" });
        }

        // ── Upload new image if provided ──────────────────────────
        let imageUrl = existing.imageUrl;
        if (req.file) {
            try {
                // Delete old image from R2
                if (existing.imageUrl) {
                    const oldKey = existing.imageUrl.replace(
                        `${process.env.R2_PUBLIC_URL}/`, ""
                    );
                    await r2Client.send(
                        new DeleteObjectCommand({
                            Bucket: process.env.R2_BUCKET_NAME!,
                            Key: oldKey,
                        })
                    ).catch((e) => console.warn("Old image delete failed:", e.message));
                }

                const key = `users/${user.depotId}/${uuidv4()}-${req.file.originalname}`;
                await r2Client.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME!,
                        Key: key,
                        Body: req.file.buffer,
                        ContentType: req.file.mimetype,
                    })
                );
                imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
                console.log(`✅ User image updated: ${imageUrl}`);
            } catch (uploadErr: any) {
                console.error(`❌ User image update failed: ${uploadErr.message}`);
                // Keep existing imageUrl
            }
        }

        const updated = await prisma.user.update({
            where: { id },
            data: {
                ...(name && { name }),
                ...(phone && { phone }),
                ...(role && { role }),
                imageUrl, // always write (handles both update and no-change)
            },
            select: {
                id: true,
                name: true,
                phone: true,
                role: true,
                imageUrl: true,
                createdAt: true,
            },
        });

        return res.status(200).json({ message: "User updated", user: updated });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── RESET PASSWORD ───────────────────────────────────────────────
export const resetPassword = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;
        const { newPassword } = req.body;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        const existing = await prisma.user.findFirst({
            where: { id, depotId: user.depotId! },
        });
        if (!existing) {
            return res.status(404).json({ message: "User not found" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id },
            data: { password: hashedPassword },
        });

        return res.status(200).json({ message: "Password reset successfully" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── DEACTIVATE USER ──────────────────────────────────────────────
export const deactivateUser = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        if (id === user.userId) {
            return res.status(400).json({ message: "Cannot deactivate yourself" });
        }

        const existing = await prisma.user.findFirst({
            where: { id, depotId: user.depotId! },
        });
        if (!existing) {
            return res.status(404).json({ message: "User not found" });
        }

        if (existing.role === "OWNER") {
            return res.status(400).json({ message: "Cannot deactivate the owner" });
        }

        await prisma.user.update({
            where: { id },
            data: { isActive: false },
        });

        return res.status(200).json({ message: "User deactivated" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── SAVE FCM TOKEN ───────────────────────────────────────────────
export const saveFcmToken = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { fcmToken } = req.body;

        if (!fcmToken) {
            return res.status(400).json({ message: "FCM token required" });
        }

        await prisma.user.update({
            where: { id: user.userId },
            data: { fcmToken },
        });

        return res.status(200).json({ message: "FCM token saved" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};