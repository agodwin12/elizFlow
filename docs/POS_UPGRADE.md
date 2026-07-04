# ElizFlow POS Backend — Upgrade Notes

This document describes the multi-unit + subscription upgrade and the new API
surface. The upgrade is **backward compatible**: existing products (whole
crates) and the existing sale API keep working unchanged.

## 1. Units & packaging (sell crates, half-crates OR single bottles)

Stock is now tracked internally in **base units** (e.g. bottles). Each product
defines how it is packaged and which selling modes are allowed.

### Product fields

| Field | Meaning |
|---|---|
| `packSize` | base units per package, e.g. `12` bottles per crate. `1` = simple product (a crate is its own base unit — legacy behaviour). |
| `baseUnit` | label of the smallest unit, e.g. `BOUTEILLE`. |
| `packageUnit` | label of the package, e.g. `CASIER`. |
| `sellingPrice` / `costPrice` | price/cost of one **package** (crate). |
| `unitSellingPrice` / `unitCostPrice` | price/cost of one **base unit** (bottle). Required if `sellByUnit`. |
| `halfPackagePrice` | optional explicit half-crate price. Otherwise derived. |
| `sellByPackage` / `sellByHalf` / `sellByUnit` | which modes are allowed. `sellByHalf` needs an even `packSize`. |
| `stock` | current stock **in base units**. |
| `stockDescription` | server-computed, e.g. `{ packages: 8, remainder: 6, label: "8 CASIER + 6 BOUTEILLE" }`. |
| `sku`, `barcode`, `supplierId` | optional. |

### Creating / updating products

When creating/updating, `stock` (and restock/correct quantities) accept a
`stockUnit` field:
- `stockUnit: "PACKAGE"` (default) — the number is in crates and is multiplied by `packSize`.
- `stockUnit: "BASE"` — the number is already in base units.

Changing `packSize` on an existing product auto-converts its stock so the
physical quantity is unchanged (e.g. 10 crates → 120 bottles when 1→12).

### Business type (`Depot.businessType`)

`DEPOT` (crate-first) · `BAR` / `RETAIL` (unit-first) · `HYBRID`. This is a hint
for the app's default UI; any depot can sell in any allowed unit.

## 2. Selling — `POST /api/sales`

```jsonc
{
  "customerId": "optional",
  "status": "COMPLETED",          // or "HELD" (parked cart) / "OPEN" (bar tab)
  "discount": 200,                 // optional sale-level discount
  "note": "optional",
  "tabLabel": "Table 4",           // optional (held/tab)
  "items": [
    { "productId": "...", "unitType": "PACKAGE", "quantity": 1, "discount": 0 },
    { "productId": "...", "unitType": "HALF",    "quantity": 1 },
    { "productId": "...", "unitType": "UNIT",    "quantity": 5 }
  ],
  "payments": [                    // split payments; or legacy amountPaid/paymentType
    { "amount": 600, "paymentType": "CASH" },
    { "amount": 600, "paymentType": "MTN_MONEY" }
  ]
}
```

`unitType` is `PACKAGE` | `HALF` | `UNIT`. Stock is deducted in base units and is
**oversell-safe under concurrency** (atomic conditional decrement).

Payment types: `CASH`, `MOBILE_MONEY`, `MTN_MONEY`, `ORANGE_MONEY`, `CARD`,
`BANK`, `CREDIT`.

### Held sales / bar tabs

| Endpoint | Purpose |
|---|---|
| `POST /api/sales` with `status:"HELD"` | park a cart (no stock/payment yet) |
| `POST /api/sales` with `status:"OPEN"` | open a tab (stock deducted, pay later) |
| `GET  /api/sales/held?status=HELD|OPEN` | list held carts / open tabs |
| `POST /api/sales/:id/items` | add items to an open tab |
| `POST /api/sales/:id/payments` | add a payment / settle |
| `POST /api/sales/:id/checkout` | finalise a held cart or tab → COMPLETED |
| `DELETE /api/sales/:id/held` | discard a parked cart |
| `GET  /api/sales/:id/receipt` | structured receipt payload |

## 3. Returns / refunds — `POST /api/returns/sale/:saleId`

```jsonc
{
  "items": [ { "productId": "...", "unitType": "UNIT", "quantity": 2 } ],
  "reason": "changed mind",
  "refundMethod": "CASH",   // or "CREDIT" to reduce the customer's debt
  "restock": true
}
```
Supports partial returns (can't return more than sold minus already returned).
`GET /api/returns` lists them.

## 4. Cash register / shift (Z-report)

| Endpoint | |
|---|---|
| `POST /api/register/open` `{ openingFloat }` | open a shift |
| `GET  /api/register/current` | current shift + live totals |
| `PATCH /api/register/:id/close` `{ closingCounted }` | close + Z-report (expected vs counted) |
| `GET  /api/register` · `GET /api/register/:id` | list / report |

## 5. Expenses — `/api/expenses`

`POST { category, amount, description }` · `GET` (paginated, `byCategory`
summary) · `DELETE /:id`.

## 6. Suppliers — `/api/suppliers` (CRUD) · Stock-take — `/api/stock-counts`

`POST /api/stock-counts { items:[{productId, countedStock}] }` records a count,
`PATCH /api/stock-counts/:id/apply` writes variances as corrections.

## 7. Subscription & account blocking (super admin)

Depots carry a subscription (`TRIAL/ACTIVE/PAST_DUE/BLOCKED/EXPIRED`,
`subscriptionEndsAt`, grace period). A blocked/expired depot's users are
refused at **login** and by a **route guard** with:

```json
{ "message": "Votre abonnement est inactif. Veuillez vous abonner…",
  "code": "SUBSCRIPTION_REQUIRED" }
```

Super-admin endpoints:

| Endpoint | |
|---|---|
| `GET  /api/admin/subscriptions` | overview with computed status |
| `POST /api/admin/depots/:id/block` `{ reason }` | block (e.g. non-payment) |
| `POST /api/admin/depots/:id/unblock` | unblock |
| `PATCH /api/admin/depots/:id/subscription` | set plan / status / end date |
| `POST /api/admin/depots/:id/subscription/pay` `{ amount, periodDays }` | record a payment, extend & re-activate |
| `GET  /api/admin/depots/:id/subscription/payments` | payment ledger |

## 8. Security & scale

- OTP-verified password reset via SMS (`/api/auth/verify-phone` sends a code,
  `/api/auth/verify-otp`, and `/api/auth/reset-password` accepts a `code`).
  Legacy code-less reset stays enabled until `ALLOW_LEGACY_RESET=false`.
- Atomic stock (no overselling), rate-limited auth, global error handler,
  request logging, pagination on list endpoints, `/health` + `/ready`,
  graceful shutdown, non-root Docker image with healthcheck.

## 9. Migration & deploy

Migration `20260704021419_pos_units_subscription_modules` is additive (new
columns have defaults, new tables) and backfills legacy rows. Deploy with
`deploy/deploy.sh` on the VPS — it backs up the DB, applies the migration to
the existing Postgres, and rebuilds the container.
