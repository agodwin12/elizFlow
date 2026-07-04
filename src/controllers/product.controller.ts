import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2";
import { v4 as uuidv4 } from "uuid";
import { asyncHandler, ApiError } from "../lib/http";
import { getPagination, pageMeta } from "../lib/pagination";
import { describeStock } from "../lib/units";
import { audit } from "../lib/audit";

const toBool = (v: any, dflt = false): boolean => {
    if (v === undefined || v === null || v === "") return dflt;
    if (typeof v === "boolean") return v;
    return ["true", "1", "yes", "on"].includes(String(v).toLowerCase());
};

const num = (v: any): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

/**
 * Convert an incoming stock quantity into BASE units. `stockUnit` may be
 * "PACKAGE" (default – multiply by packSize) or "BASE" (already base units).
 */
function toBaseStock(rawStock: any, packSize: number, stockUnit?: string): number {
    const q = num(rawStock) ?? 0;
    const unit = (stockUnit || "PACKAGE").toUpperCase();
    if (unit === "BASE" || unit === "UNIT") return Math.round(q);
    return Math.round(q * (packSize > 0 ? packSize : 1));
}

async function uploadImage(file: Express.Multer.File, depotId: string): Promise<string> {
    const key = `products/${depotId}/${uuidv4()}-${file.originalname}`;
    await r2Client.send(
        new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME!,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
        })
    );
    return `${process.env.R2_PUBLIC_URL}/${key}`;
}

function withStockLabel(p: any) {
    return {
        ...p,
        stockDescription: describeStock(
            p.stock,
            p.packSize ?? 1,
            p.packageUnit ?? p.unit ?? "CASIER",
            p.baseUnit ?? "UNITE"
        ),
    };
}

// ─── CREATE PRODUCT ─────────────────────────────────────────────────
export const createProduct = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();

    const {
        name,
        category,
        costPrice,
        sellingPrice,
        stock,
        stockUnit,
        unit,
        packageUnit,
        baseUnit,
        packSize: rawPackSize,
        unitCostPrice,
        unitSellingPrice,
        halfPackagePrice,
        lowStockThreshold,
        sku,
        barcode,
        supplierId,
    } = req.body;

    if (!name || !category) throw ApiError.badRequest("Name and category are required");
    if (num(costPrice) === undefined || num(sellingPrice) === undefined) {
        throw ApiError.badRequest("costPrice and sellingPrice are required");
    }

    const packSize = Math.max(1, Math.round(num(rawPackSize) ?? 1));
    const sellByUnit = toBool(req.body.sellByUnit, false);
    const sellByHalf = toBool(req.body.sellByHalf, false);
    const sellByPackage = toBool(req.body.sellByPackage, true);

    if (sellByHalf && packSize % 2 !== 0) {
        throw ApiError.badRequest(
            "sellByHalf requires an even pack size",
            "PACK_NOT_DIVISIBLE"
        );
    }
    if (sellByUnit && num(unitSellingPrice) === undefined) {
        throw ApiError.badRequest(
            "unitSellingPrice is required when sellByUnit is enabled",
            "UNIT_PRICE_MISSING"
        );
    }

    let imageUrl: string | undefined;
    if (req.file) imageUrl = await uploadImage(req.file, user.depotId!);

    const pkgLabel = packageUnit || unit || "CASIER";

    const product = await prisma.product.create({
        data: {
            name,
            category,
            imageUrl,
            sku: sku || null,
            barcode: barcode || null,
            costPrice: num(costPrice)!,
            sellingPrice: num(sellingPrice)!,
            unitCostPrice: num(unitCostPrice) ?? null,
            unitSellingPrice: num(unitSellingPrice) ?? null,
            halfPackagePrice: num(halfPackagePrice) ?? null,
            stock: toBaseStock(stock, packSize, stockUnit),
            packSize,
            baseUnit: baseUnit || "UNITE",
            packageUnit: pkgLabel,
            unit: pkgLabel, // keep legacy field in sync
            sellByPackage,
            sellByHalf,
            sellByUnit,
            lowStockThreshold: Math.max(0, Math.round(num(lowStockThreshold) ?? 10)),
            depotId: user.depotId!,
            ...(supplierId ? { supplierId } : {}),
        },
    });

    return res.status(201).json({ message: "Product created", product: withStockLabel(product) });
});

// ─── GET ALL PRODUCTS ───────────────────────────────────────────────
export const getProducts = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { search, category, barcode } = req.query;
    const paginated = req.query.page !== undefined || req.query.pageSize !== undefined;
    const pg = getPagination(req);

    const where: any = {
        depotId: user.depotId,
        isActive: true,
        ...(category ? { category: category as string } : {}),
        ...(barcode ? { barcode: barcode as string } : {}),
        ...(search
            ? {
                  OR: [
                      { name: { contains: search as string, mode: "insensitive" } },
                      { sku: { contains: search as string, mode: "insensitive" } },
                      { barcode: { contains: search as string, mode: "insensitive" } },
                  ],
              }
            : {}),
    };

    if (!paginated) {
        // Backward-compatible: unpaginated list for existing clients.
        const products = await prisma.product.findMany({
            where,
            orderBy: { name: "asc" },
        });
        return res.status(200).json({ products: products.map(withStockLabel) });
    }

    const [products, total] = await Promise.all([
        prisma.product.findMany({
            where,
            orderBy: { name: "asc" },
            skip: pg.skip,
            take: pg.take,
        }),
        prisma.product.count({ where }),
    ]);
    return res
        .status(200)
        .json({ products: products.map(withStockLabel), pagination: pageMeta(total, pg) });
});

