import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/http";
import {
    resolveLinePricing,
    money,
    UnitType,
} from "../lib/units";
import { oneOf, toPositiveInt, toNonNegativeNumber } from "../lib/validate";

export interface IncomingItem {
    productId: string;
    unitType?: string; // PACKAGE | HALF | UNIT (default PACKAGE)
    quantity: number;
    discount?: number; // per-line discount amount
}

export interface BuiltLine {
    productId: string;
    productName: string;
    unitType: UnitType;
    quantity: number;
    baseQuantity: number;
    unitPrice: number;
    costPrice: number; // cost per unit item
    discount: number;
    lineTotal: number; // after line discount
    lineCost: number;
    profit: number;
}

export interface BuiltSale {
    lines: BuiltLine[];
    subtotal: number;
    totalCost: number;
}

const UNIT_TYPES: UnitType[] = ["PACKAGE", "HALF", "UNIT"];

/**
 * Validate incoming items against live product data and compute per-line
 * pricing/quantities in base units. Pure computation – no writes, no stock
 * mutation. Used by both create-sale and checkout flows.
 */
export async function buildSaleLines(
    depotId: string,
    items: IncomingItem[]
): Promise<BuiltSale> {
    if (!Array.isArray(items) || items.length === 0) {
        throw ApiError.badRequest("Sale must have at least one item");
    }

    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await prisma.product.findMany({
        where: { id: { in: productIds }, depotId, isActive: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    let totalCost = 0;
    const lines: BuiltLine[] = [];

    for (const item of items) {
        const product = byId.get(item.productId);
        if (!product) {
            throw ApiError.badRequest(
                `Product not found: ${item.productId}`,
                "PRODUCT_NOT_FOUND"
            );
        }

        const unitType = oneOf(
            item.unitType || "PACKAGE",
            UNIT_TYPES,
            "unitType"
        );
        const quantity = toPositiveInt(item.quantity, "quantity");
        const lineDiscount = item.discount
            ? toNonNegativeNumber(item.discount, "discount")
            : 0;

        const { unitPrice, unitCost, basePerItem } = resolveLinePricing(
            product as any,
            unitType
        );

        const baseQuantity = basePerItem * quantity;
        if (!Number.isInteger(baseQuantity)) {
            throw ApiError.badRequest(
                `${product.name}: quantity does not resolve to whole base units`,
                "BASE_QTY_INVALID"
            );
        }

        const gross = money(unitPrice * quantity);
        const lineTotal = money(Math.max(0, gross - lineDiscount));
        const lineCost = money(unitCost * quantity);
        const profit = money(lineTotal - lineCost);

        subtotal = money(subtotal + lineTotal);
        totalCost = money(totalCost + lineCost);

        lines.push({
            productId: product.id,
            productName: product.name,
            unitType,
            quantity,
            baseQuantity,
            unitPrice: money(unitPrice),
            costPrice: money(unitCost),
            discount: lineDiscount,
            lineTotal,
            lineCost,
            profit,
        });
    }

    return { lines, subtotal, totalCost };
}

/**
 * Atomically decrement stock for a line, guaranteeing no oversell even under
 * concurrent sales. Returns the new stock or throws if insufficient.
 */
export async function decrementStockGuarded(
    tx: any,
    productId: string,
    depotId: string,
    baseQuantity: number,
    productName: string
): Promise<number> {
    const result = await tx.product.updateMany({
        where: { id: productId, depotId, stock: { gte: baseQuantity } },
        data: { stock: { decrement: baseQuantity } },
    });
    if (result.count === 0) {
        // Either the product vanished or stock was insufficient.
        const current = await tx.product.findUnique({
            where: { id: productId },
            select: { stock: true, baseUnit: true },
        });
        throw ApiError.badRequest(
            `Insufficient stock for ${productName}. Available: ${current?.stock ?? 0} ${
                current?.baseUnit ?? "units"
            }`,
            "INSUFFICIENT_STOCK"
        );
    }
    const updated = await tx.product.findUnique({
        where: { id: productId },
        select: { stock: true },
    });
    return updated?.stock ?? 0;
}

/** Allocate the next per-depot receipt number inside a transaction. */
export async function nextReceiptNumber(tx: any, depotId: string): Promise<string> {
    const depot = await tx.depot.update({
        where: { id: depotId },
        data: { lastReceiptNumber: { increment: 1 } },
        select: { lastReceiptNumber: true },
    });
    return String(depot.lastReceiptNumber).padStart(6, "0");
}

/** Find the caller's currently open register shift, if any. */
export async function findOpenShiftId(
    depotId: string,
    userId: string
): Promise<string | null> {
    const shift = await prisma.registerShift.findFirst({
        where: { depotId, userId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
        select: { id: true },
    });
    return shift?.id ?? null;
}
