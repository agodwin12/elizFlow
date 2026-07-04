import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { sendToMultipleTokens } from "../lib/notification";
import { ApiError, asyncHandler } from "../lib/http";
import { money } from "../lib/units";
import { getPagination, pageMeta } from "../lib/pagination";
import { toNonNegativeNumber, oneOf } from "../lib/validate";
import {
    buildSaleLines,
    decrementStockGuarded,
    nextReceiptNumber,
    findOpenShiftId,
    IncomingItem,
    BuiltLine,
} from "../services/sale.service";

const SALE_STATUSES = ["COMPLETED", "HELD", "OPEN"] as const;

// ── Normalise split-payment input into a clean array ────────────────
function normalizePayments(body: any): { amount: number; paymentType: string }[] {
    const out: { amount: number; paymentType: string }[] = [];
    if (Array.isArray(body.payments)) {
        for (const p of body.payments) {
            const amount = toNonNegativeNumber(p.amount, "payment amount");
            if (amount > 0) out.push({ amount, paymentType: p.paymentType || "CASH" });
        }
    } else if (body.amountPaid !== undefined && body.amountPaid !== null) {
        const amount = toNonNegativeNumber(body.amountPaid, "amountPaid");
        if (amount > 0) out.push({ amount, paymentType: body.paymentType || "CASH" });
    }
    return out;
}

function saleItemCreateData(lines: BuiltLine[]) {
    return lines.map((l) => ({
        productId: l.productId,
        unitType: l.unitType,
        quantity: l.quantity,
        baseQuantity: l.baseQuantity,
        unitPrice: l.unitPrice,
        costPrice: l.costPrice,
        discount: l.discount,
        profit: l.profit,
    }));
}

// ─── Fire notifications (new sale + low stock) — best effort ────────
async function notifyAfterSale(
    depotId: string,
    sellerId: string,
    saleId: string,
    totalAmount: number,
    isCredit: boolean,
    customerName: string | null,
    lines: BuiltLine[]
) {
    try {
        const owners = await prisma.user.findMany({
            where: {
                depotId,
                role: { in: ["OWNER", "ADMIN"] },
                fcmToken: { not: null },
                isActive: true,
            },
            select: { fcmToken: true },
        });
        const tokens = owners.map((o) => o.fcmToken!).filter(Boolean);
        if (tokens.length > 0) {
            const seller = await prisma.user.findUnique({
                where: { id: sellerId },
                select: { name: true },
            });
            const formatted = new Intl.NumberFormat("fr-CM").format(totalAmount);
            const summary = lines
                .map((l) => `${l.quantity}x ${l.productName}`)
                .join(", ");
            let body = `${seller?.name} a vendu ${summary} — ${formatted} FCFA`;
            if (isCredit && customerName) body += ` (Crédit: ${customerName})`;
            else if (isCredit) body += ` (Vente à crédit)`;
            await sendToMultipleTokens(tokens, "💰 Nouvelle vente", body, {
                type: "NEW_SALE",
                saleId,
                amount: totalAmount.toString(),
                sellerName: seller?.name || "",
                screen: "/sales-history",
            });
        }
    } catch (e) {
        console.error("Sale notification failed:", e);
    }

    // Low-stock alerts
    try {
        const ids = [...new Set(lines.map((l) => l.productId))];
        const updated = await prisma.product.findMany({
            where: { id: { in: ids }, depotId, isActive: true },
        });
        const alerts = updated.filter((p) => p.stock <= p.lowStockThreshold);
        if (alerts.length) {
            const owners = await prisma.user.findMany({
                where: {
                    depotId,
                    role: { in: ["OWNER", "ADMIN"] },
                    fcmToken: { not: null },
                    isActive: true,
                },
                select: { fcmToken: true },
            });
            const tokens = owners.map((o) => o.fcmToken!).filter(Boolean);
            for (const p of alerts) {
                if (!tokens.length) break;
                const out = p.stock === 0;
                await sendToMultipleTokens(
                    tokens,
                    out ? "🚨 Rupture de stock!" : "⚠️ Stock faible!",
                    out
                        ? `${p.name} est épuisé. Réapprovisionnez immédiatement.`
                        : `${p.name} — ${p.stock} ${p.baseUnit} restant(s). Seuil: ${p.lowStockThreshold}`,
                    {
                        type: "LOW_STOCK",
                        productId: p.id,
                        productName: p.name,
                        stock: p.stock.toString(),
                        screen: "/stock",
                    }
                );
            }
        }
    } catch (e) {
        console.error("Low stock notification failed:", e);
    }
}

