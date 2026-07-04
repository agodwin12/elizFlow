import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
    createExpense,
    getExpenses,
    deleteExpense,
} from "../controllers/expense.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post("/", createExpense);
router.get("/", getExpenses);
router.delete("/:id", deleteExpense);

export default router;
