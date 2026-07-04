import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { audit } from "../lib/audit";
import { evaluateSubscription } from "../lib/subscription";
import { invalidateSubscriptionCache } from "../middlewares/subscription.middleware";
import { getPagination, pageMeta } from "../lib/pagination";
import { addMonths } from "../lib/dates";

function requireSuperAdmin(req: Request) {
    if (req.user?.role !== "SUPER_ADMIN") {
        throw ApiError.forbidden("Super Admin access required");
    }
}

async function getDepotOr404(id: string) {
    const depot = await prisma.depot.findUnique({ where: { id } });
    if (!depot) throw ApiError.notFound("Depot not found");
    return depot;
}

// ─── BLOCK A DEPOT (e.g. non-payment) ───────────────────────────────
export const blockDepot = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const { reason } = req.body;
    await getDepotOr404(id);

    const updated = await prisma.depot.update({
        where: { id },
        data: {
            subscriptionStatus: "BLOCKED",
            blockedReason: reason || "Abonnement non payé",
            blockedAt: new Date(),
        },
    });
    invalidateSubscriptionCache(id);
    await audit({
        depotId: id,
        userId: req.user?.userId,
        action: "DEPOT_BLOCKED",
        entity: "Depot",
        entityId: id,
        meta: { reason: reason || "Abonnement non payé" },
    });

    return res.status(200).json({ message: "Depot blocked", depot: updated });
});

// ─── UNBLOCK A DEPOT ────────────────────────────────────────────────
export const unblockDepot = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const depot = await getDepotOr404(id);

    // Restore to ACTIVE if a paid period is still valid, otherwise TRIAL.
    const stillValid =
        depot.subscriptionEndsAt && depot.subscriptionEndsAt > new Date();
    const updated = await prisma.depot.update({
        where: { id },
        data: {
            subscriptionStatus: stillValid ? "ACTIVE" : "TRIAL",
            blockedReason: null,
            blockedAt: null,
            isActive: true,
        },
    });
    invalidateSubscriptionCache(id);
    await audit({
        depotId: id,
        userId: req.user?.userId,
        action: "DEPOT_UNBLOCKED",
        entity: "Depot",
        entityId: id,
    });

    return res.status(200).json({ message: "Depot unblocked", depot: updated });
});

// ─── UPDATE SUBSCRIPTION (plan / status / end date) ─────────────────
export const updateSubscription = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const { plan, status, subscriptionEndsAt, trialEndsAt, gracePeriodDays } = req.body;
    await getDepotOr404(id);

    const allowed = ["TRIAL", "ACTIVE", "PAST_DUE", "BLOCKED", "EXPIRED"];
    if (status && !allowed.includes(status)) {
        throw ApiError.badRequest(`status must be one of ${allowed.join(", ")}`);
    }

    const data: any = {};
    if (plan !== undefined) data.subscriptionPlan = plan;
    if (status !== undefined) data.subscriptionStatus = status;
    if (subscriptionEndsAt !== undefined)
        data.subscriptionEndsAt = subscriptionEndsAt ? new Date(subscriptionEndsAt) : null;
    if (trialEndsAt !== undefined)
        data.trialEndsAt = trialEndsAt ? new Date(trialEndsAt) : null;
    if (gracePeriodDays !== undefined)
        data.gracePeriodDays = Math.max(0, Math.round(Number(gracePeriodDays)));

    const updated = await prisma.depot.update({ where: { id }, data });
    invalidateSubscriptionCache(id);
    await audit({
        depotId: id,
        userId: req.user?.userId,
        action: "SUBSCRIPTION_UPDATED",
        entity: "Depot",
        entityId: id,
        meta: data,
    });

    return res.status(200).json({ message: "Subscription updated", depot: updated });
});

// ─── EXTEND SUBSCRIPTION BY N MONTHS (default +1 month) ─────────────
// The simple "add a month" action: extends from the later of now / current end,
// re-activates and unblocks the depot. No payment amount required.
export const extendSubscription = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const depot = await getDepotOr404(id);

    const months = Math.max(1, Math.round(Number(req.body.months) || 1));
    const now = new Date();
    const base =
        depot.subscriptionEndsAt && depot.subscriptionEndsAt > now
            ? depot.subscriptionEndsAt
            : now;
    const newEnd = addMonths(base, months);

    const updated = await prisma.depot.update({
        where: { id },
        data: {
            subscriptionStatus: "ACTIVE",
            subscriptionEndsAt: newEnd,
            blockedReason: null,
            blockedAt: null,
            isActive: true,
        },
    });
    invalidateSubscriptionCache(id);
    await audit({
        depotId: id,
        userId: req.user?.userId,
        action: "SUBSCRIPTION_EXTENDED",
        entity: "Depot",
        entityId: id,
        meta: { months, newEnd },
    });

    return res.status(200).json({
        message: `Subscription extended by ${months} month(s)`,
        depot: updated,
    });
});

