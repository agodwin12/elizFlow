import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { evaluateSubscription } from "../lib/subscription";

/**
 * Defence-in-depth guard: blocks depot users from performing actions when their
 * depot's subscription is inactive. SUPER_ADMIN (no depot) always passes.
 *
 * A tiny in-process cache (30s TTL) avoids a DB hit on every request while still
 * reflecting a block/unblock within half a minute.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { decisionBlocked: boolean; message: string; reason: string | null; at: number }>();

export const requireActiveSubscription = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ message: "No token provided" });

        // Super admin operates the platform itself – never gated.
        if (user.role === "SUPER_ADMIN" || !user.depotId) return next();

        const cached = cache.get(user.depotId);
        const now = Date.now();
        if (cached && now - cached.at < CACHE_TTL_MS) {
            if (cached.decisionBlocked) {
                return res.status(403).json({
                    message: cached.message,
                    code: "SUBSCRIPTION_REQUIRED",
                    reason: cached.reason,
                });
            }
            return next();
        }

        const depot = await prisma.depot.findUnique({
            where: { id: user.depotId },
            select: {
                isActive: true,
                subscriptionStatus: true,
                subscriptionEndsAt: true,
                trialEndsAt: true,
                gracePeriodDays: true,
                blockedReason: true,
            },
        });

        if (!depot) return res.status(403).json({ message: "Depot not found" });

        const decision = evaluateSubscription(depot);
        cache.set(user.depotId, {
            decisionBlocked: decision.blocked,
            message: decision.message,
            reason: decision.reason,
            at: now,
        });

        if (decision.blocked) {
            return res.status(403).json({
                message: decision.message,
                code: "SUBSCRIPTION_REQUIRED",
                reason: decision.reason,
            });
        }

        next();
    } catch (err: any) {
        // Fail open on unexpected errors so a transient DB hiccup does not lock
        // everyone out; the login-time check is the primary gate.
        console.error("[subscription] guard error:", err?.message);
        next();
    }
};

/** Clear a depot's cached decision (call right after block/unblock). */
export function invalidateSubscriptionCache(depotId: string) {
    cache.delete(depotId);
}
