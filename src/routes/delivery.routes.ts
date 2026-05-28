import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import {
    createTournee,
    dispatchTournee,
    confirmStop,
    closeTournee,
    getTournees,
    getTourneeById,
} from '../controllers/delivery.controller';

const router = Router();

router.use(authenticate);

// ─── TOURNEE ROUTES ───────────────────────────────────────────
router.post('/', createTournee);                        // Owner/Cashier creates a tournee
router.get('/', getTournees);                           // Owner sees all, driver sees his
router.get('/:id', getTourneeById);                     // Single tournee detail
router.patch('/:id/dispatch', dispatchTournee);         // Owner/Cashier dispatches
router.patch('/:id/close', closeTournee);               // Driver or Owner closes trip

// ─── STOP ROUTES ──────────────────────────────────────────────
router.patch('/stops/:stopId/confirm', confirmStop);    // Driver confirms each stop

export default router;