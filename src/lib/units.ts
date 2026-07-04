import { ApiError } from "./http";

export type UnitType = "PACKAGE" | "HALF" | "UNIT";

export interface PricedProduct {
    id: string;
    name: string;
    stock: number; // base units
    packSize: number;
    sellingPrice: number; // package price
    costPrice: number; // package cost
    unitSellingPrice: number | null;
    unitCostPrice: number | null;
    halfPackagePrice: number | null;
    sellByPackage: boolean;
    sellByHalf: boolean;
    sellByUnit: boolean;
}

/**
 * How many base units a single item of the given unit type represents.
 * PACKAGE -> packSize, HALF -> packSize/2, UNIT -> 1.
 */
export function baseUnitsPerItem(product: PricedProduct, unitType: UnitType): number {
    const packSize = product.packSize > 0 ? product.packSize : 1;
    switch (unitType) {
        case "PACKAGE":
            return packSize;
        case "HALF":
            return packSize / 2;
        case "UNIT":
            return 1;
    }
}

/**
 * Resolve the selling price and cost for one item of the requested unit type,
 * validating that the product is actually allowed to be sold that way.
 */
export function resolveLinePricing(
    product: PricedProduct,
    unitType: UnitType
): { unitPrice: number; unitCost: number; basePerItem: number } {
    const packSize = product.packSize > 0 ? product.packSize : 1;

    if (unitType === "PACKAGE") {
        if (!product.sellByPackage) {
            throw ApiError.badRequest(
                `${product.name} cannot be sold by package`,
                "UNIT_NOT_ALLOWED"
            );
        }
        return {
            unitPrice: product.sellingPrice,
            unitCost: product.costPrice,
            basePerItem: packSize,
        };
    }

    if (unitType === "HALF") {
        if (!product.sellByHalf) {
            throw ApiError.badRequest(
                `${product.name} cannot be sold as a half package`,
                "UNIT_NOT_ALLOWED"
            );
        }
        if (packSize % 2 !== 0) {
            throw ApiError.badRequest(
                `${product.name} has an odd pack size and cannot be split in half`,
                "PACK_NOT_DIVISIBLE"
            );
        }
        const price =
            product.halfPackagePrice ??
            (product.unitSellingPrice != null
                ? product.unitSellingPrice * (packSize / 2)
                : product.sellingPrice / 2);
        const cost =
            product.unitCostPrice != null
                ? product.unitCostPrice * (packSize / 2)
                : product.costPrice / 2;
        return { unitPrice: price, unitCost: cost, basePerItem: packSize / 2 };
    }

    // UNIT
    if (!product.sellByUnit) {
        throw ApiError.badRequest(
            `${product.name} cannot be sold by the unit`,
            "UNIT_NOT_ALLOWED"
        );
    }
    if (product.unitSellingPrice == null) {
        throw ApiError.badRequest(
            `${product.name} has no unit price configured`,
            "UNIT_PRICE_MISSING"
        );
    }
    return {
        unitPrice: product.unitSellingPrice,
        unitCost:
            product.unitCostPrice != null
                ? product.unitCostPrice
                : product.costPrice / packSize,
        basePerItem: 1,
    };
}

/**
 * Human friendly stock, e.g. { packages: 3, remainder: 6, label: "3 CASIER + 6 UNITE" }.
 */
export function describeStock(
    stockBase: number,
    packSize: number,
    packageUnit: string,
    baseUnit: string
): { packages: number; remainder: number; label: string } {
    const size = packSize > 0 ? packSize : 1;
    const packages = Math.floor(stockBase / size);
    const remainder = stockBase % size;
    if (size === 1) {
        return { packages: stockBase, remainder: 0, label: `${stockBase} ${packageUnit}` };
    }
    const parts: string[] = [];
    if (packages > 0) parts.push(`${packages} ${packageUnit}`);
    if (remainder > 0) parts.push(`${remainder} ${baseUnit}`);
    return {
        packages,
        remainder,
        label: parts.length ? parts.join(" + ") : `0 ${packageUnit}`,
    };
}

/** Round money to 2 decimals to avoid floating point drift. */
export function money(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}
