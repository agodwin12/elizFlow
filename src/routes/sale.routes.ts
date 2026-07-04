import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
    createSale,
    checkoutSale,
    addItemsToTab,
    addSalePayment,
    getHeldSales,
    deleteHeldSale,
    getSales,
    getSale,
    getSalesSummary,
} from "../controllers/sale.controller";
import { getReceipt } from "../controllers/receipt.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post("/", createSale);
router.get("/", getSales);
router.get("/summary", getSalesSummary);
router.get("/held", getHeldSales); // ?status=HELD|OPEN
router.post("/:id/checkout", checkoutSale);
router.post("/:id/items", addItemsToTab);
router.post("/:id/payments", addSalePayment);
router.delete("/:id/held", deleteHeldSale);
router.get("/:id/receipt", getReceipt);
router.get("/:id", getSale);

export default router;
