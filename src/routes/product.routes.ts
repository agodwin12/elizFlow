import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../lib/upload";
import {
    createProduct,
    getProducts,
    getProduct,
    updateProduct,
    adjustStock,
    deleteProduct,
} from "../controllers/product.controller";

const router = Router();

router.use(authenticate); // all routes require login

router.post("/", upload.single("image"), createProduct);
router.get("/", getProducts);
router.get("/:id", getProduct);
router.put("/:id", upload.single("image"), updateProduct);
router.patch("/:id/stock", adjustStock);
router.delete("/:id", deleteProduct);

export default router;