// ─── CREATE SALE ────────────────────────────────────────────────────
// status: COMPLETED (default) | HELD (parked cart) | OPEN (running tab)
export const createSale = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const {
        customerId,
        items,
        note,
        discount: rawDiscount,
        tabLabel,
    } = req.body;

    const status = oneOf(req.body.status || "COMPLETED", SALE_STATUSES as any, "status");

    const built = await buildSaleLines(depotId, items as IncomingItem[]);
    const saleDiscount = rawDiscount ? toNonNegativeNumber(rawDiscount, "discount") : 0;
    const subtotal = built.subtotal;
    const totalAmount = money(Math.max(0, subtotal - saleDiscount));
    const totalCost = built.totalCost;
    const totalProfit = money(totalAmount - totalCost);

    const payments = normalizePayments(req.body);
    const amountPaid = money(payments.reduce((s, p) => s + p.amount, 0));

    // HELD carts never take money or move stock.
    if (status === "HELD" && amountPaid > 0) {
        throw ApiError.badRequest("A held sale cannot take payment yet", "HELD_NO_PAYMENT");
    }

    const amountDue = money(Math.max(0, totalAmount - amountPaid));

    // Credit validation only applies to a COMPLETED credit sale.
    if (status === "COMPLETED" && amountDue > 0) {
        if (!customerId) {
            throw ApiError.badRequest(
                "Customer required for credit sales",
                "CUSTOMER_REQUIRED"
            );
        }
        const customer = await prisma.customer.findFirst({
            where: { id: customerId, depotId },
        });
        if (!customer) throw ApiError.notFound("Customer not found");
        const newDebt = money(customer.totalDebt + amountDue);
        if (newDebt > customer.creditLimit) {
            throw ApiError.badRequest(
                `Credit limit exceeded. Limit: ${customer.creditLimit}, Current: ${customer.totalDebt}, Would become: ${newDebt}`,
                "CREDIT_LIMIT_EXCEEDED"
            );
        }
    }

    const shiftId =
        status === "COMPLETED" || status === "OPEN"
            ? await findOpenShiftId(depotId, user.userId)
            : null;

    const sale = await prisma.$transaction(async (tx) => {
        // Deduct stock for COMPLETED and OPEN (goods physically leave). HELD keeps stock.
        if (status === "COMPLETED" || status === "OPEN") {
            for (const line of built.lines) {
                const newStock = await decrementStockGuarded(
                    tx,
                    line.productId,
                    depotId,
                    line.baseQuantity,
                    line.productName
                );
                await tx.stockMovement.create({
                    data: {
                        product: { connect: { id: line.productId } },
                        depot: { connect: { id: depotId } },
                        user: { connect: { id: user.userId } },
                        type: "SALE",
                        quantity: -line.baseQuantity,
                        previousStock: newStock + line.baseQuantity,
                        newStock,
                        note: `Sale (${line.quantity} ${line.unitType})`,
                    },
                });
            }
        }

        const receiptNumber =
            status === "COMPLETED" ? await nextReceiptNumber(tx, depotId) : null;

        const newSale = await tx.sale.create({
            data: {
                receiptNumber,
                depot: { connect: { id: depotId } },
                soldBy: { connect: { id: user.userId } },
                ...(shiftId ? { shift: { connect: { id: shiftId } } } : {}),
                ...(customerId ? { customer: { connect: { id: customerId } } } : {}),
                subtotal,
                discount: saleDiscount,
                totalAmount,
                totalCost,
                totalProfit,
                amountPaid,
                amountDue,
                paymentType: payments[0]?.paymentType || "CASH",
                status,
                tabLabel: tabLabel || null,
                note: note || null,
                items: { create: saleItemCreateData(built.lines) },
            },
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true, role: true } },
            },
        });

        // Apply customer debt only for a COMPLETED credit sale.
        if (status === "COMPLETED" && amountDue > 0 && customerId) {
            await tx.customer.update({
                where: { id: customerId },
                data: { totalDebt: { increment: amountDue } },
            });
        }

        // Record payments.
        for (const p of payments) {
            await tx.payment.create({
                data: {
                    depot: { connect: { id: depotId } },
                    ...(customerId ? { customer: { connect: { id: customerId } } } : {}),
                    sale: { connect: { id: newSale.id } },
                    recordedBy: { connect: { id: user.userId } },
                    amount: p.amount,
                    paymentType: p.paymentType,
                },
            });
        }

        return newSale;
    });

    if (status === "COMPLETED" || status === "OPEN") {
        await notifyAfterSale(
            depotId,
            user.userId,
            sale.id,
            totalAmount,
            amountDue > 0,
            sale.customer?.name || null,
            built.lines
        );
    }

    return res.status(201).json({
        message:
            status === "HELD"
                ? "Sale held"
                : status === "OPEN"
                ? "Tab opened"
                : "Sale recorded",
        sale,
    });
});

