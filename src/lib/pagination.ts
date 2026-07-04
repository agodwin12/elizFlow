import { Request } from "express";

export interface PageParams {
    skip: number;
    take: number;
    page: number;
    pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Parse ?page & ?pageSize (or ?limit) query params into safe Prisma skip/take.
 */
export function getPagination(req: Request): PageParams {
    let page = parseInt(String(req.query.page ?? "1"), 10);
    let pageSize = parseInt(
        String(req.query.pageSize ?? req.query.limit ?? DEFAULT_PAGE_SIZE),
        10
    );

    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
    if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

    return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export function pageMeta(total: number, params: PageParams) {
    return {
        total,
        page: params.page,
        pageSize: params.pageSize,
        totalPages: Math.ceil(total / params.pageSize),
        hasMore: params.skip + params.take < total,
    };
}
