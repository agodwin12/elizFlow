import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { getPagination, pageMeta } from "../lib/pagination";
import { describeStock } from "../lib/units";

// Convert an incoming quantity into BASE units. stockUnit: PACKAGE (default) | BASE
function toBase(quantity: any, packSize: number, stockUnit?: string): number {
    const q = Number(quantity);
    if (!Number.isFinite(q)) return NaN;
    const unit = (stockUnit || "PACKAGE").toUpperCase();
    if (unit === "BASE" || unit === "UNIT") return Math.round(q);
    return Math.round(q * (packSize > 0 ? packSize : 1));
}

function requireOwner(role: string) {
    if (role !== "OWNER" && role !== "ADMIN") {
        throw ApiError.forbidden("Only the owner or admin can modify stock");
    }
}

async function loadProduct(id: string, depotId: string) {
    const product = await prisma.product.findFirst({ where: { id, depotId } });
    if (!product) throw ApiError.notFound("Product not found");
    return product;
}

// Shared writer for additive/subtractive movements.
async function applyMovement(
    user: { userId: string; depotId: string | null },
    productId: string,
    deltaBase: number,
    type: string,
    note: string | null,
    supplierId?: string | null
) {
    return prisma.$transaction(async (tx) => {
        const product = await tx.product.findFirst({
            where: { id: productId, depotId: user.depotId! },
        });
        if (!product) throw ApiError.notFound("Product not found");
        const newStock = product.stock + deltaBase;
        if (newStock < 0) {
            throw ApiError.badRequest(
                `Cannot remove more than available. Current: ${product.stock} ${product.baseUnit}`,
                "INSUFFICIENT_STOCK"
            );
        }
        const updated = await tx.product.update({
            where: { id: productId },
            data: { stock: newStock },
        });
        const movement = await tx.stockMovement.create({
            data: {
                product: { connect: { id: productId } },
                depot: { connect: { id: user.depotId! } },
                user: { connect: { id: user.userId } },
                type,
                quantity: deltaBase,
                previousStock: product.stock,
                newStock,
                note,
                ...(supplierId ? { supplier: { connect: { id: supplierId } } } : {}),
            },
        });
        return { updated, movement };
    });
}

// ─── RESTOCK (add stock from supplier) ───────────────────────────
export const restockProduct = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    requireOwner(user.role);
    const { productId, quantity, note, stockUnit, supplierId } = req.body;
    if (!productId) throw ApiError.badRequest("Product ID is required");

    const product = await loadProduct(productId, user.depotId!);
    const base = toBase(quantity, product.packSize, stockUnit);
    if (!Number.isFinite(base) || base <= 0) {
        throw ApiError.badRequest("A valid quantity is required");
    }

    const result = await applyMovement(user, productId, base, "RESTOCK", note || null, supplierId);
    return res.status(200).json({
        message: "Stock restocked successfully",
        product: result.updated,
        movement: result.movement,
    });
});

// ─── LOG DAMAGE ───────────────────────────────────────────────────
export const logDamage = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    requireOwner(user.role);
    const { productId, quantity, note, stockUnit } = req.body;
    if (!productId) throw ApiError.badRequest("Product ID is required");

    const product = await loadProduct(productId, user.depotId!);
    const base = toBase(quantity, product.packSize, stockUnit);
    if (!Number.isFinite(base) || base <= 0) {
        throw ApiError.badRequest("A valid quantity is required");
    }

    const result = await applyMovement(user, productId, -base, "DAMAGE", note || null);
    return res.status(200).json({
        message: "Damage logged successfully",
        product: result.updated,
        movement: result.movement,
    });
});

// ─── RETURN TO SUPPLIER ───────────────────────────────────────────
export const returnCrates = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    requireOwner(user.role);
    const { productId, quantity, note, stockUnit, supplierId } = req.body;
    if (!productId) throw ApiError.badRequest("Product ID is required");

    const product = await loadProduct(productId, user.depotId!);
    const base = toBase(quantity, product.packSize, stockUnit);
    if (!Number.isFinite(base) || base <= 0) {
        throw ApiError.badRequest("A valid quantity is required");
    }

    const result = await applyMovement(user, productId, base, "RETURN", note || null, supplierId);
    return res.status(200).json({
        message: "Crates returned successfully",
        product: result.updated,
        movement: result.movement,
    });
});

// ─── MANUAL CORRECTION (absolute new stock) ───────────────────────
export const correctStock = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    requireOwner(user.role);
    const { productId, newStock, note, stockUnit } = req.body;
    if (!productId || newStock === undefined) {
        throw ApiError.badRequest("Product ID and new stock are required");
    }

    const product = await loadProduct(productId, user.depotId!);
    const corrected = toBase(newStock, product.packSize, stockUnit);
    if (!Number.isFinite(corrected) || corrected < 0) {
        throw ApiError.badRequest("A valid new stock is required");
    }

    const difference = corrected - product.stock;
    const result = await applyMovement(
        user,
        productId,
        difference,
        "CORRECTION",
        note || "Manual stock correction"
    );
    return res.status(200).json({
        message: "Stock corrected successfully",
        product: result.updated,
        movement: result.movement,
    });
});

// ─── GET STOCK MOVEMENTS (audit trail, paginated) ────────────────
export const getStockMovements = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (user.role !== "OWNER" && user.role !== "ADMIN") {
        throw ApiError.forbidden("Only the owner can view stock movements");
    }
    const { productId, type, from, to } = req.query;
    const pg = getPagination(req);

    const where: any = {
        depotId: user.depotId!,
        ...(productId ? { productId: productId as string } : {}),
        ...(type ? { type: type as string } : {}),
        ...(from && to
            ? { createdAt: { gte: new Date(from as string), lte: new Date(to as string) } }
            : {}),
    };

    const [movements, total] = await Promise.all([
        prisma.stockMovement.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: {
                product: { select: { id: true, name: true, unit: true, baseUnit: true, imageUrl: true } },
                user: { select: { id: true, name: true, role: true } },
                supplier: { select: { id: true, name: true } },
            },
        }),
        prisma.stockMovement.count({ where }),
    ]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthMovements = await prisma.stockMovement.findMany({
        where: { depotId: user.depotId!, createdAt: { gte: monthStart } },
        select: { type: true, quantity: true },
    });
    const stats = {
        restocked: monthMovements.filter((m) => m.type === "RESTOCK").reduce((s, m) => s + m.quantity, 0),
        damaged: Math.abs(monthMovements.filter((m) => m.type === "DAMAGE").reduce((s, m) => s + m.quantity, 0)),
        returned: monthMovements.filter((m) => m.type === "RETURN").reduce((s, m) => s + m.quantity, 0),
    };

    return res.status(200).json({ movements, stats, pagination: pageMeta(total, pg) });
});

// ─── GET LOW STOCK ALERTS ─────────────────────────────────────────
export const getLowStockAlerts = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const lowStockProducts = await prisma.product.findMany({
        where: {
            depotId: user.depotId!,
            isActive: true,
            stock: { lte: prisma.product.fields.lowStockThreshold },
        },
        orderBy: { stock: "asc" },
    });
    const products = lowStockProducts.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        imageUrl: p.imageUrl,
        stock: p.stock,
        lowStockThreshold: p.lowStockThreshold,
        unit: p.unit,
        baseUnit: p.baseUnit,
        packageUnit: p.packageUnit,
        packSize: p.packSize,
        stockDescription: describeStock(p.stock, p.packSize, p.packageUnit, p.baseUnit),
    }));
    return res.status(200).json({ totalAlerts: products.length, products });
});
