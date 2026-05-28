import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { sendToMultipleTokens } from "../lib/notification";


// ─── CREATE SALE ──────────────────────────────────────────────────
export const createSale = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { customerId, items, paymentType, amountPaid, note } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: "Sale must have at least one item" });
        }

        // ── Fetch all products ────────────────────────────────────────
        const productIds = items.map((i: any) => i.productId);
        const products = await prisma.product.findMany({
            where: { id: { in: productIds }, depotId: user.depotId! },
        });

        if (products.length !== items.length) {
            return res.status(400).json({ message: "One or more products not found" });
        }

        // ── Calculate totals ──────────────────────────────────────────
        let totalAmount = 0;
        let totalCost = 0;
        let totalProfit = 0;

        const saleItems = items.map((item: any) => {
            const product = products.find((p) => p.id === item.productId);
            if (!product) throw new Error(`Product ${item.productId} not found`);

            if (product.stock < item.quantity) {
                throw new Error(
                    `Insufficient stock for ${product.name}. Available: ${product.stock}`
                );
            }

            const itemTotal = product.sellingPrice * item.quantity;
            const itemCost = product.costPrice * item.quantity;
            const itemProfit = itemTotal - itemCost;

            totalAmount += itemTotal;
            totalCost += itemCost;
            totalProfit += itemProfit;

            return {
                productId: product.id,
                quantity: item.quantity,
                unitPrice: product.sellingPrice,
                costPrice: product.costPrice,
                profit: itemProfit,
            };
        });

        const paid = parseFloat(amountPaid) || 0;
        const amountDue = totalAmount - paid;

        // ── Validate credit limit ─────────────────────────────────────
        if (amountDue > 0) {
            if (!customerId) {
                return res.status(400).json({
                    message: "Customer required for credit sales",
                });
            }

            const customer = await prisma.customer.findFirst({
                where: { id: customerId, depotId: user.depotId! },
            });
            if (!customer) {
                return res.status(404).json({ message: "Customer not found" });
            }

            const newDebt = customer.totalDebt + amountDue;
            if (newDebt > customer.creditLimit) {
                return res.status(400).json({
                    message: `Credit limit exceeded. Limit: ${customer.creditLimit}, Current debt: ${customer.totalDebt}, New debt would be: ${newDebt}`,
                });
            }
        }

        // ── Transaction ───────────────────────────────────────────────
        const sale = await prisma.$transaction(async (tx) => {
            const newSale = await tx.sale.create({
                data: {
                    depot: { connect: { id: user.depotId! } },
                    soldBy: { connect: { id: user.userId } },
                    ...(customerId
                        ? { customer: { connect: { id: customerId } } }
                        : {}),
                    totalAmount,
                    totalCost,
                    totalProfit,
                    amountPaid: paid,
                    amountDue,
                    paymentType: paymentType || "CASH",
                    status: "COMPLETED",
                    note: note || null,
                    items: {
                        create: saleItems,
                    },
                },
                include: {
                    items: { include: { product: true } },
                    customer: true,
                    soldBy: { select: { id: true, name: true, role: true } },
                },
            });

            // ── Update stock for each product ─────────────────────────
            for (const item of items) {
                await tx.product.update({
                    where: { id: item.productId },
                    data: { stock: { decrement: item.quantity } },
                });
            }

            // ── Update customer debt if credit sale ───────────────────
            if (amountDue > 0 && customerId) {
                await tx.customer.update({
                    where: { id: customerId },
                    data: { totalDebt: { increment: amountDue } },
                });
            }

            // ── Record payment if something was paid ──────────────────
            if (paid > 0) {
                await tx.payment.create({
                    data: {
                        depot: { connect: { id: user.depotId! } },
                        ...(customerId
                            ? { customer: { connect: { id: customerId } } }
                            : {}),
                        sale: { connect: { id: newSale.id } },
                        amount: paid,
                        paymentType: paymentType || "CASH",
                    },
                });
            }

            return newSale;
        });

        // ── Send new sale notification to owner/admin ─────────────────
        try {
            const owners = await prisma.user.findMany({
                where: {
                    depotId: user.depotId!,
                    role: { in: ["OWNER", "ADMIN"] },
                    fcmToken: { not: null },
                    isActive: true,
                },
                select: { fcmToken: true },
            });

            const tokens = owners.map((o) => o.fcmToken!).filter(Boolean);

            if (tokens.length > 0) {
                const seller = await prisma.user.findUnique({
                    where: { id: user.userId },
                    select: { name: true },
                });

                const formattedAmount = new Intl.NumberFormat("fr-CM").format(
                    sale.totalAmount
                );

                const itemsSummary = sale.items
                    .map((i: any) => `${i.quantity}x ${i.product.name}`)
                    .join(", ");

                const isCredit = amountDue > 0;
                const customerName = sale.customer?.name || null;

                let body = `${seller?.name} a vendu ${itemsSummary} — ${formattedAmount} FCFA`;
                if (isCredit && customerName) {
                    body += ` (Crédit: ${customerName})`;
                } else if (isCredit) {
                    body += ` (Vente à crédit)`;
                }

                await sendToMultipleTokens(
                    tokens,
                    "💰 Nouvelle vente",
                    body,
                    {
                        type: "NEW_SALE",
                        saleId: sale.id,
                        amount: sale.totalAmount.toString(),
                        sellerName: seller?.name || "",
                        screen: "/sales-history",
                    }
                );
            }
        } catch (notifError) {
            console.error("Sale notification failed:", notifError);
        }

        // ── Check low stock and notify owner ──────────────────────────
        try {
            const soldProductIds = items.map((i: any) => i.productId);

            const updatedProducts = await prisma.product.findMany({
                where: {
                    id: { in: soldProductIds },
                    depotId: user.depotId!,
                    isActive: true,
                },
            });

            const alertProducts = updatedProducts.filter(
                (p) => p.stock <= p.lowStockThreshold
            );

            if (alertProducts.length > 0) {
                const ownerTokens = await prisma.user.findMany({
                    where: {
                        depotId: user.depotId!,
                        role: { in: ["OWNER", "ADMIN"] },
                        fcmToken: { not: null },
                        isActive: true,
                    },
                    select: { fcmToken: true },
                });

                const stockTokens = ownerTokens
                    .map((o) => o.fcmToken!)
                    .filter(Boolean);

                if (stockTokens.length > 0) {
                    for (const product of alertProducts) {
                        const isOutOfStock = product.stock === 0;
                        await sendToMultipleTokens(
                            stockTokens,
                            isOutOfStock
                                ? "🚨 Rupture de stock!"
                                : "⚠️ Stock faible!",
                            isOutOfStock
                                ? `${product.name} est épuisé. Réapprovisionnez immédiatement.`
                                : `${product.name} — ${product.stock} ${product.unit} restant(s). Seuil: ${product.lowStockThreshold}`,
                            {
                                type: "LOW_STOCK",
                                productId: product.id,
                                productName: product.name,
                                stock: product.stock.toString(),
                                screen: "/stock",
                            }
                        );
                    }
                }
            }
        } catch (stockNotifError) {
            console.error("Low stock notification failed:", stockNotifError);
        }

        return res.status(201).json({ message: "Sale recorded", sale });
    } catch (error: any) {
        console.error(error);
        if (error.message?.includes("Insufficient stock")) {
            return res.status(400).json({ message: error.message });
        }
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET ALL SALES ────────────────────────────────────────────────
export const getSales = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { from, to, customerId, showCancelled } = req.query;

        const sales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                // By default exclude cancelled sales
                // Pass showCancelled=true to include them
                ...(showCancelled === "true"
                    ? {}
                    : { status: "COMPLETED" }),
                ...(customerId
                    ? { customerId: customerId as string }
                    : {}),
                ...(from && to
                    ? {
                        createdAt: {
                            gte: new Date(from as string),
                            lte: new Date(to as string),
                        },
                    }
                    : {}),
            },
            orderBy: { createdAt: "desc" },
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true, role: true } },
                cancelledBy: {
                    select: { id: true, name: true, role: true },
                },
            },
        });

        return res.status(200).json({ sales });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SINGLE SALE ──────────────────────────────────────────────