// ─── RECORD A SUBSCRIPTION PAYMENT (extends the period, sets ACTIVE) ─
export const recordSubscriptionPayment = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const { amount, plan, months, periodDays, periodEnd, method, reference, note } = req.body;

    const depot = await getDepotOr404(id);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        throw ApiError.badRequest("A valid payment amount is required");
    }

    // Determine the new period end (from the later of now / current end):
    //   - explicit `periodEnd` date, or
    //   - `months` calendar months (preferred), or
    //   - `periodDays` (defaults to 30).
    const now = new Date();
    const base =
        depot.subscriptionEndsAt && depot.subscriptionEndsAt > now
            ? depot.subscriptionEndsAt
            : now;
    let newEnd: Date;
    if (periodEnd) {
        newEnd = new Date(periodEnd);
    } else if (months !== undefined && months !== null && Number(months) > 0) {
        newEnd = addMonths(base, Math.round(Number(months)));
    } else {
        const days = Number.isFinite(Number(periodDays)) ? Number(periodDays) : 30;
        newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    }

    const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.subscriptionPayment.create({
            data: {
                depot: { connect: { id } },
                amount: amt,
                plan: plan || depot.subscriptionPlan || null,
                periodStart: now,
                periodEnd: newEnd,
                method: method || "MANUAL",
                reference: reference || null,
                note: note || null,
                ...(req.user?.userId ? { recordedBy: { connect: { id: req.user.userId } } } : {}),
            },
        });
        const updatedDepot = await tx.depot.update({
            where: { id },
            data: {
                subscriptionStatus: "ACTIVE",
                subscriptionEndsAt: newEnd,
                ...(plan ? { subscriptionPlan: plan } : {}),
                blockedReason: null,
                blockedAt: null,
                isActive: true,
            },
        });
        return { payment, updatedDepot };
    });

    invalidateSubscriptionCache(id);
    await audit({
        depotId: id,
        userId: req.user?.userId,
        action: "SUBSCRIPTION_PAYMENT_RECORDED",
        entity: "Depot",
        entityId: id,
        meta: { amount: amt, periodEnd: newEnd },
    });

    return res.status(201).json({
        message: "Subscription payment recorded",
        payment: result.payment,
        depot: result.updatedDepot,
    });
});

// ─── LIST A DEPOT'S SUBSCRIPTION PAYMENTS ───────────────────────────
export const getSubscriptionPayments = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const id = req.params.id;
    const pg = getPagination(req);
    const [payments, total] = await Promise.all([
        prisma.subscriptionPayment.findMany({
            where: { depotId: id },
            orderBy: { createdAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: { recordedBy: { select: { id: true, name: true } } },
        }),
        prisma.subscriptionPayment.count({ where: { depotId: id } }),
    ]);
    return res.status(200).json({ payments, pagination: pageMeta(total, pg) });
});

// ─── SUBSCRIPTION OVERVIEW (all depots + computed status) ───────────
export const getSubscriptionOverview = asyncHandler(async (req: Request, res: Response) => {
    requireSuperAdmin(req);
    const depots = await prisma.depot.findMany({
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            city: true,
            logoUrl: true,
            isActive: true,
            subscriptionStatus: true,
            subscriptionPlan: true,
            subscriptionEndsAt: true,
            trialEndsAt: true,
            gracePeriodDays: true,
            blockedReason: true,
            createdAt: true,
        },
    });

    const now = new Date();
    const enriched = depots.map((d) => {
        const decision = evaluateSubscription(d as any, now);
        return {
            ...d,
            effectiveStatus: decision.status,
            blocked: decision.blocked,
            pastDue: decision.pastDue,
            daysRemaining: d.subscriptionEndsAt
                ? Math.ceil((d.subscriptionEndsAt.getTime() - now.getTime()) / (24 * 3600 * 1000))
                : null,
        };
    });

    const counts = enriched.reduce(
        (acc, d) => {
            acc[d.effectiveStatus] = (acc[d.effectiveStatus] || 0) + 1;
            if (d.blocked) acc.blocked += 1;
            return acc;
        },
        { blocked: 0 } as Record<string, number>
    );

    return res.status(200).json({ depots: enriched, counts });
});
