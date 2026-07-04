import { Request, Response, NextFunction } from "express";

/**
 * Lightweight in-memory fixed-window rate limiter. Good enough to blunt
 * brute-force/abuse on a single instance. For multi-instance horizontal scaling
 * swap the Map for a shared Redis store (interface is intentionally small).
 */
interface Bucket {
    count: number;
    resetAt: number;
}

export function rateLimit(options: {
    windowMs: number;
    max: number;
    keyPrefix?: string;
    message?: string;
}) {
    const { windowMs, max, keyPrefix = "rl", message } = options;
    const store = new Map<string, Bucket>();

    // Periodically evict expired buckets so the map does not grow unbounded.
    const interval = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of store) {
            if (bucket.resetAt <= now) store.delete(key);
        }
    }, windowMs);
    // Do not keep the process alive just for cleanup.
    if (typeof interval.unref === "function") interval.unref();

    return (req: Request, res: Response, next: NextFunction) => {
        const ip =
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress ||
            "unknown";
        const key = `${keyPrefix}:${ip}`;
        const now = Date.now();

        let bucket = store.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            store.set(key, bucket);
        }

        bucket.count += 1;

        const remaining = Math.max(0, max - bucket.count);
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(remaining));

        if (bucket.count > max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                message: message || "Too many requests. Please try again later.",
                code: "RATE_LIMITED",
                retryAfter,
            });
        }

        next();
    };
}
