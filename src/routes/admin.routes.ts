import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    getAllDepots,
    getDepotDetail,
    getCombinedStats,
    toggleDepotStatus,
    deleteDepot,
} from "../controllers/admin.controller";
import {
    blockDepot,
    unblockDepot,
    updateSubscription,
    recordSubscriptionPayment,
    getSubscriptionPayments,
    getSubscriptionOverview,
} from "../controllers/subscription.controller";

const router = Router();

router.use(authenticate);

// ── Depot management ─────────────────────────────────────────────
router.get("/depots", getAllDepots);
router.get("/depots/:id", getDepotDetail);
router.get("/stats", getCombinedStats);
router.patch("/depots/:id/toggle", toggleDepotStatus);
router.delete("/depots/:id", deleteDepot);

// ── Subscription / billing management ────────────────────────────
router.get("/subscriptions", getSubscriptionOverview);
router.get("/depots/:id/subscription/payments", getSubscriptionPayments);
router.patch("/depots/:id/subscription", updateSubscription);
router.post("/depots/:id/subscription/pay", recordSubscriptionPayment);
router.post("/depots/:id/block", blockDepot);
router.post("/depots/:id/unblock", unblockDepot);

export default router;
