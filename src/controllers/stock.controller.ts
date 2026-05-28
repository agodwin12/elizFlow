import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

// ─── RESTOCK (add stock from supplier) ───────────────────────────
export const restockProduct = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { productId, quantity, note } = req.body;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Only the owner can modify stock" });
        }
        if (!productId || !quantity || parseInt(quantity) <= 0) {
            return res.status(400).json({ message: "Product ID and valid quantity are required" });
        }

        const product = await prisma.product.findFirst({
            where: { id: productId, depotId: user.depotId! },
        });
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }

        const newStock = product.stock + parseInt(quantity);

        const result = await prisma.$transaction(async (tx) => {
            const updated = await tx.product.update({
                where: { id: productId },
                data: { stock: newStock },
            });
            const movement = await tx.stockMovement.create({
                data: {
                    product: { connect: { id: productId } },
                    depot: { connect: { id: user.depotId! } },
                    user: { connect: { id: user.userId } },
                    type: "RESTOCK",
                    quantity: parseInt(quantity),
                    previousStock: product.stock,
                    newStock,
                    note: note || null,
                },
            });
            return { updated, movement };
        });

        return res.status(200).json({
            message: "Stock restocked successfully",
            product: result.updated,
            movement: result.movement,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── LOG DAMAGE ───────────────────────────────────────────────────
export const logDamage = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { productId, quantity, note } = req.body;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Only the owner can modify stock" });
        }
        if (!productId || !quantity || parseInt(quantity) <= 0) {
            return res.status(400).json({ message: "Product ID and valid quantity are required" });
        }

        const product = await prisma.product.findFirst({
            where: { id: productId, depotId: user.depotId! },
        });
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }
        if (product.stock < parseInt(quantity)) {
            return res.status(400).json({
                message: `Cannot damage more than available stock. Current stock: ${product.stock}`,
            });
        }

        const newStock = product.stock - parseInt(quantity);

        const result = await prisma.$transaction(async (tx) => {
            const updated = await tx.product.update({
                where: { id: productId },
                data: { stock: newStock },
            });
            const movement = await tx.stockMovement.create({
                data: {
                    product: { connect: { id: productId } },
                    depot: { connect: { id: user.depotId! } },
                    user: { connect: { id: user.userId } },
                    type: "DAMAGE",
                    quantity: -parseInt(quantity),
                    previousStock: product.stock,
                    newStock,
                    note: note || null,
                },
            });
            return { updated, movement };
        });

        return res.status(200).json({
            message: "Damage logged successfully",
            product: result.updated,
            movement: result.movement,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── RETURN CRATES ────────────────────────────────────────────────
export const returnCrates = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { productId, quantity, note } = req.body;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Only the owner can modify stock" });
        }
        if (!productId || !quantity || parseInt(quantity) <= 0) {
            return res.status(400).json({ message: "Product ID and valid quantity are required" });
        }

        const product = await prisma.product.findFirst({
            where: { id: productId, depotId: user.depotId! },
        });
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }

        const newStock = product.stock + parseInt(quantity);

        const result = await prisma.$transaction(async (tx) => {
            const updated = await tx.product.update({
                where: { id: productId },
                data: { stock: newStock },
            });
            const movement = await tx.stockMovement.create({
                data: {
                    product: { connect: { id: productId } },
                    depot: { connect: { id: user.depotId! } },
                    user: { connect: { id: user.userId } },
                    type: "RETURN",
                    quantity: parseInt(quantity),
                    previousStock: product.stock,
                    newStock,
                    note: note || null,
                },
            });
            return { updated, movement };
        });

        return res.status(200).json({
            message: "Crates returned successfully",
            product: result.updated,
            movement: result.movement,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── MANUAL CORRECTION ────────────────────────────────────────────
export const correctStock = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { productId, newStock, note } = req.body;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Only the owner can modify stock" });
        }
        if (!productId || newStock === undefined || parseInt(newStock) < 0) {
            return res.status(400).json({ message: "Product ID and valid new stock are required" });
        }

        const product = await prisma.product.findFirst({
            where: { id: productId, depotId: user.depotId! },
        });
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }

        const correctedStock = parseInt(newStock);
        const difference = correctedStock - product.stock;

        const result = await prisma.$transaction(async (tx) => {
            const updated = await tx.product.update({
                where: { id: productId },
                data: { stock: correctedStock },
            });
            const movement = await tx.stockMovement.create({
                data: {
                    product: { connect: { id: productId } },
                    depot: { connect: { id: user.depotId! } },
                    user: { connect: { id: user.userId } },
                    type: "CORRECTION",
                    quantity: difference,
                    previousStock: product.stock,
                    newStock: correctedStock,
                    note: note || "Manual stock correction",
                },
            });
            return { updated, movement };
        });

        return res.status(200).json({
            message: "Stock corrected successfully",
            product: result.updated,
            movement: result.movement,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET STOCK MOVEMENTS (audit trail) ───────────────────────────
export const getStockMovements = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { productId, type, from, to } = req.query;

        if (user.role !== "OWNER") {
            return res.status(403).json({ message: "Only the owner can view stock movements" });
        }

        const movements = await prisma.stockMovement.findMany({
            where: {
                depotId: user.depotId!,
                ...(productId ? { productId: productId as string } : {}),
                ...(type ? { type: type as string } : {}),
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
                // ── imageUrl added so Flutter can show thumbnails ──
                product: {
                    select: {
                        id: true,
                        name: true,
                        unit: true,
                        imageUrl: true,
                    },
                },
                user: {
                    select: {
                        id: true,
                        name: true,
                        role: true,
                    },
                },
            },
        });

        // ── Month stats for the summary bar ──────────────────────
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const monthMovements = await prisma.stockMovement.findMany({
            where: {
                depotId: user.depotId!,
                createdAt: { gte: monthStart },
            },
            select: { type: true, quantity: true },
        });

        const stats = {
            restocked: monthMovements
                .filter((m) => m.type === "RESTOCK")
                .reduce((s, m) => s + m.quantity, 0),
            damaged: Math.abs(
                monthMovements
                    .filter((m) => m.type === "DAMAGE")
                    .reduce((s, m) => s + m.quantity, 0)
            ),
            returned: monthMovements
                .filter((m) => m.type === "RETURN")
                .reduce((s, m) => s + m.quantity, 0),
        };

        return res.status(200).json({ movements, stats });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET LOW STOCK ALERTS ─────────────────────────────────────────
export const getLowStockAlerts = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        const lowStockProducts = await prisma.product.findMany({
            where: {
                depotId: user.depotId!,
                isActive: true,
                stock: { lte: prisma.product.fields.lowStockThreshold },
            },
            orderBy: { stock: "asc" },
            // ── imageUrl added so Flutter can show thumbnails ──────
            select: {
                id: true,
                name: true,
                category: true,
                imageUrl: true,
                stock: true,
                lowStockThreshold: true,
                unit: true,
            },
        });

        return res.status(200).json({
            totalAlerts: lowStockProducts.length,
            products: lowStockProducts,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};