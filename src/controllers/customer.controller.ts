import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../lib/r2";
import { v4 as uuidv4 } from "uuid";

// ─── CREATE CUSTOMER ──────────────────────────────────────────────
export const createCustomer = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { name, phone, address, creditLimit } = req.body;

        if (!name) {
            return res.status(400).json({ message: "Customer name is required" });
        }

        const customer = await prisma.customer.create({
            data: {
                name,
                phone: phone || null,
                address: address || null,
                creditLimit: parseFloat(creditLimit) || 50000,
                depotId: user.depotId,
            },
        });

        return res.status(201).json({ message: "Customer created", customer });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET ALL CUSTOMERS ────────────────────────────────────────────
export const getCustomers = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { search } = req.query;

        const customers = await prisma.customer.findMany({
            where: {
                depotId: user.depotId,
                isActive: true,
                ...(search
                    ? {
                        name: {
                            contains: search as string,
                            mode: "insensitive",
                        },
                    }
                    : {}),
            },
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                phone: true,
                address: true,
                photoUrl: true,
                totalDebt: true,
                creditLimit: true,
                createdAt: true,
            },
        });

        return res.status(200).json({ customers });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET SINGLE CUSTOMER ──────────────────────────────────────────
export const getCustomer = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        const customer = await prisma.customer.findFirst({
            where: { id, depotId: user.depotId },
            include: {
                sales: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                    select: {
                        id: true,
                        totalAmount: true,
                        amountPaid: true,
                        amountDue: true,
                        paymentType: true,
                        status: true,
                        createdAt: true,
                    },
                },
                payments: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                    select: {
                        id: true,
                        amount: true,
                        paymentType: true,
                        note: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }

        return res.status(200).json({ customer });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── UPDATE CUSTOMER ──────────────────────────────────────────────
export const updateCustomer = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;
        const { name, phone, address, creditLimit } = req.body;

        const existing = await prisma.customer.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!existing) {
            return res.status(404).json({ message: "Customer not found" });
        }

        const updated = await prisma.customer.update({
            where: { id },
            data: {
                ...(name && { name }),
                ...(phone !== undefined && { phone: phone || null }),
                ...(address !== undefined && { address: address || null }),
                ...(creditLimit && { creditLimit: parseFloat(creditLimit) }),
            },
        });

        return res.status(200).json({ message: "Customer updated", customer: updated });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── UPLOAD CUSTOMER PHOTO ────────────────────────────────────────
export const uploadCustomerPhoto = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        const existing = await prisma.customer.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!existing) {
            return res.status(404).json({ message: "Customer not found" });
        }

        if (!req.file) {
            return res.status(400).json({ message: "No photo provided" });
        }

        let photoUrl: string | undefined;

        try {
            const key = `customers/${user.depotId}/${uuidv4()}-${req.file.originalname}`;
            await r2Client.send(
                new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME!,
                    Key: key,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype,
                })
            );
            photoUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        } catch (uploadError) {
            console.error("R2 upload failed:", uploadError);
            return res.status(500).json({ message: "Photo upload failed" });
        }

        const updated = await prisma.customer.update({
            where: { id },
            data: { photoUrl },
        });

        return res.status(200).json({
            message: "Photo uploaded",
            customer: updated,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── DELETE CUSTOMER (soft delete) ───────────────────────────────
export const deleteCustomer = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const id = req.params.id as string;

        if (!["OWNER", "ADMIN"].includes(user.role)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const existing = await prisma.customer.findFirst({
            where: { id, depotId: user.depotId },
        });
        if (!existing) {
            return res.status(404).json({ message: "Customer not found" });
        }

        await prisma.customer.update({
            where: { id },
            data: { isActive: false },
        });

        return res.status(200).json({ message: "Customer deleted" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};