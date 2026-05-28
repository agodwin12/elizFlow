import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../lib/upload";
import {
    createCustomer,
    getCustomers,
    getCustomer,
    updateCustomer,
    uploadCustomerPhoto,
    deleteCustomer,
} from "../controllers/customer.controller";

const router = Router();

router.use(authenticate);

router.post("/", createCustomer);
router.get("/", getCustomers);
router.get("/:id", getCustomer);
router.put("/:id", updateCustomer);
router.patch("/:id/photo", upload.single("photo"), uploadCustomerPhoto);
router.delete("/:id", deleteCustomer);

export default router;