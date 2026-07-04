import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
    openShift,
    getCurrentShift,
    closeShift,
    getShifts,
    getShiftReport,
} from "../controllers/register.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post("/open", openShift);
router.get("/current", getCurrentShift);
router.get("/", getShifts);
router.get("/:id", getShiftReport);
router.patch("/:id/close", closeShift);

export default router;
