import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";
import { money } from "../lib/units";
import { getPagination, pageMeta } from "../lib/pagination";
import { audit } from "../lib/audit";

interface ReturnItemInput {
    productId: string;
    unitType?: string;
    quantity: number;
}

const key = (productId: string, unitType: string) => `${productId}::${unitType}`;

// ─── CREATE A RETURN / REFUND (supports partial returns) ────────────
export const createReturn = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const saleId = req.params.saleId;
    const { items, reason, refundMethod, restock: restockRaw } = req.body;
    const restock = restockRaw === undefined ? true : !!restockRaw;

    if (!Array.isArray(items) || items.length === 0) {
        throw ApiError.badRequest("A return must include at least one item");
    }

    const sale = await prisma.sale.findFirst({
        where: { id: saleId, depotId },
        include: { items: true, returns: true },
    });
    if (!sale) throw ApiError.notFound("Sale not found");
    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(sale.status)) {
        throw ApiError.badRequest(
            "Only a completed sale can be returned",
            "NOT_RETURNABLE"
        );
    }

    // How much of each (product, unitType) line was sold.
    const soldMap = new Map<string, { qty: number; baseQty: number; unitPrice: number; costPrice: number }>();
    for (const it of sale.items) {
        const k = key(it.productId, it.unitType);
        const prev = soldMap.get(k);
        const basePer = it.quantity > 0 ? it.baseQuantity / it.quantity : 1;
        soldMap.set(k, {
            qty: (prev?.qty || 0) + it.quantity,
            baseQty: (prev?.baseQty || 0) + it.baseQuantity,
            unitPrice: it.unitPrice,
            costPrice: it.costPrice,
        });
    }

    // How much was already returned per line.
    const returnedMap = new Map<string, number>();
    for (const r of sale.returns) {
        const rItems = (r.items as any[]) || [];
        for (const ri of rItems) {
            const k = key(ri.productId, ri.unitType || "PACKAGE");
            returnedMap.set(k, (returnedMap.get(k) || 0) + (ri.quantity || 0));
        }
    }

    let totalRefund = 0;
    const snapshot: any[] = [];
    const restockOps: { productId: string; baseQty: number }[] = [];

    for (const raw of items as ReturnItemInput[]) {
        const unitType = raw.unitType || "PACKAGE";
        const k = key(raw.productId, unitType);
        const sold = soldMap.get(k);
        if (!sold) {
            throw ApiError.badRequest(
                `Item not part of this sale: ${raw.productId} (${unitType})`,
                "ITEM_NOT_IN_SALE"
            );
        }
        const qty = Number(raw.quantity);
        if (!Number.isInteger(qty) || qty <= 0) {
            throw ApiError.badRequest("Return quantity must be a positive whole number");
        }
        const alreadyReturned = returnedMap.get(k) || 0;
        if (alreadyReturned + qty > sold.qty) {
            throw ApiError.badRequest(
                `Cannot return ${qty}; only ${sold.qty - alreadyReturned} remaining for that item`,
                "RETURN_EXCEEDS_SOLD"
            );
        }
        const basePer = sold.qty > 0 ? sold.baseQty / sold.qty : 1;
        const baseQty = Math.round(basePer * qty);
        const lineRefund = money(sold.unitPrice * qty);
        totalRefund = money(totalRefund + lineRefund);

        snapshot.push({
            productId: raw.productId,
            unitType,
            quantity: qty,
            baseQuantity: baseQty,
            unitPrice: sold.unitPrice,
            refund: lineRefund,
        });
        restockOps.push({ productId: raw.productId, baseQty });
    }

    const method = (refundMethod || "CASH").toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
        const saleReturn = await tx.saleReturn.create({
            data: {
                sale: { connect: { id: saleId } },
                depot: { connect: { id: depotId } },
                user: { connect: { id: user.userId } },
                items: snapshot,
                totalRefund,
                restock,
                refundMethod: method,
                reason: reason || null,
            },
        });

        if (restock) {
            for (const op of restockOps) {
                const updated = await tx.product.update({
                    where: { id: op.productId },
                    data: { stock: { increment: op.baseQty } },
                    select: { stock: true },
                });
                await tx.stockMovement.create({
                    data: {
                        product: { connect: { id: op.productId } },
                        depot: { connect: { id: depotId } },
                        user: { connect: { id: user.userId } },
                        type: "SALE_RETURN",
                        quantity: op.baseQty,
                        previousStock: updated.stock - op.baseQty,
                        newStock: updated.stock,
                        note: `Return on sale ${sale.receiptNumber || saleId}`,
                    },
                });
            }
        }

        // Refund handling.
        if (method === "CREDIT" && sale.customerId) {
            // Reduce the customer's debt instead of paying cash out.
            const customer = await tx.customer.findUnique({ where: { id: sale.customerId } });
            if (customer) {
                const reduce = Math.min(totalRefund, customer.totalDebt);
                if (reduce > 0) {
                    await tx.customer.update({
                        where: { id: sale.customerId },
                        data: { totalDebt: { decrement: reduce } },
                    });
                }
            }
        } else {
            // Cash/other refund: record money leaving the till (negative payment).
            await tx.payment.create({
                data: {
                    depot: { connect: { id: depotId } },
                    ...(sale.customerId ? { customer: { connect: { id: sale.customerId } } } : {}),
                    sale: { connect: { id: saleId } },
                    recordedBy: { connect: { id: user.userId } },
                    amount: -totalRefund,
                    paymentType: "REFUND",
                    note: reason || "Refund",
                },
            });
        }

        const newRefunded = money(sale.amountRefunded + totalRefund);
        const fullyRefunded = newRefunded >= sale.totalAmount - 0.001;
        const updatedSale = await tx.sale.update({
            where: { id: saleId },
            data: {
                amountRefunded: newRefunded,
                status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
            },
            include: { items: true, returns: true, customer: true },
        });

        return { saleReturn, updatedSale };
    });

    await audit({
        depotId,
        userId: user.userId,
        action: "SALE_RETURNED",
        entity: "Sale",
        entityId: saleId,
        meta: { totalRefund, method, items: snapshot.length },
    });

    return res.status(201).json({
        message: "Return processed",
        return: result.saleReturn,
        sale: result.updatedSale,
    });
});

// ─── LIST RETURNS ───────────────────────────────────────────────────
export const getReturns = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { from, to } = req.query;
    const pg = getPagination(req);

    const where: any = {
        depotId: user.depotId!,
        ...(from && to
            ? { createdAt: { gte: new Date(from as string), lte: new Date(to as string) } }
            : {}),
    };

    const [returns, total, agg] = await Promise.all([
        prisma.saleReturn.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: {
                user: { select: { id: true, name: true } },
                sale: { select: { id: true, receiptNumber: true, totalAmount: true } },
            },
        }),
        prisma.saleReturn.count({ where }),
        prisma.saleReturn.aggregate({ where, _sum: { totalRefund: true } }),
    ]);

    return res.status(200).json({
        returns,
        totalRefunded: agg._sum.totalRefund || 0,
        pagination: pageMeta(total, pg),
    });
});