// ─── CHECKOUT / FINALISE a HELD or OPEN sale ────────────────────────
export const checkoutSale = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const id = req.params.id;
    const { customerId } = req.body;

    const existing = await prisma.sale.findFirst({
        where: { id, depotId },
        include: { items: { include: { product: true } }, payments: true },
    });
    if (!existing) throw ApiError.notFound("Sale not found");
    if (!["HELD", "OPEN"].includes(existing.status)) {
        throw ApiError.badRequest(
            "Only held sales or open tabs can be checked out",
            "NOT_CHECKOUTABLE"
        );
    }

    const newPayments = normalizePayments(req.body);
    const alreadyPaid = existing.payments.reduce((s, p) => s + p.amount, 0);
    const newlyPaid = money(newPayments.reduce((s, p) => s + p.amount, 0));
    const amountPaid = money(alreadyPaid + newlyPaid);
    const amountDue = money(Math.max(0, existing.totalAmount - amountPaid));
    const effectiveCustomerId = customerId || existing.customerId;

    if (amountDue > 0) {
        if (!effectiveCustomerId) {
            throw ApiError.badRequest(
                "Customer required to leave a balance on credit",
                "CUSTOMER_REQUIRED"
            );
        }
        const customer = await prisma.customer.findFirst({
            where: { id: effectiveCustomerId, depotId },
        });
        if (!customer) throw ApiError.notFound("Customer not found");
        const newDebt = money(customer.totalDebt + amountDue);
        if (newDebt > customer.creditLimit) {
            throw ApiError.badRequest(
                `Credit limit exceeded. Limit: ${customer.creditLimit}, Current: ${customer.totalDebt}`,
                "CREDIT_LIMIT_EXCEEDED"
            );
        }
    }

    const shiftId = await findOpenShiftId(depotId, user.userId);

    const sale = await prisma.$transaction(async (tx) => {
        // A HELD cart hasn't moved stock yet — deduct now.
        if (existing.status === "HELD") {
            for (const item of existing.items) {
                const newStock = await decrementStockGuarded(
                    tx,
                    item.productId,
                    depotId,
                    item.baseQuantity || item.quantity,
                    item.product.name
                );
                await tx.stockMovement.create({
                    data: {
                        product: { connect: { id: item.productId } },
                        depot: { connect: { id: depotId } },
                        user: { connect: { id: user.userId } },
                        type: "SALE",
                        quantity: -(item.baseQuantity || item.quantity),
                        previousStock: newStock + (item.baseQuantity || item.quantity),
                        newStock,
                        note: "Sale (checkout of held cart)",
                    },
                });
            }
        }

        for (const p of newPayments) {
            await tx.payment.create({
                data: {
                    depot: { connect: { id: depotId } },
                    ...(effectiveCustomerId
                        ? { customer: { connect: { id: effectiveCustomerId } } }
                        : {}),
                    sale: { connect: { id } },
                    recordedBy: { connect: { id: user.userId } },
                    amount: p.amount,
                    paymentType: p.paymentType,
                },
            });
        }

        if (amountDue > 0 && effectiveCustomerId) {
            await tx.customer.update({
                where: { id: effectiveCustomerId },
                data: { totalDebt: { increment: amountDue } },
            });
        }

        const receiptNumber =
            existing.receiptNumber || (await nextReceiptNumber(tx, depotId));

        return tx.sale.update({
            where: { id },
            data: {
                status: "COMPLETED",
                receiptNumber,
                amountPaid,
                amountDue,
                ...(effectiveCustomerId
                    ? { customer: { connect: { id: effectiveCustomerId } } }
                    : {}),
                ...(shiftId ? { shift: { connect: { id: shiftId } } } : {}),
            },
            include: {
                items: { include: { product: true } },
                customer: true,
                payments: true,
                soldBy: { select: { id: true, name: true, role: true } },
            },
        });
    });

    return res.status(200).json({ message: "Sale completed", sale });
});

