import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    getAllDepots,
    getDepotDetail,
    getCombinedStats,
    toggleDepotStatus,
    deleteDepot,
} from "../controllers/admin.controller";

const router = Router();

router.use(authenticate);

router.get("/depots", getAllDepots);
router.get("/depots/:id", getDepotDetail);
router.get("/stats", getCombinedStats);
router.patch("/depots/:id/toggle", toggleDepotStatus);
router.delete("/depots/:id", deleteDepot);

export default router;