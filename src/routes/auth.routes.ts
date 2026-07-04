import { Router } from "express";
import { upload } from "../lib/upload";
import {
    login,
    refreshToken,
    logout,
    createDepot,
    changePassword,
    verifyPhone,
    verifyPasswordOtp,
    resetPassword,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
import { rateLimit } from "../middlewares/ratelimit.middleware";

const router = Router();

// Throttle credential + reset endpoints to blunt brute-force / SMS abuse.
// Tunable via env so operators can adjust for shared/NAT'd client IPs without
// a code change. Defaults protect against brute force while staying friendly to
// multiple cashiers behind one router.
const authLimiter = rateLimit({
    windowMs: (parseInt(process.env.AUTH_RATE_WINDOW_MIN || "15", 10) || 15) * 60 * 1000,
    max: parseInt(process.env.AUTH_RATE_MAX || "40", 10) || 40,
    keyPrefix: "auth",
    message: "Trop de tentatives. Réessayez dans quelques minutes.",
});

router.post("/login", authLimiter, login);
router.post("/refresh", refreshToken);
router.post("/logout", authenticate, logout);
router.post("/create-depot", upload.single("logo"), createDepot);
router.patch("/change-password", authenticate, changePassword);

// ── Forgot password (no auth required, rate limited) ─────────────
router.post("/verify-phone", authLimiter, verifyPhone);
router.post("/verify-otp", authLimiter, verifyPasswordOtp);
router.post("/reset-password", authLimiter, resetPassword);

export default router;
