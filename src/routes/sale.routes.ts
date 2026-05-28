import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    createSale,
    getSales,
    getSale,
    getSalesSummary,
} from "../controllers/sale.controller";

const router = Router();

router.use(authenticate);

router.post("/", createSale);
router.get("/", getSales);
router.get("/summary", getSalesSummary);
router.get("/:id", getSale);

export default router;