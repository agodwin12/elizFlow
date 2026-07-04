import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.routes';
import productRoutes from './routes/product.routes';
import customerRoutes from './routes/customer.routes';
import saleRoutes from './routes/sale.routes';
import paymentRoutes from './routes/payment.routes';
import userRoutes from './routes/user.routes';
import stockRoutes from './routes/stock.routes';
import reportRoutes from './routes/report.routes';
import adminRoutes from './routes/admin.routes';
import forecastRoutes from './routes/forecast.routes';
import cancellationRoutes from './routes/cancellation.routes';
import deliveryRoutes from './routes/delivery.routes';
import returnRoutes from './routes/return.routes';
import registerRoutes from './routes/register.routes';
import expenseRoutes from './routes/expense.routes';
import supplierRoutes from './routes/supplier.routes';
import stockCountRoutes from './routes/stockcount.routes';

import { requestLogger } from './middlewares/logger.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { prisma } from './lib/prisma';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────
app.set('trust proxy', 1); // behind nginx – needed for correct client IP / rate limiting
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// ── Health & readiness ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', project: 'ElizFlow API', version: '2.0.0' });
});

app.get('/ready', async (_req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'ready', db: 'up' });
    } catch (err: any) {
        res.status(503).json({ status: 'not-ready', db: 'down', error: err?.message });
    }
});

// ── Routes ─────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api', cancellationRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/register', registerRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/stock-counts', stockCountRoutes);

// ── 404 + centralised error handler (must be last) ─────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Global safety nets ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason: any) => {
    console.error('❌ UNHANDLED REJECTION:', reason?.message || reason);
    console.error(reason?.stack);
});

// ── Start server ───────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`🚀 ElizFlow API running on port ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health`);
});

server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Run: npx kill-port ${PORT}`);
    } else {
        console.error('❌ Server error:', err);
    }
    process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────
const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(async () => {
        try {
            await prisma.$disconnect();
        } catch {
            /* ignore */
        }
        console.log('✅ Closed out remaining connections. Bye.');
        process.exit(0);
    });
    // Force-exit if it hangs.
    setTimeout(() => {
        console.error('⏱️  Forced shutdown after timeout.');
        process.exit(1);
    }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
