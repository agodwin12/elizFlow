import { prisma } from "./prisma";

/**
 * Fire-and-forget audit logging. Never throws — an audit failure must not break
 * the primary operation. Pass a Prisma tx client to record inside a transaction.
 */
export async function audit(
    params: {
        depotId?: string | null;
        userId?: string | null;
        action: string;
        entity?: string;
        entityId?: string;
        meta?: any;
    },
    tx?: any
): Promise<void> {
    try {
        const client = tx ?? prisma;
        await client.auditLog.create({
            data: {
                depotId: params.depotId ?? null,
                userId: params.userId ?? null,
                action: params.action,
                entity: params.entity ?? null,
                entityId: params.entityId ?? null,
                meta: params.meta ?? undefined,
            },
        });
    } catch (err: any) {
        console.error("[audit] failed:", err?.message);
    }
}
