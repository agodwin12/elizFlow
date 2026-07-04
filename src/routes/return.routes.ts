import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import { createReturn, getReturns } from "../controllers/return.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.get("/", getReturns);
router.post("/sale/:saleId", createReturn);

export default router;
