import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { sendToMultipleTokens } from "../lib/notification";

const CASHIER_CANCEL_WINDOW_MINUTES = 15;

// ─── CANCEL A SALE ────────────────────────────────────────────────
export const cancelSale = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;
        const { reason } = req.body;

        if (!reason || reason.trim().length === 0) {
            return res.status(400).json({
                message: "Cancellation reason is required",
            });
        }

        // ── Fetch the sale ────────────────────────────────────────
        const sale = await prisma.sale.findFirst({
            where: { id, depotId: user.depotId! },
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true } },
            },
        });

        if (!sale) {
            return res.status(404).json({ message: "Sale not found" });
        }

        // ── Check if already cancelled ────────────────────────────
        if (sale.status === "CANCELLED") {
            return res.status(400).json({
                message: "This sale is already cancelled",
            });
        }

        // ── Check permissions ─────────────────────────────────────
        const isOwnerOrAdmin = ["OWNER", "ADMIN"].includes(user.role);
        const isCashier = user.role === "CASHIER";
        const isOwnSale = sale.soldById === user.userId;

        if (!isOwnerOrAdmin && !isCashier) {
            return res.status(403).json({
                message: "You don't have permission to cancel sales",
            });
        }

        // ── Cashier time window check ─────────────────────────────
        if (isCashier) {
            if (!isOwnSale) {
                return res.status(403).json({
                    message: "You can only cancel your own sales",
                });
            }

            const saleAge =
                (Date.now() - new Date(sale.createdAt).getTime()) /
                (1000 * 60);

            if (saleAge > CASHIER_CANCEL_WINDOW_MINUTES) {
                return res.status(403).json({
                    message: `Cancellation window expired. Cashiers can only cancel within ${CASHIER_CANCEL_WINDOW_MINUTES} minutes. Please ask the owner to cancel.`,
                    minutesAgo: Math.floor(saleAge),
                    windowMinutes: CASHIER_CANCEL_WINDOW_MINUTES,
                });
            }
        }

        // ── Process cancellation in transaction ───────────────────
        const cancelled = await prisma.$transaction(async (tx) => {
            // Update sale status
            const updatedSale = await tx.sale.update({
                where: { id },
                data: {
                    status: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledById: user.userId,
                    cancellationReason: reason.trim(),
                },
                include: {
                    items: { include: { product: true } },
                    customer: true,
                    soldBy: { select: { id: true, name: true, role: true } },
                },
            });

            // ── Restore stock for each item (in BASE units) ───────
            // Only sales that actually moved stock get it back. HELD carts
            // never deducted stock, so skip them.
            if (sale.status !== "HELD") {
                for (const item of sale.items) {
                    const restoreQty = item.baseQuantity || item.quantity;
                    const updated = await tx.product.update({
                        where: { id: item.productId },
                        data: { stock: { increment: restoreQty } },
                        select: { stock: true },
                    });
                    await tx.stockMovement.create({
                        data: {
                            product: { connect: { id: item.productId } },
                            depot: { connect: { id: user.depotId! } },
                            user: { connect: { id: user.userId } },
                            type: "SALE_RETURN",
                            quantity: restoreQty,
                            previousStock: updated.stock - restoreQty,
                            newStock: updated.stock,
                            note: "Stock restored on sale cancellation",
                        },
                    });
                }
            }

            // ── Reverse customer debt if credit sale ──────────────
            if (sale.amountDue > 0 && sale.customerId) {
                const customer = await tx.customer.findUnique({
                    where: { id: sale.customerId },
                });

                if (customer) {
                    const newDebt = Math.max(
                        0,
                        customer.totalDebt - sale.amountDue
                    );
                    await tx.customer.update({
                        where: { id: sale.customerId },
                        data: { totalDebt: newDebt },
                    });
                }
            }

            // ── Delete related payments ───────────────────────────
            await tx.payment.deleteMany({
                where: { saleId: id },
            });

            return updatedSale;
        });

        // ── Notify owner/admin ────────────────────────────────────
        try {
            const owners = await prisma.user.findMany({
                where: {
                    depotId: user.depotId!,
                    role: { in: ["OWNER", "ADMIN"] },
                    fcmToken: { not: null },
                    isActive: true,
                    id: { not: user.userId },
                },
                select: { fcmToken: true },
            });

            const tokens = owners
                .map((o) => o.fcmToken!)
                .filter(Boolean);

            if (tokens.length > 0) {
                const cancellerName = await prisma.user.findUnique({
                    where: { id: user.userId },
                    select: { name: true },
                });

                const formattedAmount = new Intl.NumberFormat(
                    "fr-CM"
                ).format(sale.totalAmount);

                await sendToMultipleTokens(
                    tokens,
                    "🚫 Vente annulée",
                    `${cancellerName?.name} a annulé une vente de ${formattedAmount} FCFA. Raison: ${reason}`,
                    {
                        type: "SALE_CANCELLED",
                        saleId: sale.id,
                        amount: sale.totalAmount.toString(),
                        screen: "/sales-history",
                    }
                );
            }
        } catch (notifError) {
            console.error("Cancellation notification failed:", notifError);
        }

        return res.status(200).json({
            message: "Sale cancelled successfully",
            sale: cancelled,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET CANCELLED SALES ──────────────────────────────────────────
export const getCancelledSales = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const cancelledSales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                status: "CANCELLED",
            },
            orderBy: { cancelledAt: "desc" },
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true } },
                cancelledBy: { select: { id: true, name: true, role: true } },
            },
        });

        const totalCancelledAmount = cancelledSales.reduce(
            (sum, s) => sum + s.totalAmount,
            0
        );

        return res.status(200).json({
            cancelledSales,
            totalCancelled: cancelledSales.length,
            totalCancelledAmount,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── CHECK IF SALE CAN BE CANCELLED ──────────────────────────────
export const checkCancellability = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;

        const sale = await prisma.sale.findFirst({
            where: { id, depotId: user.depotId! },
            select: {
                id: true,
                status: true,
                createdAt: true,
                soldById: true,
                totalAmount: true,
            },
        });

        if (!sale) {
            return res.status(404).json({ message: "Sale not found" });
        }

        if (sale.status === "CANCELLED") {
            return res.status(200).json({
                canCancel: false,
                reason: "already_cancelled",
                message: "Cette vente est déjà annulée",
            });
        }

        const isOwnerOrAdmin = ["OWNER", "ADMIN"].includes(user.role);
        const isOwnSale = sale.soldById === user.userId;
        const saleAgeMinutes =
            (Date.now() - new Date(sale.createdAt).getTime()) / (1000 * 60);
        const withinWindow =
            saleAgeMinutes <= CASHIER_CANCEL_WINDOW_MINUTES;

        if (isOwnerOrAdmin) {
            return res.status(200).json({
                canCancel: true,
                reason: "owner_admin",
                message: "Vous pouvez annuler cette vente",
                minutesAgo: Math.floor(saleAgeMinutes),
            });
        }

        if (user.role === "CASHIER" && isOwnSale && withinWindow) {
            const minutesLeft = Math.floor(
                CASHIER_CANCEL_WINDOW_MINUTES - saleAgeMinutes
            );
            return res.status(200).json({
                canCancel: true,
                reason: "within_window",
                message: `Vous pouvez encore annuler cette vente (${minutesLeft} min restantes)`,
                minutesLeft,
                minutesAgo: Math.floor(saleAgeMinutes),
            });
        }

        if (user.role === "CASHIER" && isOwnSale && !withinWindow) {
            return res.status(200).json({
                canCancel: false,
                reason: "window_expired",
                message: `Délai d'annulation expiré (${Math.floor(saleAgeMinutes)} min). Contactez le propriétaire.`,
                minutesAgo: Math.floor(saleAgeMinutes),
            });
        }

        return res.status(200).json({
            canCancel: false,
            reason: "not_own_sale",
            message: "Vous ne pouvez annuler que vos propres ventes",
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};