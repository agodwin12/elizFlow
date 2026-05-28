import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2";
import { v4 as uuidv4 } from "uuid";

// ─── CREATE PRODUCT ───────────────────────────────────────────────
export const createProduct = async (req: Request, res: Response) => {
    try {
        const { name, category, costPrice, sellingPrice, stock, unit, lowStockThreshold } = req.body;
        const user = (req as any).user;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        let imageUrl: string | undefined;

        if (req.file) {
            const key = `products/${user.depotId}/${uuidv4()}-${req.file.originalname}`;
            await r2Client.send(
                new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME!,
                    Key: key,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype,
                })
            );
            imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        }

        const product = await prisma.product.create({
            data: {
                name,
                category,
                imageUrl,
                costPrice: parseFloat(costPrice),
                sellingPrice: parseFloat(sellingPrice),
                stock: parseInt(stock) || 0,
                unit: unit || "CASIER",
                lowStockThreshold: parseInt(lowStockThreshold) || 10,
                depotId: user.depotId,
            },
        });

        return res.status(201).json({ message: "Product created", product });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET ALL PRODUCTS ─────────────────────────────────────────────
export const getProducts = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { search } = req.query;

        const products = await prisma.product.findMany({
            where: {
                depotId: user.depotId,
                isActive: true,
                ...(search
                    ? { name: { contains: search as string, mode: "insensitive" } }
                    : {}),
            },
            orderBy: { name: "asc" },
        });

        return res.status(200).json({ products });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SINGLE PRODUCT ───────────────────────────────────────────
export const getProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        const product = await prisma.product.findFirst({
            where: { id, depotId: user.depotId },
        });

        if (!product) return res.status(404).json({ message: "Product not found" });

        return res.status(200).json({ product });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── UPDATE PRODUCT ───────────────────────────────────────────────
export const updateProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const existing = await prisma.product.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!existing) return res.status(404).json({ message: "Product not found" });

        let imageUrl = existing.imageUrl;

        if (req.file) {
            if (existing.imageUrl) {
                const oldKey = existing.imageUrl.replace(`${process.env.R2_PUBLIC_URL}/`, "");
                await r2Client.send(
                    new DeleteObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME!,
                        Key: oldKey,
                    })
                );
            }
            const key = `products/${user.depotId}/${uuidv4()}-${req.file.originalname}`;
            await r2Client.send(
                new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME!,
                    Key: key,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype,
                })
            );
            imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        }

        const { name, category, costPrice, sellingPrice, unit, lowStockThreshold } = req.body;

        const updated = await prisma.product.update({
            where: { id },
            data: {
                ...(name && { name }),
                ...(category && { category }),
                ...(imageUrl && { imageUrl }),
                ...(costPrice && { costPrice: parseFloat(costPrice) }),
                ...(sellingPrice && { sellingPrice: parseFloat(sellingPrice) }),
                ...(unit && { unit }),
                ...(lowStockThreshold && { lowStockThreshold: parseInt(lowStockThreshold) }),
            },
        });

        return res.status(200).json({ message: "Product updated", product: updated });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── ADJUST STOCK MANUALLY ────────────────────────────────────────
export const adjustStock = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;
        const { quantity, reason } = req.body;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const product = await prisma.product.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!product) return res.status(404).json({ message: "Product not found" });

        const updated = await prisma.product.update({
            where: { id },
            data: { stock: parseInt(quantity) },
        });

        return res.status(200).json({
            message: `Stock updated (${reason || "CORRECTION"})`,
            product: updated,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── DELETE PRODUCT (soft delete) ────────────────────────────────
export const deleteProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const existing = await prisma.product.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!existing) return res.status(404).json({ message: "Product not found" });

        await prisma.product.update({
            where: { id },
            data: { isActive: false },
        });

        return res.status(200).json({ message: "Product deleted" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};