// ─── ADD ITEMS TO AN OPEN TAB ───────────────────────────────────────
export const addItemsToTab = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const id = req.params.id;

    const existing = await prisma.sale.findFirst({ where: { id, depotId } });
    if (!existing) throw ApiError.notFound("Sale not found");
    if (existing.status !== "OPEN") {
        throw ApiError.badRequest("Items can only be added to an open tab", "NOT_OPEN_TAB");
    }

    const built = await buildSaleLines(depotId, req.body.items as IncomingItem[]);

    const sale = await prisma.$transaction(async (tx) => {
        for (const line of built.lines) {
            const newStock = await decrementStockGuarded(
                tx,
                line.productId,
                depotId,
                line.baseQuantity,
                line.productName
            );
            await tx.stockMovement.create({
                data: {
                    product: { connect: { id: line.productId } },
                    depot: { connect: { id: depotId } },
                    user: { connect: { id: user.userId } },
                    type: "SALE",
                    quantity: -line.baseQuantity,
                    previousStock: newStock + line.baseQuantity,
                    newStock,
                    note: `Tab add (${line.quantity} ${line.unitType})`,
                },
            });
        }

        await tx.saleItem.createMany({
            data: saleItemCreateData(built.lines).map((d) => ({ ...d, saleId: id })),
        });

        const subtotal = money(existing.subtotal + built.subtotal);
        const totalAmount = money(Math.max(0, subtotal - existing.discount));
        const totalCost = money(existing.totalCost + built.totalCost);
        const totalProfit = money(totalAmount - totalCost);
        const amountDue = money(Math.max(0, totalAmount - existing.amountPaid));

        return tx.sale.update({
            where: { id },
            data: { subtotal, totalAmount, totalCost, totalProfit, amountDue },
            include: { items: { include: { product: true } }, customer: true },
        });
    });

    return res.status(200).json({ message: "Items added to tab", sale });
});

// ─── ADD A PAYMENT TO A SALE (settle a tab / partial pay) ────────────
export const addSalePayment = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const depotId = user.depotId!;
    const id = req.params.id;
    const payments = normalizePayments(req.body);
    if (!payments.length) throw ApiError.badRequest("A payment amount is required");

    const existing = await prisma.sale.findFirst({
        where: { id, depotId },
        include: { payments: true },
    });
    if (!existing) throw ApiError.notFound("Sale not found");
    if (existing.status === "CANCELLED") {
        throw ApiError.badRequest("Cannot pay a cancelled sale");
    }

    const addAmount = money(payments.reduce((s, p) => s + p.amount, 0));
    const alreadyPaid = existing.amountPaid;
    const amountPaid = money(alreadyPaid + addAmount);
    const amountDue = money(Math.max(0, existing.totalAmount - amountPaid));

    const sale = await prisma.$transaction(async (tx) => {
        for (const p of payments) {
            await tx.payment.create({
                data: {
                    depot: { connect: { id: depotId } },
                    ...(existing.customerId
                        ? { customer: { connect: { id: existing.customerId } } }
                        : {}),
                    sale: { connect: { id } },
                    recordedBy: { connect: { id: user.userId } },
                    amount: p.amount,
                    paymentType: p.paymentType,
                },
            });
        }

        // If this sale already contributed to a customer's debt, reduce it.
        if (existing.customerId && existing.status === "COMPLETED" && existing.amountDue > 0) {
            const reduce = Math.min(addAmount, existing.amountDue);
            if (reduce > 0) {
                await tx.customer.update({
                    where: { id: existing.customerId },
                    data: { totalDebt: { decrement: reduce } },
                });
            }
        }

        return tx.sale.update({
            where: { id },
            data: { amountPaid, amountDue },
            include: { payments: true, customer: true },
        });
    });

    return res.status(200).json({ message: "Payment added", sale });
});

