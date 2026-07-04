import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";

// ─── GET STRUCTURED RECEIPT FOR A SALE ──────────────────────────────
export const getReceipt = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const sale = await prisma.sale.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
        include: {
            items: { include: { product: { select: { name: true, baseUnit: true, packageUnit: true } } } },
            customer: { select: { id: true, name: true, phone: true } },
            soldBy: { select: { id: true, name: true } },
            payments: { select: { amount: true, paymentType: true, createdAt: true } },
            depot: {
                select: {
                    name: true,
                    address: true,
                    phone: true,
                    city: true,
                    logoUrl: true,
                    currency: true,
                },
            },
        },
    });
    if (!sale) throw ApiError.notFound("Sale not found");

    const unitLabel = (item: any) => {
        if (item.unitType === "PACKAGE") return item.product.packageUnit;
        if (item.unitType === "HALF") return `1/2 ${item.product.packageUnit}`;
        return item.product.baseUnit;
    };

    const receipt = {
        receiptNumber: sale.receiptNumber,
        date: sale.createdAt,
        status: sale.status,
        depot: sale.depot,
        cashier: sale.soldBy?.name,
        customer: sale.customer,
        items: sale.items.map((i) => ({
            name: i.product.name,
            unitType: i.unitType,
            unitLabel: unitLabel(i),
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discount,
            lineTotal: Math.max(0, i.unitPrice * i.quantity - i.discount),
        })),
        subtotal: sale.subtotal,
        discount: sale.discount,
        total: sale.totalAmount,
        amountPaid: sale.amountPaid,
        amountDue: sale.amountDue,
        amountRefunded: sale.amountRefunded,
        payments: sale.payments,
        currency: sale.depot?.currency || "FCFA",
    };

    return res.status(200).json({ receipt });
});
