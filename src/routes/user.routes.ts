import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { upload } from "../lib/upload";
import {
    createUser,
    getUsers,
    getUser,
    updateUser,
    resetPassword,
    deactivateUser,
    saveFcmToken,
} from "../controllers/user.controller";

const router = Router();

router.use(authenticate);

router.post("/", upload.single("avatar"), createUser);
router.get("/", getUsers);
router.get("/:id", getUser);
router.put("/:id", upload.single("avatar"), updateUser);
router.patch("/:id/reset-password", resetPassword);
router.delete("/:id", deactivateUser);
router.post("/fcm-token", saveFcmToken);

export default router;