import { Router } from "express";
import { upload } from "../lib/upload";
import {
    login,
    refreshToken,
    logout,
    createDepot,
    changePassword,
    verifyPhone,
    resetPassword,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

router.post("/login", login);
router.post("/refresh", refreshToken);
router.post("/logout", authenticate, logout);
router.post("/create-depot", upload.single("logo"), createDepot);
router.patch("/change-password", authenticate, changePassword);

// ── Forgot password (no auth required) ───────────────────────────
router.post("/verify-phone", verifyPhone);
router.post("/reset-password", resetPassword);

export default router;