import { ApiError } from "./http";

/**
 * Tiny dependency-free validation helpers. Each throws ApiError.badRequest on
 * failure so it can be used directly inside an asyncHandler.
 */

export function requireFields(body: any, fields: string[]): void {
    const missing = fields.filter(
        (f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === ""
    );
    if (missing.length) {
        throw ApiError.badRequest(
            `Missing required field(s): ${missing.join(", ")}`,
            "VALIDATION_ERROR",
            { missing }
        );
    }
}

export function toPositiveInt(value: any, field: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw ApiError.badRequest(`${field} must be a positive whole number`, "VALIDATION_ERROR");
    }
    return n;
}

export function toNonNegativeNumber(value: any, field: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw ApiError.badRequest(`${field} must be a number >= 0`, "VALIDATION_ERROR");
    }
    return n;
}

export function toNonNegativeInt(value: any, field: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw ApiError.badRequest(`${field} must be a whole number >= 0`, "VALIDATION_ERROR");
    }
    return n;
}

export function optionalNumber(value: any, field: string): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw ApiError.badRequest(`${field} must be a number`, "VALIDATION_ERROR");
    }
    return n;
}

export function oneOf<T extends string>(value: any, allowed: T[], field: string): T {
    if (!allowed.includes(value)) {
        throw ApiError.badRequest(
            `${field} must be one of: ${allowed.join(", ")}`,
            "VALIDATION_ERROR"
        );
    }
    return value as T;
}
