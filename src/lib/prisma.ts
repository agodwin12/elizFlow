import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Connection pool. Tunable via env so the pool can be sized to the VPS Postgres
// (max_connections) and the number of app instances. Defaults are safe.
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '15', 10) || 15,
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000', 10) || 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONN_TIMEOUT_MS || '10000', 10) || 10000,
});

pool.on('error', (err) => {
    console.error('❌ Postgres pool error:', err.message);
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}