// ─── GET SINGLE PRODUCT ─────────────────────────────────────────────
export const getProduct = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const product = await prisma.product.findFirst({
        where: { id: req.params.id, depotId: user.depotId },
    });
    if (!product) throw ApiError.notFound("Product not found");
    return res.status(200).json({ product: withStockLabel(product) });
});

// ─── UPDATE PRODUCT ─────────────────────────────────────────────────
export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();

    const existing = await prisma.product.findFirst({
        where: { id, depotId: user.depotId },
    });
    if (!existing) throw ApiError.notFound("Product not found");

    let imageUrl = existing.imageUrl;
    if (req.file) {
        if (existing.imageUrl) {
            const oldKey = existing.imageUrl.replace(`${process.env.R2_PUBLIC_URL}/`, "");
            await r2Client
                .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: oldKey }))
                .catch((e) => console.warn("Old image delete failed:", e.message));
        }
        imageUrl = await uploadImage(req.file, user.depotId!);
    }

    const {
        name,
        category,
        costPrice,
        sellingPrice,
        unit,
        packageUnit,
        baseUnit,
        packSize: rawPackSize,
        unitCostPrice,
        unitSellingPrice,
        halfPackagePrice,
        lowStockThreshold,
        sku,
        barcode,
        supplierId,
    } = req.body;

    const data: any = {
        ...(name && { name }),
        ...(category && { category }),
        ...(imageUrl && { imageUrl }),
        ...(num(costPrice) !== undefined && { costPrice: num(costPrice) }),
        ...(num(sellingPrice) !== undefined && { sellingPrice: num(sellingPrice) }),
        ...(unitCostPrice !== undefined && { unitCostPrice: num(unitCostPrice) ?? null }),
        ...(unitSellingPrice !== undefined && { unitSellingPrice: num(unitSellingPrice) ?? null }),
        ...(halfPackagePrice !== undefined && { halfPackagePrice: num(halfPackagePrice) ?? null }),
        ...(baseUnit && { baseUnit }),
        ...(sku !== undefined && { sku: sku || null }),
        ...(barcode !== undefined && { barcode: barcode || null }),
        ...(supplierId !== undefined && { supplierId: supplierId || null }),
        ...(num(lowStockThreshold) !== undefined && {
            lowStockThreshold: Math.max(0, Math.round(num(lowStockThreshold)!)),
        }),
        ...(req.body.sellByPackage !== undefined && {
            sellByPackage: toBool(req.body.sellByPackage, existing.sellByPackage),
        }),
        ...(req.body.sellByHalf !== undefined && {
            sellByHalf: toBool(req.body.sellByHalf, existing.sellByHalf),
        }),
        ...(req.body.sellByUnit !== undefined && {
            sellByUnit: toBool(req.body.sellByUnit, existing.sellByUnit),
        }),
    };

    const pkgLabel = packageUnit || unit;
    if (pkgLabel) {
        data.packageUnit = pkgLabel;
        data.unit = pkgLabel;
    }

    // Handle a pack-size change: convert existing stock so the physical
    // quantity stays the same (e.g. 10 crates -> 120 bottles when packSize 1->12).
    const newPackSize =
        rawPackSize !== undefined ? Math.max(1, Math.round(num(rawPackSize)!)) : existing.packSize;

    if (newPackSize !== existing.packSize) {
        data.packSize = newPackSize;
        const oldPack = existing.packSize > 0 ? existing.packSize : 1;
        const convertedStock = Math.round((existing.stock / oldPack) * newPackSize);
        data.stock = convertedStock;
        await audit({
            depotId: user.depotId,
            userId: user.userId,
            action: "PRODUCT_PACKSIZE_CHANGED",
            entity: "Product",
            entityId: id,
            meta: {
                oldPackSize: existing.packSize,
                newPackSize,
                oldStock: existing.stock,
                newStock: convertedStock,
            },
        });
    }

    const finalHalf = data.sellByHalf ?? existing.sellByHalf;
    if (finalHalf && newPackSize % 2 !== 0) {
        throw ApiError.badRequest("sellByHalf requires an even pack size", "PACK_NOT_DIVISIBLE");
    }

    const updated = await prisma.product.update({ where: { id }, data });
    return res.status(200).json({ message: "Product updated", product: withStockLabel(updated) });
});

// ─── ADJUST STOCK MANUALLY (sets absolute BASE-unit stock) ──────────
export const adjustStock = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    const { quantity, reason, stockUnit } = req.body;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();

    const product = await prisma.product.findFirst({
        where: { id, depotId: user.depotId },
    });
    if (!product) throw ApiError.notFound("Product not found");

    const newStock = toBaseStock(quantity, product.packSize, stockUnit);
    if (newStock < 0) throw ApiError.badRequest("Stock cannot be negative");

    const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.product.update({ where: { id }, data: { stock: newStock } });
        await tx.stockMovement.create({
            data: {
                product: { connect: { id } },
                depot: { connect: { id: user.depotId! } },
                user: { connect: { id: user.userId } },
                type: "CORRECTION",
                quantity: newStock - product.stock,
                previousStock: product.stock,
                newStock,
                note: reason || "Manual stock adjustment",
            },
        });
        return u;
    });

    return res.status(200).json({
        message: `Stock updated (${reason || "CORRECTION"})`,
        product: withStockLabel(updated),
    });
});

// ─── DELETE PRODUCT (soft delete) ───────────────────────────────────
export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = req.params.id;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();

    const existing = await prisma.product.findFirst({
        where: { id, depotId: user.depotId },
    });
    if (!existing) throw ApiError.notFound("Product not found");

    await prisma.product.update({ where: { id }, data: { isActive: false } });
    return res.status(200).json({ message: "Product deleted" });
});
