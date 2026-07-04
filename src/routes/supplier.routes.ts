import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { requireActiveSubscription } from "../middlewares/subscription.middleware";
import {
    createSupplier,
    getSuppliers,
    updateSupplier,
    deleteSupplier,
} from "../controllers/supplier.controller";

const router = Router();

router.use(authenticate);
router.use(requireActiveSubscription);

router.post("/", createSupplier);
router.get("/", getSuppliers);
router.put("/:id", updateSupplier);
router.delete("/:id", deleteSupplier);

export default router;
