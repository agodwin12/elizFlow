import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

// ─── HELPER: get date range ───────────────────────────────────────
const getDateRange = (from?: string, to?: string) => {
    const start = from ? new Date(from) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = to ? new Date(to) : new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
};

// ─── MAIN DASHBOARD (one call, everything) ────────────────────────
export const getDashboard = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Last 7 days for charts
        const last7Days = new Date();
        last7Days.setDate(last7Days.getDate() - 6);
        last7Days.setHours(0, 0, 0, 0);

        // ── Today's sales ─────────────────────────────────────────────
        const todaySales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                createdAt: { gte: today, lt: tomorrow },
            },
            include: { items: true },
        });

        const todayRevenue = todaySales.reduce((sum, s) => sum + s.totalAmount, 0);
        const todayProfit = todaySales.reduce((sum, s) => sum + s.totalProfit, 0);
        const todayCash = todaySales.reduce((sum, s) => sum + s.amountPaid, 0);
        const todayCredit = todaySales.reduce((sum, s) => sum + s.amountDue, 0);

        // ── Last 7 days sales (for line chart) ────────────────────────
        const last7DaysSales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                createdAt: { gte: last7Days, lt: tomorrow },
            },
        });

        // Group by day
        const salesByDay: Record<string, { revenue: number; profit: number; count: number }> = {};
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const key = date.toISOString().split("T")[0];
            salesByDay[key] = { revenue: 0, profit: 0, count: 0 };
        }

        last7DaysSales.forEach((sale) => {
            const key = sale.createdAt.toISOString().split("T")[0];
            if (salesByDay[key]) {
                salesByDay[key].revenue += sale.totalAmount;
                salesByDay[key].profit += sale.totalProfit;
                salesByDay[key].count += 1;
            }
        });

        // Format for chart
        const revenueChart = Object.entries(salesByDay).map(([date, data]) => ({
            date,
            revenue: data.revenue,
            profit: data.profit,
            sales: data.count,
        }));

        // ── Top 5 selling products (for bar chart) ────────────────────
        const topProducts = await prisma.saleItem.groupBy({
            by: ["productId"],
            where: {
                sale: { depotId: user.depotId! },
            },
            _sum: { quantity: true, profit: true },
            orderBy: { _sum: { quantity: "desc" } },
            take: 5,
        });

        const topProductsWithNames = await Promise.all(
            topProducts.map(async (item) => {
                const product = await prisma.product.findUnique({
                    where: { id: item.productId },
                    select: { name: true, unit: true },
                });
                return {
                    productId: item.productId,
                    name: product?.name || "Unknown",
                    unit: product?.unit || "CASIER",
                    totalQuantity: item._sum.quantity || 0,
                    totalProfit: item._sum.profit || 0,
                };
            })
        );

        // ── Payment type breakdown (for pie chart) ────────────────────
        const paymentBreakdown = await prisma.sale.groupBy({
            by: ["paymentType"],
            where: {
                depotId: user.depotId!,
                createdAt: { gte: today, lt: tomorrow },
            },
            _sum: { totalAmount: true },
            _count: { id: true },
        });

        const paymentChart = paymentBreakdown.map((p) => ({
            type: p.paymentType,
            amount: p._sum.totalAmount || 0,
            count: p._count.id,
        }));

        // ── Debt summary ──────────────────────────────────────────────
        const debtors = await prisma.customer.findMany({
            where: {
                depotId: user.depotId!,
                isActive: true,
                totalDebt: { gt: 0 },
            },
            orderBy: { totalDebt: "desc" },
            take: 5,
            select: {
                id: true,
                name: true,
                phone: true,
                totalDebt: true,
            },
        });

        const totalOutstandingDebt = await prisma.customer.aggregate({
            where: {
                depotId: user.depotId!,
                isActive: true,
                totalDebt: { gt: 0 },
            },
            _sum: { totalDebt: true },
        });

        // ── Low stock alerts ──────────────────────────────────────────
        const allProducts = await prisma.product.findMany({
            where: { depotId: user.depotId!, isActive: true },
        });

        const lowStockProducts = allProducts
            .filter((p) => p.stock <= p.lowStockThreshold)
            .map((p) => ({
                id: p.id,
                name: p.name,
                stock: p.stock,
                lowStockThreshold: p.lowStockThreshold,
                unit: p.unit,
            }));

        // ── Stock value ───────────────────────────────────────────────
        const stockValue = allProducts.reduce(
            (sum, p) => sum + p.stock * p.costPrice,
            0
        );

        return res.status(200).json({
            dashboard: {
                // Today summary cards
                today: {
                    totalSales: todaySales.length,
                    totalRevenue: todayRevenue,
                    totalProfit: todayProfit,
                    totalCash: todayCash,
                    totalCredit: todayCredit,
                },
                // Line chart — revenue & profit last 7 days
                revenueChart,
                // Bar chart — top 5 products
                topProducts: topProductsWithNames,
                // Pie chart — payment types
                paymentChart,
                // Debt section
                debt: {
                    totalOutstanding: totalOutstandingDebt._sum.totalDebt || 0,
                    topDebtors: debtors,
                },
                // Stock section
                stock: {
                    totalStockValue: stockValue,
                    lowStockCount: lowStockProducts.length,
                    lowStockProducts,
                },
            },
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── SALES REPORT (date range) ────────────────────────────────────
export const getSalesReport = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { from, to } = req.query;
        const { start, end } = getDateRange(from as string, to as string);

        const sales = await prisma.sale.findMany({
            where: {
                depotId: user.depotId!,
                createdAt: { gte: start, lte: end },
            },
            include: {
                items: { include: { product: true } },
                customer: { select: { id: true, name: true } },
                soldBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        const totalRevenue = sales.reduce((sum, s) => sum + s.totalAmount, 0);
        const totalProfit = sales.reduce((sum, s) => sum + s.totalProfit, 0);
        const totalCash = sales.reduce((sum, s) => sum + s.amountPaid, 0);
        const totalCredit = sales.reduce((sum, s) => sum + s.amountDue, 0);

        // Group by day for chart
        const byDay: Record<string, { revenue: number; profit: number; count: number }> = {};
        sales.forEach((sale) => {
            const key = sale.createdAt.toISOString().split("T")[0];
            if (!byDay[key]) byDay[key] = { revenue: 0, profit: 0, count: 0 };
            byDay[key].revenue += sale.totalAmount;
            byDay[key].profit += sale.totalProfit;
            byDay[key].count += 1;
        });

        const chartData = Object.entries(byDay).map(([date, data]) => ({
            date,
            revenue: data.revenue,
            profit: data.profit,
            sales: data.count,
        }));

        return res.status(200).json({
            summary: {
                from: start,
                to: end,
                totalSales: sales.length,
                totalRevenue,
                totalProfit,
                totalCash,
                totalCredit,
            },
            chartData,
            sales,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── TOP PRODUCTS REPORT ──────────────────────────────────────────
export const getTopProductsReport = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { from, to, limit } = req.query;
        const { start, end } = getDateRange(from as string, to as string);

        const topProducts = await prisma.saleItem.groupBy({
            by: ["productId"],
            where: {
                sale: {
                    depotId: user.depotId!,
                    createdAt: { gte: start, lte: end },
                },
            },
            _sum: { quantity: true, profit: true },
            _count: { id: true },
            orderBy: { _sum: { quantity: "desc" } },
            take: parseInt(limit as string) || 10,
        });

        const withNames = await Promise.all(
            topProducts.map(async (item) => {
                const product = await prisma.product.findUnique({
                    where: { id: item.productId },
                    select: { name: true, unit: true, sellingPrice: true },
                });
                return {
                    productId: item.productId,
                    name: product?.name || "Unknown",
                    unit: product?.unit || "CASIER",
                    totalQuantity: item._sum.quantity || 0,
                    totalProfit: item._sum.profit || 0,
                    totalRevenue: (product?.sellingPrice || 0) * (item._sum.quantity || 0),
                    timesSold: item._count.id,
                };
            })
        );

        return res.status(200).json({
            from: start,
            to: end,
            topProducts: withNames,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── EMPLOYEE PERFORMANCE REPORT ──────────────────────────────────
export const getEmployeeReport = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Access denied" });
        }

        const { from, to } = req.query;
        const { start, end } = getDateRange(from as string, to as string);

        const performance = await prisma.sale.groupBy({
            by: ["soldById"],
            where: {
                depotId: user.depotId!,
                createdAt: { gte: start, lte: end },
            },
            _sum: { totalAmount: true, totalProfit: true },
            _count: { id: true },
        });

        const withNames = await Promise.all(
            performance.map(async (item) => {
                const employee = await prisma.user.findUnique({
                    where: { id: item.soldById },
                    select: { name: true, role: true },
                });
                return {
                    userId: item.soldById,
                    name: employee?.name || "Unknown",
                    role: employee?.role || "Unknown",
                    totalSales: item._count.id,
                    totalRevenue: item._sum.totalAmount || 0,
                    totalProfit: item._sum.totalProfit || 0,
                };
            })
        );

        return res.status(200).json({
            from: start,
            to: end,
            performance: withNames,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};