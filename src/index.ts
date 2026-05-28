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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', project: 'DepotFlow API' });
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

// ── Global error handlers ──────────────────────────────────────────
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
    console.log(`🚀 DepotFlow API running on port ${PORT}`);
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

export default app;