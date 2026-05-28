import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
    getDashboard,
    getSalesReport,
    getTopProductsReport,
    getEmployeeReport,
} from "../controllers/report.controller";

const router = Router();

router.use(authenticate);

router.get("/dashboard", getDashboard);
router.get("/sales", getSalesReport);
router.get("/top-products", getTopProductsReport);
router.get("/employees", getEmployeeReport);

export default router;