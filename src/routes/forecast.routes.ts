import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { getDemandForecast } from "../controllers/forecast.controller";

const router = Router();

router.use(authenticate);
router.get("/", getDemandForecast);

export default router;