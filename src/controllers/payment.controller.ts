import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

// ─── RECORD PAYMENT ───────────────────────────────────────────────
export const recordPayment = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { customerId, amount, paymentType, note } = req.body;

        if (!customerId) {
            return res.status(400).json({ message: "Customer ID is required" });
        }
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ message: "Valid amount is required" });
        }

        const customer = await prisma.customer.findFirst({
            where: { id: customerId, depotId: user.depotId! },
        });
        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }
        if (customer.totalDebt <= 0) {
            return res.status(400).json({ message: "Customer has no outstanding debt" });
        }

        const paymentAmount = parseFloat(amount);
        if (paymentAmount > customer.totalDebt) {
            return res.status(400).json({
                message: `Payment exceeds debt. Customer owes: ${customer.totalDebt}`,
            });
        }

        const payment = await prisma.$transaction(async (tx) => {
            const newPayment = await tx.payment.create({
                data: {
                    depot: { connect: { id: user.depotId! } },
                    customer: { connect: { id: customerId } },
                    amount: paymentAmount,
                    paymentType,
                    note: note || null,
                    recordedBy: { connect: { id: user.userId } },
                },
            });

            await tx.customer.update({
                where: { id: customerId },
                data: { totalDebt: { decrement: paymentAmount } },
            });

            return newPayment;
        });

        const updatedCustomer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { totalDebt: true },
        });

        return res.status(201).json({
            message: "Payment recorded",
            payment,
            previousDebt: customer.totalDebt,
            amountPaid: paymentAmount,
            remainingDebt: updatedCustomer?.totalDebt ?? 0,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET ALL PAYMENTS ─────────────────────────────────────────────
export const getPayments = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        const payments = await prisma.payment.findMany({
            where: { depotId: user.depotId! },
            orderBy: { createdAt: "desc" },
            include: {
                customer: {
                    select: {
                        id: true,
                        name: true,
                        phone: true,
                        photoUrl: true,
                    },
                },
            },
        });

        return res.status(200).json({ payments });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET DEBTORS ──────────────────────────────────────────────────
export const getDebtors = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        const debtors = await prisma.customer.findMany({
            where: {
                depotId: user.depotId!,
                isActive: true,
                totalDebt: { gt: 0 },
            },
            orderBy: { totalDebt: "desc" },
            select: {
                id: true,
                name: true,
                phone: true,
                photoUrl: true,
                totalDebt: true,
                creditLimit: true,
                // Get the most recent payment date for this customer
                payments: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { createdAt: true },
                },
            },
        });

        // Flatten lastPaymentDate onto each debtor
        const debtorsWithLastPayment = debtors.map((d) => ({
            id: d.id,
            name: d.name,
            phone: d.phone,
            photoUrl: d.photoUrl,
            totalDebt: d.totalDebt,
            creditLimit: d.creditLimit,
            lastPaymentDate: d.payments[0]?.createdAt ?? null,
        }));

        const totalOutstanding = debtors.reduce((sum, c) => sum + c.totalDebt, 0);

        return res.status(200).json({
            totalOutstanding,
            totalDebtors: debtors.length,
            debtors: debtorsWithLastPayment,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};

// ─── GET CUSTOMER PAYMENTS ────────────────────────────────────────
export const getCustomerPayments = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const id = req.params.customerId as string;

        const customer = await prisma.customer.findFirst({
            where: { id, depotId: user.depotId! },
        });
        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }

        const payments = await prisma.payment.findMany({
            where: { customerId: id, depotId: user.depotId! },
            orderBy: { createdAt: "desc" },
        });

        return res.status(200).json({
            customer: {
                id: customer.id,
                name: customer.name,
                phone: customer.phone,
                totalDebt: customer.totalDebt,
                creditLimit: customer.creditLimit,
            },
            payments,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: "Server error" });
    }
};