import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
    createStockCount,
    applyStockCount,
    getStockCounts,
    getStockCount,
} from "../controllers/stockcount.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post("/", createStockCount);
router.get("/", getStockCounts);
router.get("/:id", getStockCount);
router.patch("/:id/apply", applyStockCount);

export default router;
