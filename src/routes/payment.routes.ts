import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    recordPayment,
    getPayments,
    getCustomerPayments,
    getDebtors,
} from "../controllers/payment.controller";

const router = Router();

router.use(authenticate);

router.post("/", recordPayment);
router.get("/", getPayments);
router.get("/debtors", getDebtors);
router.get("/customer/:customerId", getCustomerPayments);

export default router;