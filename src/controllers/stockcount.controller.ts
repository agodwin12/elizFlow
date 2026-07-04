import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { audit } from "../lib/audit";

// ─── CREATE A STOCK COUNT SESSION ───────────────────────────────────
// body.items: [{ productId, countedStock (base units) }]. Records a snapshot
// of current system stock + variance, but does NOT change stock until applied.
export const createStockCount = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();
    const { items, note } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        throw ApiError.badRequest("A stock count needs at least one item");
    }

    const productIds = items.map((i: any) => i.productId);
    const products = await prisma.product.findMany({
        where: { id: { in: productIds }, depotId },
        select: { id: true, stock: true, name: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const countItems = items.map((i: any) => {
        const p = byId.get(i.productId);
        if (!p) throw ApiError.badRequest(`Product not found: ${i.productId}`);
        const counted = Math.round(Number(i.countedStock));
        if (!Number.isFinite(counted) || counted < 0) {
            throw ApiError.badRequest(`Invalid counted stock for ${p.name}`);
        }
        return {
            productId: p.id,
            systemStock: p.stock,
            countedStock: counted,
            variance: counted - p.stock,
        };
    });

    const count = await prisma.stockCount.create({
        data: {
            depot: { connect: { id: depotId } },
            user: { connect: { id: user.userId } },
            note: note || null,
            items: { create: countItems },
        },
        include: { items: { include: { product: { select: { id: true, name: true, baseUnit: true } } } } },
    });

    return res.status(201).json({ message: "Stock count created", stockCount: count });
});

// ─── APPLY A STOCK COUNT (writes variances as CORRECTIONs) ──────────
export const applyStockCount = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();

    const count = await prisma.stockCount.findFirst({
        where: { id: req.params.id, depotId },
        include: { items: true },
    });
    if (!count) throw ApiError.notFound("Stock count not found");
    if (count.status !== "OPEN") throw ApiError.badRequest("Stock count already processed");

    const applied = await prisma.$transaction(async (tx) => {
        for (const item of count.items) {
            const product = await tx.product.findUnique({ where: { id: item.productId } });
            if (!product) continue;
            const diff = item.countedStock - product.stock;
            if (diff === 0) continue;
            await tx.product.update({
                where: { id: item.productId },
                data: { stock: item.countedStock },
            });
            await tx.stockMovement.create({
                data: {
                    product: { connect: { id: item.productId } },
                    depot: { connect: { id: depotId } },
                    user: { connect: { id: user.userId } },
                    type: "STOCK_COUNT",
                    quantity: diff,
                    previousStock: product.stock,
                    newStock: item.countedStock,
                    note: `Stock count ${count.id}`,
                },
            });
        }
        return tx.stockCount.update({
            where: { id: count.id },
            data: { status: "APPLIED", appliedAt: new Date() },
            include: { items: true },
        });
    });

    await audit({
        depotId,
        userId: user.userId,
        action: "STOCK_COUNT_APPLIED",
        entity: "StockCount",
        entityId: count.id,
        meta: { items: count.items.length },
    });

    return res.status(200).json({ message: "Stock count applied", stockCount: applied });
});

// ─── LIST / GET STOCK COUNTS ────────────────────────────────────────
export const getStockCounts = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const counts = await prisma.stockCount.findMany({
        where: { depotId: user.depotId! },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
            user: { select: { id: true, name: true } },
            _count: { select: { items: true } },
        },
    });
    return res.status(200).json({ stockCounts: counts });
});

export const getStockCount = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const count = await prisma.stockCount.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
        include: {
            items: { include: { product: { select: { id: true, name: true, baseUnit: true, packageUnit: true } } } },
            user: { select: { id: true, name: true } },
        },
    });
    if (!count) throw ApiError.notFound("Stock count not found");
    return res.status(200).json({ stockCount: count });
});