export const getSale = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.id as string;

        const sale = await prisma.sale.findFirst({
            where: { id, depotId: user.depotId! },
            include: {
                items: { include: { product: true } },
                customer: true,
                soldBy: { select: { id: true, name: true, role: true } },
                cancelledBy: {
                    select: { id: true, name: true, role: true },
                },
                payments: true,
            },
        });

        if (!sale) return res.status(404).json({ message: "Sale not found" });

        return res.status(200).json({ sale });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SALES SUMMARY (dashboard) ───────────────────────────────
export const getSalesSummary = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Only count completed sales for summary
        const todaySales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                status: "COMPLETED",
                createdAt: { gte: today, lt: tomorrow },
            },
        });

        // Count cancelled sales today for awareness
        const cancelledToday = await prisma.sale.count({
            where: {
                depotId: user.depotId!,
                status: "CANCELLED",
                createdAt: { gte: today, lt: tomorrow },
            },
        });

        const totalRevenue = todaySales.reduce(
            (sum, s) => sum + s.totalAmount, 0
        );
        const totalProfit = todaySales.reduce(
            (sum, s) => sum + s.totalProfit, 0
        );
        const totalCash = todaySales.reduce(
            (sum, s) => sum + s.amountPaid, 0
        );
        const totalCredit = todaySales.reduce(
            (sum, s) => sum + s.amountDue, 0
        );

        return res.status(200).json({
            summary: {
                date: today,
                totalSales: todaySales.length,
                totalRevenue,
                totalProfit,
                totalCash,
                totalCredit,
                cancelledToday,
            },
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};