import { Request, Response, NextFunction } from "express";

/**
 * A typed application error. Throw this anywhere inside an asyncHandler and the
 * global error handler will turn it into a clean JSON response.
 */
export class ApiError extends Error {
    status: number;
    code?: string;
    details?: any;

    constructor(status: number, message: string, code?: string, details?: any) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, ApiError.prototype);
    }

    static badRequest(message: string, code?: string, details?: any) {
        return new ApiError(400, message, code, details);
    }
    static unauthorized(message = "Unauthorized", code?: string) {
        return new ApiError(401, message, code);
    }
    static forbidden(message = "Access denied", code?: string) {
        return new ApiError(403, message, code);
    }
    static notFound(message = "Not found", code?: string) {
        return new ApiError(404, message, code);
    }
    static conflict(message: string, code?: string) {
        return new ApiError(409, message, code);
    }
}

/**
 * Wrap an async route handler so any thrown/rejected error is forwarded to the
 * Express error handler instead of crashing the process or hanging the request.
 */
export const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
    (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
