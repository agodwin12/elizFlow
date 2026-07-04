# ElizFlow Mobile (Flutter) — Integration & Screens Checklist

Companion to `docs/POS_UPGRADE.md` (full API reference). This lists the screens
to add / fix in the Flutter app so it uses the upgraded backend. Grouped by
priority. Base URL unchanged; all endpoints require `Authorization: Bearer`.

## 0. Global / breaking-safe notes
- **Nothing forces a break**: legacy product/sale calls still work (packSize=1,
  whole-crate sale via `amountPaid`/`paymentType`). Adopt new fields incrementally.
- Login now returns a `subscription` object (`{status, pastDue, message}`) and can
  return **403 `SUBSCRIPTION_REQUIRED`** — handle both (see §1).
- List endpoints now support `?page=&pageSize=` and return `pagination`
  (`{total,page,pageSize,totalPages,hasMore}`). Products list stays unpaginated
  when no page param is sent (backward compatible) — add infinite scroll where useful.

## 1. Auth & subscription  (HIGH)
- **Login screen**: on `403 {code:"SUBSCRIPTION_REQUIRED"}` → show a
  “Please subscribe” blocking screen with the returned `message` (FR). Same code
  can come back from any API call mid-session (route guard) → route user to that
  screen and clear the session.
- **Past-due banner**: if `login.subscription.pastDue == true`, show a dismissible
  banner using `subscription.message`.
- **Password reset (OTP)**: 3-step flow —
  1. `POST /api/auth/verify-phone {phone}` → sends SMS code (`otpSent`, `otpRequired`).
  2. `POST /api/auth/verify-otp {phone, code}` (optional pre-check).
  3. `POST /api/auth/reset-password {phone, newPassword, code}`.
  Keep the old code-less path working until backend `ALLOW_LEGACY_RESET=false`.

## 2. Products — multi-unit  (HIGH)
- **Product form** (create/edit): add fields
  `packSize`, `baseUnit`, `packageUnit`, `unitSellingPrice`, `unitCostPrice`,
  `halfPackagePrice`, toggles `sellByPackage/sellByHalf/sellByUnit`, `sku`, `barcode`,
  `supplierId`. Send `stock` with `stockUnit` (`PACKAGE` default | `BASE`).
  Validation: `sellByHalf` needs even `packSize`; `sellByUnit` needs `unitSellingPrice`.
- **Product list/detail**: show `stockDescription.label` (e.g. “8 CASIER + 6 BOUTEILLE”).
- **Business type** at depot setup (`DEPOT/BAR/RETAIL/HYBRID`) to pick default sell mode.

## 3. Sales / cart — unit picker  (HIGH)
- **Cart line**: add a **unit selector** (Crate / Half / Bottle) per line, filtered to
  the product’s allowed modes; price updates from the matching price field.
  Send items as `{productId, unitType: PACKAGE|HALF|UNIT, quantity, discount?}`.
- **Discounts**: per-line `discount` and sale-level `discount`.
- **Split / mobile-money payments**: `payments: [{amount, paymentType}]` with
  `CASH/MTN_MONEY/ORANGE_MONEY/MOBILE_MONEY/CARD/BANK`. Legacy single `amountPaid` still ok.
- Handle new error codes: `INSUFFICIENT_STOCK`, `CREDIT_LIMIT_EXCEEDED`,
  `UNIT_NOT_ALLOWED`, `UNIT_PRICE_MISSING`, `CUSTOMER_REQUIRED`.

## 4. Held sales & bar tabs  (MEDIUM — key for bars)
- **Hold cart**: `POST /api/sales {status:"HELD", tabLabel}`.
- **Open tab**: `POST /api/sales {status:"OPEN", tabLabel}` (deducts stock now).
- **Held/Tabs screen**: `GET /api/sales/held?status=HELD|OPEN`; actions:
  add items `POST /api/sales/:id/items`, add payment `POST /api/sales/:id/payments`,
  checkout `POST /api/sales/:id/checkout`, discard `DELETE /api/sales/:id/held`.

## 5. Receipts  (MEDIUM)
- **Receipt screen / print**: `GET /api/sales/:id/receipt` returns a structured
  payload (depot, receiptNumber, items with `unitLabel`, totals, payments, currency).

## 6. Returns / refunds  (MEDIUM)
- From a completed sale: `POST /api/returns/sale/:saleId` with
  `{items:[{productId,unitType,quantity}], reason, refundMethod: CASH|CREDIT, restock}`.
- **Returns history**: `GET /api/returns`.

## 7. Cash register / shift  (MEDIUM)
- **Shift screen**: open `POST /api/register/open {openingFloat}`, live
  `GET /api/register/current`, close `PATCH /api/register/:id/close {closingCounted}`
  → show Z-report (expected vs counted, variance, payments by method).
- History: `GET /api/register`, report `GET /api/register/:id`.

## 8. Expenses / Suppliers / Stock-take  (LOW→MEDIUM)
- **Expenses**: `POST /api/expenses {category,amount,description}`, `GET /api/expenses`
  (has `byCategory`). Surface net profit = gross profit − expenses on dashboard.
- **Suppliers**: CRUD `/api/suppliers`; link on product form and restock.
- **Stock-take**: `POST /api/stock-counts {items:[{productId,countedStock}]}` →
  review variance → `PATCH /api/stock-counts/:id/apply`.
- **Restock/adjust**: now accept `stockUnit` (PACKAGE|BASE) and `supplierId`.

## 9. Super-admin app area (subscription mgmt)  (MEDIUM)
- Overview `GET /api/admin/subscriptions` (effectiveStatus, daysRemaining).
- Block `POST /api/admin/depots/:id/block {reason}` / unblock `/unblock`.
- Record payment `POST /api/admin/depots/:id/subscription/pay {amount, periodDays}`.
- Update `PATCH /api/admin/depots/:id/subscription`; ledger `…/subscription/payments`.

## Suggested build order for the next session
1. Subscription-block handling + login `subscription` field (unblocks everything).
2. Product multi-unit form + `stockDescription`.
3. Cart unit-picker + split payments + discounts.
4. Receipts.
5. Held/tabs, returns, register, then expenses/suppliers/stock-take.
6. Super-admin subscription screens.