// ─── LIST HELD SALES / OPEN TABS ────────────────────────────────────
export const getHeldSales = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const statusParam = (req.query.status as string) || "HELD";
    const status = ["HELD", "OPEN"].includes(statusParam) ? statusParam : "HELD";

    const sales = await prisma.sale.findMany({
        where: { depotId: user.depotId!, status },
        orderBy: { createdAt: "desc" },
        include: {
            items: { include: { product: true } },
            customer: true,
            soldBy: { select: { id: true, name: true } },
        },
    });
    return res.status(200).json({ sales, total: sales.length });
});

// ─── DELETE A HELD SALE (discard parked cart) ───────────────────────
export const deleteHeldSale = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const existing = await prisma.sale.findFirst({
        where: { id, depotId: user.depotId! },
    });
    if (!existing) throw ApiError.notFound("Sale not found");
    if (existing.status !== "HELD") {
        throw ApiError.badRequest("Only held sales can be discarded", "NOT_HELD");
    }
    await prisma.$transaction([
        prisma.saleItem.deleteMany({ where: { saleId: id } }),
        prisma.sale.delete({ where: { id } }),
    ]);
    return res.status(200).json({ message: "Held sale discarded" });
});

// ─── GET ALL SALES (paginated) ──────────────────────────────────────
export const getSales = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { from, to, customerId, showCancelled, status } = req.query;
    const pg = getPagination(req);

    const where: any = {
        depotId: user.depotId!,
        ...(status
            ? { status: status as string }
            : showCancelled === "true"
            ? {}
            : { status: "COMPLETED" }),
        ...(customerId ? { customerId: customerId as string } : {}),
        ...(from && to
            ? { createdAt: { gte: new Date(from as string), lte: new Date(to as string) } }
            : {}),
    };

    const [sales, total] = await Promise.all([
        prisma.sale.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: pg.skip,
            take: pg.take,
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true, role: true } },
                cancelledBy: { select: { id: true, name: true, role: true } },
            },
        }),
        prisma.sale.count({ where }),
    ]);

    return res.status(200).json({ sales, pagination: pageMeta(total, pg) });
});

// ─── GET SINGLE SALE ────────────────────────────────────────────────
export const getSale = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const sale = await prisma.sale.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
        include: {
            items: { include: { product: true } },
            customer: true,
            soldBy: { select: { id: true, name: true, role: true } },
            cancelledBy: { select: { id: true, name: true, role: true } },
            payments: true,
            returns: true,
        },
    });
    if (!sale) throw ApiError.notFound("Sale not found");
    return res.status(200).json({ sale });
});

// ─── GET SALES SUMMARY (dashboard) ──────────────────────────────────
export const getSalesSummary = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [todaySales, cancelledToday] = await Promise.all([
        prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                status: "COMPLETED",
                createdAt: { gte: today, lt: tomorrow },
            },
        }),
        prisma.sale.count({
            where: {
                depotId: user.depotId!,
                status: "CANCELLED",
                createdAt: { gte: today, lt: tomorrow },
            },
        }),
    ]);

    const sum = (f: (s: any) => number) => todaySales.reduce((a, s) => a + f(s), 0);

    return res.status(200).json({
        summary: {
            date: today,
            totalSales: todaySales.length,
            totalRevenue: money(sum((s) => s.totalAmount)),
            totalProfit: money(sum((s) => s.totalProfit)),
            totalCash: money(sum((s) => s.amountPaid)),
            totalCredit: money(sum((s) => s.amountDue)),
            cancelledToday,
        },
    });
});
