import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../lib/http";

// ─── CREATE SUPPLIER ────────────────────────────────────────────────
export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();
    const { name, phone, address, note } = req.body;
    if (!name) throw ApiError.badRequest("Supplier name is required");

    const supplier = await prisma.supplier.create({
        data: {
            depot: { connect: { id: user.depotId! } },
            name,
            phone: phone || null,
            address: address || null,
            note: note || null,
        },
    });
    return res.status(201).json({ message: "Supplier created", supplier });
});

// ─── LIST SUPPLIERS ─────────────────────────────────────────────────
export const getSuppliers = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const suppliers = await prisma.supplier.findMany({
        where: { depotId: user.depotId!, isActive: true },
        orderBy: { name: "asc" },
        include: { _count: { select: { products: true } } },
    });
    return res.status(200).json({ suppliers });
});

// ─── UPDATE SUPPLIER ────────────────────────────────────────────────
export const updateSupplier = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();
    const existing = await prisma.supplier.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
    });
    if (!existing) throw ApiError.notFound("Supplier not found");
    const { name, phone, address, note } = req.body;
    const supplier = await prisma.supplier.update({
        where: { id: req.params.id },
        data: {
            ...(name && { name }),
            ...(phone !== undefined && { phone: phone || null }),
            ...(address !== undefined && { address: address || null }),
            ...(note !== undefined && { note: note || null }),
        },
    });
    return res.status(200).json({ message: "Supplier updated", supplier });
});

// ─── DELETE SUPPLIER (soft) ─────────────────────────────────────────
export const deleteSupplier = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!["OWNER", "ADMIN"].includes(user.role)) throw ApiError.forbidden();
    const existing = await prisma.supplier.findFirst({
        where: { id: req.params.id, depotId: user.depotId! },
    });
    if (!existing) throw ApiError.notFound("Supplier not found");
    await prisma.supplier.update({ where: { id: req.params.id }, data: { isActive: false } });
    return res.status(200).json({ message: "Supplier deleted" });
});
