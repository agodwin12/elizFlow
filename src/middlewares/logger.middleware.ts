import { Request, Response, NextFunction } from "express";

/**
 * Minimal structured request logger. Logs method, path, status and duration.
 * Avoids logging bodies (which may contain passwords / PII).
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
        const ms = Date.now() - start;
        const uid = req.user?.userId ? ` user=${req.user.userId}` : "";
        console.log(
            `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms${uid}`
        );
    });
    next();
};
