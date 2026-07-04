import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { money } from "../lib/units";
import { getPagination, pageMeta } from "../lib/pagination";

// Compute a shift's live figures from its linked sales & payments.
async function computeShiftReport(shift: { id: string; depotId: string; openingFloat: number; openedAt: Date; closedAt: Date | null }) {
    const sales = await prisma.sale.findMany({
        where: { shiftId: shift.id, status: { in: ["COMPLETED", "OPEN", "PARTIALLY_REFUNDED", "REFUNDED"] } },
        select: { totalAmount: true, totalProfit: true, amountPaid: true, amountDue: true },
    });
    const payments = await prisma.payment.findMany({
        where: { sale: { shiftId: shift.id } },
        select: { amount: true, paymentType: true },
    });

    const byMethod: Record<string, number> = {};
    for (const p of payments) {
        byMethod[p.paymentType] = money((byMethod[p.paymentType] || 0) + p.amount);
    }
    const cashCollected = money(byMethod["CASH"] || 0);
    const expectedCash = money(shift.openingFloat + cashCollected);

    return {
        salesCount: sales.length,
        totalRevenue: money(sales.reduce((s, x) => s + x.totalAmount, 0)),
        totalProfit: money(sales.reduce((s, x) => s + x.totalProfit, 0)),
        totalCollected: money(payments.reduce((s, x) => s + x.amount, 0)),
        totalCredit: money(sales.reduce((s, x) => s + x.amountDue, 0)),
        paymentsByMethod: byMethod,
        cashCollected,
        expectedCash,
    };
}

// ─── OPEN A SHIFT ───────────────────────────────────────────────────
export const openShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const { openingFloat, note } = req.body;

    const existing = await prisma.registerShift.findFirst({
        where: { depotId, userId: user.userId, status: "OPEN" },
    });
    if (existing) {
        throw ApiError.badRequest("You already have an open shift", "SHIFT_ALREADY_OPEN");
    }

    const shift = await prisma.registerShift.create({
        data: {
            depot: { connect: { id: depotId } },
            user: { connect: { id: user.userId } },
            openingFloat: Math.max(0, Number(openingFloat) || 0),
            openingNote: note || null,
        },
    });
    return res.status(201).json({ message: "Shift opened", shift });
});

// ─── GET CURRENT (OPEN) SHIFT + LIVE REPORT ─────────────────────────
export const getCurrentShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const shift = await prisma.registerShift.findFirst({
        where: { depotId: user.depotId!, userId: user.userId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
    });
    if (!shift) return res.status(200).json({ shift: null });
    const report = await computeShiftReport(shift);
    return res.status(200).json({ shift, report });
});

// ─── CLOSE A SHIFT (Z-report) ───────────────────────────────────────
export const closeShift = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const { closingCounted, note } = req.body;

    const shift = await prisma.registerShift.findFirst({
        where: { id, depotId: user.depotId! },
    });
    if (!shift) throw ApiError.notFound("Shift not found");
    if (shift.status === "CLOSED") throw ApiError.badRequest("Shift already closed");
    // Only the owner/admin or the shift's owner may close it.
    if (user.role !== "OWNER" && user.role !== "ADMIN" && shift.userId !== user.userId) {
        throw ApiError.forbidden("You can only close your own shift");
    }

    const report = await computeShiftReport(shift);
    const counted = closingCounted !== undefined ? Number(closingCounted) : null;
    const difference = counted !== null ? money(counted - report.expectedCash) : null;

    const updated = await prisma.registerShift.update({
        where: { id },
        data: {
            status: "CLOSED",
            closingCounted: counted,
            expectedCash: report.expectedCash,
            difference,
            closingNote: note || null,
            closedAt: new Date(),
        },
    });

    return res.status(200).json({ message: "Shift closed", shift: updated, report });
});

// ─── LIST SHIFTS ────────────────────────────────────────────────────
export const getShifts = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const pg = getPagination(req);
    const where: any = { depotId: user.depotId! };
    // Cashiers only see their own shifts.
    if (user.role === "CASHIER") where.userId = user.userId;

    const [shifts, total] = await Promise.all([
        prisma.registerShift.findMany({
            where,
            orderBy: { openedAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: { user: { select: { id: true, name: true, role: true } } },
        }),
        prisma.registerShift.count({ where }),
    ]);
    return res.status(200).json({ shifts, pagination: pageMeta(total, pg) });
});

// ─── GET A SHIFT REPORT ─────────────────────────────────────────────
export const getShiftReport = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const shift = await prisma.registerShift.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
        include: { user: { select: { id: true, name: true, role: true } } },
    });
    if (!shift) throw ApiError.notFound("Shift not found");
    const report = await computeShiftReport(shift);
    return res.status(200).json({ shift, report });
});
