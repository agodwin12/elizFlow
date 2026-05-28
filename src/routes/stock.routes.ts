import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    restockProduct,
    logDamage,
    returnCrates,
    correctStock,
    getStockMovements,
    getLowStockAlerts,
} from "../controllers/stock.controller";

const router = Router();

router.use(authenticate);

router.post("/restock", restockProduct);
router.post("/damage", logDamage);
router.post("/return", returnCrates);
router.post("/correct", correctStock);
router.get("/movements", getStockMovements);
router.get("/alerts", getLowStockAlerts);

export default router;