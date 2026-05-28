import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

// ─── MIDDLEWARE CHECK: Super Admin only ───────────────────────────
const isSuperAdmin = (req: Request, res: Response): boolean => {
    if (req.user?.role !== "SUPER_ADMIN") {
        res.status(403).json({ message: "Super Admin access required" });
        return false;
    }
    return true;
};

// ─── GET ALL DEPOTS WITH STATS ────────────────────────────────────
export const getAllDepots = async (req: Request, res: Response) => {
    try {
        console.log(`📦 getAllDepots — user: ${req.user?.userId}`);
        if (!isSuperAdmin(req, res)) return;

        const depots = await prisma.depot.findMany({
            orderBy: { createdAt: "desc" },
            include: {
                users: {
                    where: { role: "OWNER" },
                    select: { id: true, name: true, phone: true, avatarUrl: true },
                },
                _count: {
                    select: {
                        users: true,
                        products: true,
                        customers: true,
                        sales: true,
                    },
                },
            },
        });

        const depotsWithStats = await Promise.all(
            depots.map(async (depot) => {
                const salesStats = await prisma.sale.aggregate({
                    where: { depotId: depot.id },
                    _sum: { totalAmount: true, totalProfit: true },
                    _count: { id: true },
                });

                const todaySales = await prisma.sale.aggregate({
                    where: {
                        depotId: depot.id,
                        createdAt: {
                            gte: new Date(new Date().setHours(0, 0, 0, 0)),
                        },
                    },
                    _sum: { totalAmount: true },
                    _count: { id: true },
                });

                const totalDebt = await prisma.customer.aggregate({
                    where: { depotId: depot.id, totalDebt: { gt: 0 } },
                    _sum: { totalDebt: true },
                });

                return {
                    ...depot,
                    owner: depot.users[0] || null,
                    stats: {
                        totalUsers: depot._count.users,
                        totalProducts: depot._count.products,
                        totalCustomers: depot._count.customers,
                        totalSales: salesStats._count.id,
                        totalRevenue: salesStats._sum.totalAmount || 0,
                        totalProfit: salesStats._sum.totalProfit || 0,
                        totalDebt: totalDebt._sum.totalDebt || 0,
                        todaySales: todaySales._count.id,
                        todayRevenue: todaySales._sum.totalAmount || 0,
                    },
                };
            })
        );

        console.log(`✅ getAllDepots — returned ${depotsWithStats.length} depots`);
        return res.status(200).json({ depots: depotsWithStats });
    } catch (error) {
        console.error("❌ getAllDepots error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SINGLE DEPOT DETAIL ──────────────────────────────────────
export const getDepotDetail = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        console.log(`📦 getDepotDetail — depotId: ${id}, user: ${req.user?.userId}`);
        if (!isSuperAdmin(req, res)) return;

        const depot = await prisma.depot.findUnique({
            where: { id },
            include: {
                users: {
                    select: {
                        id: true,
                        name: true,
                        phone: true,
                        role: true,
                        isActive: true,
                        avatarUrl: true,   // ── user profile picture
                        createdAt: true,
                    },
                },
                products: {
                    where: { isActive: true },
                    orderBy: { stock: "asc" },   // low stock first
                    select: {
                        id: true,
                        name: true,
                        category: true,
                        imageUrl: true,            // ── product thumbnail
                        stock: true,
                        sellingPrice: true,
                        unit: true,
                        lowStockThreshold: true,
                    },
                },
            },
        });

        if (!depot) {
            console.warn(`⚠️  getDepotDetail — depot ${id} not found`);
            return res.status(404).json({ message: "Depot not found" });
        }

        // ── Sales last 7 days ─────────────────────────────────────
        const last7Days = new Date();
        last7Days.setDate(last7Days.getDate() - 6);
        last7Days.setHours(0, 0, 0, 0);

        const recentSales = await prisma.sale.findMany({
            where: {
                depotId: id,
                createdAt: { gte: last7Days },
            },
            orderBy: { createdAt: "desc" },
        });

        // Group by day
        const salesByDay: Record<string, { revenue: number; count: number }> = {};
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const key = date.toISOString().split("T")[0];
            salesByDay[key] = { revenue: 0, count: 0 };
        }
        recentSales.forEach((sale) => {
            const key = sale.createdAt.toISOString().split("T")[0];
            if (salesByDay[key]) {
                salesByDay[key].revenue += sale.totalAmount;
                salesByDay[key].count += 1;
            }
        });

        const chartData = Object.entries(salesByDay).map(([date, data]) => ({
            date,
            revenue: data.revenue,
            count: data.count,
        }));

        // ── Overall stats ─────────────────────────────────────────
        const stats = await prisma.sale.aggregate({
            where: { depotId: id },
            _sum: { totalAmount: true, totalProfit: true },
            _count: { id: true },
        });

        const debtStats = await prisma.customer.aggregate({
            where: { depotId: id, totalDebt: { gt: 0 } },
            _sum: { totalDebt: true },
            _count: { id: true },
        });

        console.log(`✅ getDepotDetail — depot: ${depot.name}, users: ${depot.users.length}, products: ${depot.products.length}`);

        return res.status(200).json({
            depot: {
                ...depot,
                stats: {
                    totalSales: stats._count.id,
                    totalRevenue: stats._sum.totalAmount || 0,
                    totalProfit: stats._sum.totalProfit || 0,
                    totalDebt: debtStats._sum.totalDebt || 0,
                    totalDebtors: debtStats._count.id,
                },
                chartData,
            },
        });
    } catch (error) {
        console.error("❌ getDepotDetail error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET COMBINED STATS (all depots) ─────────────────────────────
export const getCombinedStats = async (req: Request, res: Response) => {
    try {
        console.log(`📊 getCombinedStats — user: ${req.user?.userId}`);
        if (!isSuperAdmin(req, res)) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const allTimeSales = await prisma.sale.aggregate({
            _sum: { totalAmount: true, totalProfit: true },
            _count: { id: true },
        });

        const todaySales = await prisma.sale.aggregate({
            where: { createdAt: { gte: today, lt: tomorrow } },
            _sum: { totalAmount: true },
            _count: { id: true },
        });

        const totalDepots = await prisma.depot.count();
        const activeDepots = await prisma.depot.count({
            where: { isActive: true },
        });

        const totalUsers = await prisma.user.count({
            where: { isActive: true },
        });

        const totalDebt = await prisma.customer.aggregate({
            where: { totalDebt: { gt: 0 } },
            _sum: { totalDebt: true },
        });

        const last30Days = new Date();
        last30Days.setDate(last30Days.getDate() - 29);
        last30Days.setHours(0, 0, 0, 0);

        const depots = await prisma.depot.findMany({
            where: { isActive: true },
            select: { id: true, name: true },
        });

        const revenueByDepot = await Promise.all(
            depots.map(async (depot) => {
                const sales = await prisma.sale.aggregate({
                    where: {
                        depotId: depot.id,
                        createdAt: { gte: last30Days },
                    },
                    _sum: { totalAmount: true },
                    _count: { id: true },
                });
                return {
                    depotId: depot.id,
                    depotName: depot.name,
                    revenue: sales._sum.totalAmount || 0,
                    sales: sales._count.id,
                };
            })
        );

        console.log(`✅ getCombinedStats — depots: ${totalDepots}, revenue: ${allTimeSales._sum.totalAmount}`);

        return res.status(200).json({
            stats: {
                totalDepots,
                activeDepots,
                totalUsers,
                totalSales: allTimeSales._count.id,
                totalRevenue: allTimeSales._sum.totalAmount || 0,
                totalProfit: allTimeSales._sum.totalProfit || 0,
                totalDebt: totalDebt._sum.totalDebt || 0,
                todaySales: todaySales._count.id,
                todayRevenue: todaySales._sum.totalAmount || 0,
            },
            revenueByDepot,
        });
    } catch (error) {
        console.error("❌ getCombinedStats error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── TOGGLE DEPOT ACTIVE STATUS ───────────────────────────────────
export const toggleDepotStatus = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        console.log(`🔄 toggleDepotStatus — depotId: ${id}, user: ${req.user?.userId}`);
        if (!isSuperAdmin(req, res)) return;

        const depot = await prisma.depot.findUnique({ where: { id } });
        if (!depot) {
            console.warn(`⚠️  toggleDepotStatus — depot ${id} not found`);
            return res.status(404).json({ message: "Depot not found" });
        }

        const updated = await prisma.depot.update({
            where: { id },
            data: { isActive: !depot.isActive },
        });

        console.log(`✅ toggleDepotStatus — depot: ${depot.name}, isActive: ${updated.isActive}`);
        return res.status(200).json({
            message: `Depot ${updated.isActive ? "activated" : "deactivated"}`,
            depot: updated,
        });
    } catch (error) {
        console.error("❌ toggleDepotStatus error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── DELETE DEPOT (soft delete) ───────────────────────────────────
export const deleteDepot = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        console.log(`🗑️  deleteDepot — depotId: ${id}, user: ${req.user?.userId}`);
        if (!isSuperAdmin(req, res)) return;

        const depot = await prisma.depot.findUnique({ where: { id } });
        if (!depot) {
            console.warn(`⚠️  deleteDepot — depot ${id} not found`);
            return res.status(404).json({ message: "Depot not found" });
        }

        await prisma.depot.update({
            where: { id },
            data: { isActive: false },
        });

        console.log(`✅ deleteDepot — depot: ${depot.name} soft-deleted`);
        return res.status(200).json({ message: "Depot deleted" });
    } catch (error) {
        console.error("❌ deleteDepot error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};