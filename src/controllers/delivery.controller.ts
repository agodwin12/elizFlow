import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSmsNotification } from '../services/comm/sms.service';

// ═══════════════════════════════════════════════════════════════
// CREATE TOURNEE
// ═══════════════════════════════════════════════════════════════

export const createTournee = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        if (!['OWNER', 'CASHIER', 'ADMIN'].includes(user.role)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { driverId, stops, note } = req.body;

        // Validate driver belongs to same depot and has DRIVER role
        const driver = await prisma.user.findFirst({
            where: { id: driverId, depotId: user.depotId!, role: 'DRIVER', isActive: true },
        });

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found in this depot' });
        }

        if (!stops || !Array.isArray(stops) || stops.length === 0) {
            return res.status(400).json({ message: 'At least one stop is required' });
        }

        // Validate each stop and compute totals
        for (const stop of stops) {
            if (!stop.customerId || !stop.plannedItems || stop.plannedItems.length === 0) {
                return res.status(400).json({ message: 'Each stop must have a customer and at least one item' });
            }

            for (const item of stop.plannedItems) {
                const product = await prisma.product.findFirst({
                    where: { id: item.productId, depotId: user.depotId!, isActive: true },
                });

                if (!product) {
                    return res.status(404).json({ message: `Product ${item.productId} not found` });
                }

                if (product.stock < item.quantity) {
                    return res.status(400).json({
                        message: `Insufficient stock for ${product.name}. Available: ${product.stock}`,
                    });
                }
            }
        }

        // Create tournee + stops in a transaction
        const tournee = await prisma.$transaction(async (tx) => {
            const newTournee = await tx.tournee.create({
                data: {
                    depotId: user.depotId!,
                    driverId,
                    createdById: user.userId,
                    note,
                    stops: {
                        create: stops.map((stop: any) => ({
                            customerId: stop.customerId,
                            depotId: user.depotId!,
                            plannedItems: stop.plannedItems,
                            amountExpected: stop.plannedItems.reduce(
                                (sum: number, item: any) => sum + item.quantity * item.sellingPrice,
                                0
                            ),
                        })),
                    },
                },
                include: {
                    stops: true,
                    driver: { select: { id: true, name: true, phone: true } },
                },
            });

            return newTournee;
        });

        return res.status(201).json({
            message: 'Tournee created successfully',
            tournee,
        });
    } catch (error) {
        console.error('[DELIVERY ERROR] createTournee:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ═══════════════════════════════════════════════════════════════
// DISPATCH TOURNEE (deduct stock, notify driver)
// ═══════════════════════════════════════════════════════════════

export const dispatchTournee = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        if (!['OWNER', 'CASHIER', 'ADMIN'].includes(user.role)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { id } = req.params;

        const tournee = await prisma.tournee.findFirst({
            where: { id, depotId: user.depotId! },
            include: { stops: true, driver: true },
        });

        if (!tournee) return res.status(404).json({ message: 'Tournee not found' });
        if (tournee.status !== 'PLANNED') {
            return res.status(400).json({ message: 'Only PLANNED tournees can be dispatched' });
        }

        await prisma.$transaction(async (tx) => {
            // Deduct stock for every planned item across all stops
            for (const stop of tournee.stops) {
                const plannedItems = stop.plannedItems as any[];

                for (const item of plannedItems) {
                    const product = await tx.product.findFirst({
                        where: { id: item.productId, depotId: user.depotId! },
                    });

                    if (!product || product.stock < item.quantity) {
                        throw new Error(`Insufficient stock for product ${item.productId}`);
                    }

                    await tx.product.update({
                        where: { id: item.productId },
                        data: { stock: { decrement: item.quantity } },
                    });

                    await tx.stockMovement.create({
                        data: {
                            productId: item.productId,
                            depotId: user.depotId!,
                            userId: user.userId,
                            type: 'DELIVERY_DISPATCH',
                            quantity: -item.quantity,
                            previousStock: product.stock,
                            newStock: product.stock - item.quantity,
                            note: `Dispatched for tournee ${tournee.id}`,
                        },
                    });
                }
            }

            // Update tournee status
            await tx.tournee.update({
                where: { id },
                data: { status: 'IN_TRANSIT', dispatchedAt: new Date() },
            });
        });

        // Notify driver via SMS
        try {
            await sendSmsNotification(
                tournee.driver.phone,
                `DepotFlow: Votre tournée a été lancée. ${tournee.stops.length} arrêt(s) à effectuer. Bonne route!`
            );
        } catch (smsError) {
            console.error('[DELIVERY] Driver SMS failed (non-blocking):', smsError);
        }

        return res.status(200).json({ message: 'Tournee dispatched successfully' });
    } catch (error: any) {
        console.error('[DELIVERY ERROR] dispatchTournee:', error);
        if (error.message?.includes('Insufficient stock')) {
            return res.status(400).json({ message: error.message });
        }
        return res.status(500).json({ message: 'Server error' });
    }
};

// ═══════════════════════════════════════════════════════════════
// CONFIRM DELIVERY STOP (driver records what happened at each stop)
// ═══════════════════════════════════════════════════════════════

export const confirmStop = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { stopId } = req.params;
        const { deliveredItems, returnedItems, amountPaid, note } = req.body;

        const stop = await prisma.deliveryStop.findFirst({
            where: { id: stopId },
            include: {
                tournee: true,
                customer: true,
            },
        });

        if (!stop) return res.status(404).json({ message: 'Stop not found' });
        if (stop.depotId !== user.depotId!) return res.status(403).json({ message: 'Access denied' });
        if (stop.status !== 'PENDING') {
            return res.status(400).json({ message: 'Stop already processed' });
        }

        // Only driver assigned to this tournee or owner/cashier can confirm
        const isDriver = user.role === 'DRIVER' && stop.tournee.driverId === user.userId;
        const isOwnerOrCashier = ['OWNER', 'CASHIER', 'ADMIN'].includes(user.role);
        if (!isDriver && !isOwnerOrCashier) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const paid = amountPaid ?? 0;
        const debtCreated = Math.max(0, stop.amountExpected - paid);
        const stopStatus = paid === 0 ? 'FAILED' : paid < stop.amountExpected ? 'PARTIAL' : 'DELIVERED';

        await prisma.$transaction(async (tx) => {
            // Update the stop
            await tx.deliveryStop.update({
                where: { id: stopId },
                data: {
                    deliveredItems: deliveredItems ?? stop.plannedItems,
                    returnedItems: returnedItems ?? [],
                    amountPaid: paid,
                    debtCreated,
                    status: stopStatus,
                    note,
                    deliveredAt: new Date(),
                },
            });

            // Restock returned items
            if (returnedItems && returnedItems.length > 0) {
                for (const item of returnedItems) {
                    const product = await tx.product.findFirst({
                        where: { id: item.productId, depotId: user.depotId! },
                    });

                    if (product) {
                        await tx.product.update({
                            where: { id: item.productId },
                            data: { stock: { increment: item.quantity } },
                        });

                        await tx.stockMovement.create({
                            data: {
                                productId: item.productId,
                                depotId: user.depotId!,
                                userId: user.userId,
                                type: 'DELIVERY_RETURN',
                                quantity: item.quantity,
                                previousStock: product.stock,
                                newStock: product.stock + item.quantity,
                                note: `Returned from stop ${stopId}`,
                            },
                        });
                    }
                }
            }

            // Update customer debt if unpaid amount exists
            if (debtCreated > 0) {
                await tx.customer.update({
                    where: { id: stop.customerId },
                    data: { totalDebt: { increment: debtCreated } },
                });
            }
        });

        // Send SMS receipt to customer (non-blocking)
        try {
            const deliveredList = (deliveredItems ?? stop.plannedItems) as any[];
            const itemsSummary = deliveredList
                .map((i: any) => `${i.quantity}x ${i.productName}`)
                .join(', ');

            let smsMessage = `DepotFlow: Livraison reçue - ${itemsSummary}. Payé: ${paid} FCFA.`;
            if (debtCreated > 0) {
                smsMessage += ` Reste dû: ${debtCreated} FCFA.`;
            }

            if (stop.customer.phone) {
                await sendSmsNotification(stop.customer.phone, smsMessage);

                await prisma.deliveryStop.update({
                    where: { id: stopId },
                    data: { smsSent: true },
                });
            }
        } catch (smsError) {
            console.error('[DELIVERY] Customer SMS failed (non-blocking):', smsError);
        }

        return res.status(200).json({
            message: 'Stop confirmed',
            stopStatus,
            amountPaid: paid,
            debtCreated,
        });
    } catch (error) {
        console.error('[DELIVERY ERROR] confirmStop:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ═══════════════════════════════════════════════════════════════
// CLOSE TOURNEE (driver marks trip as done)
// ═══════════════════════════════════════════════════════════════

export const closeTournee = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { id } = req.params;

        const tournee = await prisma.tournee.findFirst({
            where: { id, depotId: user.depotId! },
            include: { stops: true, driver: true },
        });

        if (!tournee) return res.status(404).json({ message: 'Tournee not found' });
        if (tournee.status !== 'IN_TRANSIT') {
            return res.status(400).json({ message: 'Only IN_TRANSIT tournees can be closed' });
        }

        const isDriver = user.role === 'DRIVER' && tournee.driverId === user.userId;
        const isOwnerOrCashier = ['OWNER', 'CASHIER', 'ADMIN'].includes(user.role);
        if (!isDriver && !isOwnerOrCashier) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const pendingStops = tournee.stops.filter((s) => s.status === 'PENDING');
        if (pendingStops.length > 0) {
            return res.status(400).json({
                message: `${pendingStops.length} stop(s) still pending. Confirm all stops before closing.`,
            });
        }

        // Build reconciliation summary
        const totalExpected = tournee.stops.reduce((sum, s) => sum + s.amountExpected, 0);
        const totalCollected = tournee.stops.reduce((sum, s) => sum + s.amountPaid, 0);
        const totalDebtCreated = tournee.stops.reduce((sum, s) => sum + s.debtCreated, 0);
        const deliveredStops = tournee.stops.filter((s) => s.status === 'DELIVERED').length;
        const partialStops = tournee.stops.filter((s) => s.status === 'PARTIAL').length;
        const failedStops = tournee.stops.filter((s) => s.status === 'FAILED').length;

        await prisma.tournee.update({
            where: { id },
            data: { status: 'COMPLETED', completedAt: new Date() },
        });

        return res.status(200).json({
            message: 'Tournee completed',
            summary: {
                totalStops: tournee.stops.length,
                deliveredStops,
                partialStops,
                failedStops,
                totalExpected,
                totalCollected,
                totalDebtCreated,
                gap: totalExpected - totalCollected - totalDebtCreated,
            },
        });
    } catch (error) {
        console.error('[DELIVERY ERROR] closeTournee:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ═══════════════════════════════════════════════════════════════
// GET ALL TOURNEES (owner sees all, driver sees only his)
// ═══════════════════════════════════════════════════════════════

export const getTournees = async (req: Request, res: Response) => {
    try {
        const user = req.user!;

        const where: any = { depotId: user.depotId! };
        if (user.role === 'DRIVER') where.driverId = user.userId;

        const tournees = await prisma.tournee.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                driver: { select: { id: true, name: true, phone: true } },
                createdBy: { select: { id: true, name: true } },
                stops: {
                    include: {
                        customer: { select: { id: true, name: true, phone: true } },
                    },
                },
            },
        });

        return res.status(200).json({ tournees });
    } catch (error) {
        console.error('[DELIVERY ERROR] getTournees:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

// ═══════════════════════════════════════════════════════════════
// GET SINGLE TOURNEE DETAIL
// ═══════════════════════════════════════════════════════════════

export const getTourneeById = async (req: Request, res: Response) => {
    try {
        const user = req.user!;
        const { id } = req.params;

        const tournee = await prisma.tournee.findFirst({
            where: { id, depotId: user.depotId! },
            include: {
                driver: { select: { id: true, name: true, phone: true } },
                createdBy: { select: { id: true, name: true } },
                stops: {
                    include: {
                        customer: { select: { id: true, name: true, phone: true } },
                    },
                },
            },
        });

        if (!tournee) return res.status(404).json({ message: 'Tournee not found' });

        // Driver can only see their own tournee
        if (user.role === 'DRIVER' && tournee.driverId !== user.userId) {
            return res.status(403).json({ message: 'Access denied' });
        }

        return res.status(200).json({ tournee });
    } catch (error) {
        console.error('[DELIVERY ERROR] getTourneeById:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};