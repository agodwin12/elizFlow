import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { money } from "../lib/units";
import { getPagination, pageMeta } from "../lib/pagination";

// ─── CREATE EXPENSE ─────────────────────────────────────────────────
export const createExpense = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { category, amount, description, paymentType } = req.body;
    const amt = Number(amount);
    if (!category) throw ApiError.badRequest("Category is required");
    if (!Number.isFinite(amt) || amt <= 0) throw ApiError.badRequest("A valid amount is required");

    const expense = await prisma.expense.create({
        data: {
            depot: { connect: { id: user.depotId! } },
            user: { connect: { id: user.userId } },
            category: String(category).toUpperCase(),
            amount: amt,
            description: description || null,
            paymentType: paymentType || "CASH",
        },
    });
    return res.status(201).json({ message: "Expense recorded", expense });
});

// ─── LIST EXPENSES (paginated + summary) ────────────────────────────
export const getExpenses = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { from, to, category } = req.query;
    const pg = getPagination(req);

    const where: any = {
        depotId: user.depotId!,
        ...(category ? { category: String(category).toUpperCase() } : {}),
        ...(from && to
            ? { createdAt: { gte: new Date(from as string), lte: new Date(to as string) } }
            : {}),
    };

    const [expenses, total, agg, byCat] = await Promise.all([
        prisma.expense.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: { user: { select: { id: true, name: true } } },
        }),
        prisma.expense.count({ where }),
        prisma.expense.aggregate({ where, _sum: { amount: true } }),
        prisma.expense.groupBy({ by: ["category"], where, _sum: { amount: true } }),
    ]);

    return res.status(200).json({
        expenses,
        totalExpenses: money(agg._sum.amount || 0),
        byCategory: byCat.map((c) => ({ category: c.category, total: money(c._sum.amount || 0) })),
        pagination: pageMeta(total, pg),
    });
});

// ─── DELETE EXPENSE ─────────────────────────────────────────────────
export const deleteExpense = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();
    const existing = await prisma.expense.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
    });
    if (!existing) throw ApiError.notFound("Expense not found");
    await prisma.expense.delete({ where: { id: req.params.id } });
    return res.status(200).json({ message: "Expense deleted" });
});
