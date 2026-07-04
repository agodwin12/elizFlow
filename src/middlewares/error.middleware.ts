import { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/http";

/** 404 handler for unmatched routes. */
export const notFoundHandler = (req: Request, res: Response) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
};

/** Centralised error handler. Must be registered last, after all routes. */
export const errorHandler = (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
) => {
    // Known application errors
    if (err instanceof ApiError) {
        return res.status(err.status).json({
            message: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.details ? { details: err.details } : {}),
        });
    }

    // Multer file-size / upload errors
    if (err?.name === "MulterError") {
        return res.status(400).json({ message: err.message, code: "UPLOAD_ERROR" });
    }

    // Prisma known request errors
    if (err?.code === "P2002") {
        return res.status(409).json({
            message: "A record with these details already exists",
            code: "UNIQUE_VIOLATION",
        });
    }
    if (err?.code === "P2025") {
        return res.status(404).json({ message: "Record not found", code: "NOT_FOUND" });
    }

    // JSON body parse errors
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
        return res.status(400).json({ message: "Invalid JSON body", code: "BAD_JSON" });
    }

    console.error("❌ Unhandled error:", err?.message);
    if (err?.stack) console.error(err.stack);
    return res.status(500).json({ message: "Server error" });
};
