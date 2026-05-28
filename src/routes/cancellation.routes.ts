import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    cancelSale,
    getCancelledSales,
    checkCancellability,
} from "../controllers/cancellation.controller";

const router = Router();

router.use(authenticate);

router.post("/sales/:id/cancel", cancelSale);
router.get("/sales/:id/can-cancel", checkCancellability);
router.get("/cancelled", getCancelledSales);

export default router;