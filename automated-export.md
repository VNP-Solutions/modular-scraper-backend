# Master Export Sheet Format

Reference for the CSV files produced by:

- `POST /jobs/export-master`              — bulk export, returns a ZIP of one CSV per job
- `GET  /jobs/:id/export-master`          — single-job CSV
- `GET  /jobs/export-master/by-recurring` — bulk export filtered by recurring fields, also returns a ZIP

All three endpoints share the same row builder (`buildMasterRows` in
`src/module/job/master-export.util.ts`), so the CSV format is identical.

This document is the contract an importer (sheet-upload feature) should
follow when reading these CSVs back into the database.

---

## 1. CSV column layout per OTA

Each CSV in a master export represents **one job**. Every job has exactly
one `ota_provider`, so each CSV represents one OTA. The header changes
based on that OTA.

### 1.1 Expedia CSV

```
 1.  OTA
 2.  OTA Posting Type
 3.  OTA ID
 4.  Batch
 5.  Review Collection Date
 6.  Portfolio
 7.  Property Name
 8.  Reservation ID
 9.  Hotel Confirmation Code
10.  Guest name
11.  Check In
12.  Check Out
13.  Charge Before
14.  Currency
15.  Booking Amount
16.  Amount to Charge
17.  Card Status
18.  Card Number
19.  Expiry date
20.  CVV
21.  Due to Property
22.  Due to VNP/Invoice
23.  Processor (DBMS Based on OTA)
24.  QP Username (From DBMS)
25.  Case Contact (From DBMS)
26.  Reporting Contact (From DBMS)
27.  Card Activity                              ← Expedia only
28.  Calculated Amount to Charge                ← Expedia only (DERIVED)
29.  Amount Match                               ← Expedia only (DERIVED)
30.  Card Activity Approved Amount 1            ← Expedia only (DERIVED)
31.  Card Activity Approved Amount 2            ← only if any row has ≥ 2 approved auths
...  Card Activity Approved Amount N            ← N = max approved auths in this CSV
```

### 1.2 Booking CSV

```
 1.  OTA
 2.  OTA Posting Type
 3.  OTA ID
 4.  Batch
 5.  Review Collection Date
 6.  Portfolio
 7.  Property Name
 8.  Reservation ID
 9.  Hotel Confirmation Code
10.  Guest name
11.  Check In
12.  Check Out
13.  Charge Before
14.  Currency
15.  Booking Amount
16.  Amount to Charge
17.  Card Status
18.  Card Number
19.  Expiry date
20.  CVV
21.  Due to Property
22.  Due to VNP/Invoice
23.  Processor (DBMS Based on OTA)
24.  QP Username (From DBMS)
25.  Case Contact (From DBMS)
26.  Reporting Contact (From DBMS)
```

(No Card Activity / Calculated / Amount Match / Approved Amount columns.)

### 1.3 Agoda CSV

Same as Booking — only the 26 static columns. No Card Activity / Calculated
Amount to Charge / Amount Match / Approved Amount columns.

---

## 2. Per-column reference (all OTAs)

For each column we list:

- **Source on export** — where the value comes from in the database.
- **Format** — how the value is rendered in the cell.
- **Per-OTA value** — what each OTA writes (`field` = real value from the
  source, `"N/A"` literal, or `""` blank).
- **Importer action** — what an upload should do:
  - `INPUT` — read this cell, parse it, and write it to the database.
  - `IGNORE` — never read on upload (constant, derived, or unmapped).
  - `INPUT (parse)` — read it, but reverse a transformation first.

Legend:

- `job` — `Job` row (Prisma `Job` model)
- `item` — `JobItem` row
- `property` — `job.property` relation (Prisma `Property` model)
- `batch` — `job.batch` relation
- `portfolio` — `job.portfolio` relation

### Column 1 — `OTA`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `job.ota_provider` | `job.ota_provider` | `job.ota_provider` |
| Format | enum string | enum string | enum string |
| Value | `"Expedia"` | `"Booking"` | `"Agoda"` |

**Importer:** INPUT — used to dispatch the parser branch. Must equal the
sheet's expected OTA.

### Column 2 — `OTA Posting Type`

| | All OTAs |
|---|---|
| Source | `job.posting_type` (Prisma enum: `OTA` or `OTA_PLUS`) |
| Format | display string: `"OTA"` or `"OTA Post"` |
| Mapping | `OTA → "OTA"`, `OTA_PLUS → "OTA Post"`, null → `""` |

**Importer:** INPUT — reverse-map: `"OTA Post" → OTA_PLUS`, otherwise `OTA`.

### Column 3 — `OTA ID`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `property.expedia_id` | `property.booking_id` | `property.agoda_id` |
| Format | integer | integer | integer |
| Fallback when null | `""` | `""` | `""` |

**Importer:** INPUT — used to look up the `Property` for the right OTA.

### Column 4 — `Batch`

| | All OTAs |
|---|---|
| Source | `job.batch.name` |
| Format | string |
| Fallback when null | `""` |

**Importer:** INPUT — look up the `Batch` by name.

### Column 5 — `Review Collection Date`

| | All OTAs |
|---|---|
| Source | `job.end_date` |
| Format | `"MMM dd, yyyy"` (e.g. `"Feb 28, 2026"`) |

**Importer:** INPUT (parse) — parse with `new Date(value)` (Node accepts
this format). Maps to `job.end_date`.

### Column 6 — `Portfolio`

| | All OTAs |
|---|---|
| Source | `job.portfolio_name` (falls back to `job.portfolio.name`) |
| Format | string |

**Importer:** INPUT — look up the `Portfolio` by name.

### Column 7 — `Property Name`

| | All OTAs |
|---|---|
| Source | `job.property_name` |
| Format | string |

**Importer:** INPUT — for human reference. Use the `OTA ID` (col 3) for
the actual Property link to avoid name-collision issues.

### Column 8 — `Reservation ID`

| | All OTAs |
|---|---|
| Source | `item.reservation_id` |
| Format | string |

**Importer:** INPUT — primary identifier inside a job (the schema has
`@@unique([job_id, reservation_id])`).

### Column 9 — `Hotel Confirmation Code`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `item.confirmation_number` | always `"N/A"` | always `"N/A"` |
| Format | string | literal `"N/A"` | literal `"N/A"` |

**Importer:**
- Expedia: INPUT.
- Booking / Agoda: IGNORE — value is always `"N/A"` and not a real field.

### Column 10 — `Guest name`

| | All OTAs |
|---|---|
| Source | `item.guest_name` |
| Format | string |

**Importer:** INPUT.

### Column 11 — `Check In`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `item.check_in_date` | always `"N/A"` | `item.check_in_date` |
| Format | `"MMM dd, yyyy"` | literal `"N/A"` | `"MMM dd, yyyy"` |

**Importer:**
- Expedia / Agoda: INPUT (parse) → `Date`.
- Booking: IGNORE (Booking jobs don't track per-item check-in dates).

### Column 12 — `Check Out`

Same as `Check In`:

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `item.check_out_date` | always `"N/A"` | `item.check_out_date` |
| Format | `"MMM dd, yyyy"` | literal `"N/A"` | `"MMM dd, yyyy"` |

**Importer:** Expedia / Agoda → INPUT (parse). Booking → IGNORE.

### Column 13 — `Charge Before`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | always `"N/A"` | `item.payment_info.charge_before` (falls back to `"N/A"`) | always `"N/A"` |
| Format | literal `"N/A"` | string or `"N/A"` | literal `"N/A"` |

**Importer:**
- Booking: INPUT — write to `item.payment_info.charge_before`. If cell
  equals `"N/A"`, store `null`.
- Expedia / Agoda: IGNORE.

### Column 14 — `Currency`

| | All OTAs |
|---|---|
| Source | `item.payment_info.amount_to_charge_or_refund_currency` |
| Format | currency code string |
| Fallback when null | literal `"USD"` |

**Importer:** INPUT — write to
`item.payment_info.amount_to_charge_or_refund_currency`.

### Column 15 — `Booking Amount`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `item.booking_amount` | always `"N/A"` | always `"N/A"` |
| Format | number | literal `"N/A"` | literal `"N/A"` |

**Importer:**
- Expedia: INPUT → `item.booking_amount`.
- Booking / Agoda: IGNORE.

### Column 16 — `Amount to Charge`

| | All OTAs |
|---|---|
| Source | `item.payment_info.amount_to_charge_or_refund` |
| Format | number; `""` (blank) when null |

**Importer:** INPUT — write to
`item.payment_info.amount_to_charge_or_refund`. Blank means `null`.

### Column 17 — `Card Status`

| | Expedia | Booking | Agoda |
|---|---|---|---|
| Source | `item.card_info.reason_for_charge` | always `"N/A"` | always `"N/A"` |
| Format | string (or `""` when null) | literal `"N/A"` | literal `"N/A"` |

**Importer:**
- Expedia: INPUT → `item.card_info.reason_for_charge`.
- Booking / Agoda: IGNORE.

### Column 18 — `Card Number`

| | All OTAs |
|---|---|
| Source | `item.card_info.card_number`, formatted into 4-digit groups |
| Format | Excel text-formula: `="3700 2145 0855 2239"` |

**Importer:** INPUT (parse) — strip the `="…"` wrapper, then strip spaces
to recover the raw digits, then write to `item.card_info.card_number`.

### Column 19 — `Expiry date`

| | All OTAs |
|---|---|
| Source | `item.card_info.expiry_date` (raw stored string, often `YYYY-MM`) |
| Format | Excel text-formula: `="2031-02"` |

**Importer:** INPUT (parse) — strip the `="…"` wrapper. Store as-is.

### Column 20 — `CVV`

| | All OTAs |
|---|---|
| Source | `item.card_info.cvv` |
| Format | Excel text-formula: `="123"` |

**Importer:** INPUT (parse) — strip the `="…"` wrapper.

### Columns 21–26 — Always-blank placeholder columns

| Column | Source | Format |
|---|---|---|
| `Due to Property` | always `""` | blank |
| `Due to VNP/Invoice` | always `""` | blank |
| `Processor (DBMS Based on OTA)` | always `""` | blank |
| `QP Username (From DBMS)` | always `""` | blank |
| `Case Contact (From DBMS)` | always `""` | blank |
| `Reporting Contact (From DBMS)` | always `""` | blank |

**Importer:** IGNORE for **all** OTAs. These exist only as placeholders
in the spec; no DB field is currently mapped to them.

### Column 27 — `Card Activity` (Expedia only)

| | Expedia |
|---|---|
| Source | `JSON.stringify(approvedAuthorizations)` |
| Format | JSON string of an array (see schema below) |

When there are no approved authorizations the cell is `"[]"`.

**Importer:** INPUT — `JSON.parse(...)` to recover the authorizations
array; rehydrate `dateTime` strings back to `Date` if needed; write to
`item.cardActivity.authorizations`.

The element schema:

```ts
{
  dateTime: string;                  // ISO 8601, e.g. "2026-03-30T08:02:18.000Z"
  status: "Approved";                // always "Approved" — only approved auths are exported
  authCode: string | null;           // e.g. "A731JC"
  declineCode: string | null;
  responseDescription: string | null;
  amount: {
    amount: number;                  // e.g. 294.87
    currency: string;                // ISO 4217, e.g. "CAD"
  } | null;
}
```

> Note: only authorizations with `status === "Approved"` are exported.
> Declined/other authorizations are dropped from the cell. If you upload
> back, you'll only re-create the approved ones.

### Column 28 — `Calculated Amount to Charge` (Expedia only, DERIVED)

| | Expedia |
|---|---|
| Source | `Booking Amount − Σ approved.amount.amount`, rounded to 2 decimals |
| Format | number, or `""` when `Booking Amount` is missing |

**Importer:** IGNORE — recompute on import. Never trust this cell:
a user could have edited `Booking Amount` or `Card Activity` in Excel.

### Column 29 — `Amount Match` (Expedia only, DERIVED)

| | Expedia |
|---|---|
| Rule | `"Yes"` iff `Calculated Amount to Charge` and `Amount to Charge` are both present and equal after rounding to 2 decimals; else `"No"` |

**Importer:** IGNORE — recompute after the row is in the database.

### Columns 30+ — `Card Activity Approved Amount K` (Expedia only, DERIVED)

| | Expedia |
|---|---|
| Source | `approved[K-1].amount` rendered as `"{currency} {amount}"` (e.g. `"CAD 294.87"`) |
| Format | string |
| Number of columns | `N = max approved.length across rows in this CSV` |

**Importer:** IGNORE — these are a human-friendly view of the same data
already in `Card Activity`. They lose the original `Float` precision
because they're string-formatted.

---

## 3. Quick lookup matrix (Expedia / Booking / Agoda)

Compact view of every column, the OTA-specific source, and whether an
importer should read it.

| # | Header | Expedia | Booking | Agoda | Importer (Expedia) | Importer (Booking) | Importer (Agoda) |
|---|---|---|---|---|---|---|---|
| 1 | OTA | `"Expedia"` | `"Booking"` | `"Agoda"` | INPUT | INPUT | INPUT |
| 2 | OTA Posting Type | `formatPostingType(job.posting_type)` | same | same | INPUT | INPUT | INPUT |
| 3 | OTA ID | `property.expedia_id` | `property.booking_id` | `property.agoda_id` | INPUT | INPUT | INPUT |
| 4 | Batch | `job.batch.name` | same | same | INPUT | INPUT | INPUT |
| 5 | Review Collection Date | `job.end_date` (`MMM dd, yyyy`) | same | same | INPUT (parse) | INPUT (parse) | INPUT (parse) |
| 6 | Portfolio | `job.portfolio_name` | same | same | INPUT | INPUT | INPUT |
| 7 | Property Name | `job.property_name` | same | same | INPUT | INPUT | INPUT |
| 8 | Reservation ID | `item.reservation_id` | same | same | INPUT | INPUT | INPUT |
| 9 | Hotel Confirmation Code | `item.confirmation_number` | `"N/A"` | `"N/A"` | INPUT | IGNORE | IGNORE |
| 10 | Guest name | `item.guest_name` | same | same | INPUT | INPUT | INPUT |
| 11 | Check In | `item.check_in_date` (`MMM dd, yyyy`) | `"N/A"` | `item.check_in_date` (`MMM dd, yyyy`) | INPUT (parse) | IGNORE | INPUT (parse) |
| 12 | Check Out | `item.check_out_date` (`MMM dd, yyyy`) | `"N/A"` | `item.check_out_date` (`MMM dd, yyyy`) | INPUT (parse) | IGNORE | INPUT (parse) |
| 13 | Charge Before | `"N/A"` | `item.payment_info.charge_before` or `"N/A"` | `"N/A"` | IGNORE | INPUT | IGNORE |
| 14 | Currency | `item.payment_info.amount_to_charge_or_refund_currency` (`"USD"` if null) | same | same | INPUT | INPUT | INPUT |
| 15 | Booking Amount | `item.booking_amount` | `"N/A"` | `"N/A"` | INPUT | IGNORE | IGNORE |
| 16 | Amount to Charge | `item.payment_info.amount_to_charge_or_refund` (or `""`) | same | same | INPUT | INPUT | INPUT |
| 17 | Card Status | `item.card_info.reason_for_charge` | `"N/A"` | `"N/A"` | INPUT | IGNORE | IGNORE |
| 18 | Card Number | `="3700 2145 0855 2239"` | same | same | INPUT (parse) | INPUT (parse) | INPUT (parse) |
| 19 | Expiry date | `="2031-02"` | same | same | INPUT (parse) | INPUT (parse) | INPUT (parse) |
| 20 | CVV | `="123"` | same | same | INPUT (parse) | INPUT (parse) | INPUT (parse) |
| 21 | Due to Property | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 22 | Due to VNP/Invoice | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 23 | Processor (DBMS Based on OTA) | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 24 | QP Username (From DBMS) | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 25 | Case Contact (From DBMS) | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 26 | Reporting Contact (From DBMS) | `""` | `""` | `""` | IGNORE | IGNORE | IGNORE |
| 27 | Card Activity | `JSON.stringify(approved auths)` | _column not present_ | _column not present_ | INPUT | — | — |
| 28 | Calculated Amount to Charge | `booking_amount − Σ approved` (DERIVED) | _column not present_ | _column not present_ | IGNORE | — | — |
| 29 | Amount Match | `"Yes"` / `"No"` (DERIVED) | _column not present_ | _column not present_ | IGNORE | — | — |
| 30+ | Card Activity Approved Amount K | `"{currency} {amount}"` (DERIVED) | _column not present_ | _column not present_ | IGNORE | — | — |

---

## 4. Reverse transformations the importer must apply

| Cell | Looks like | How to undo it |
|---|---|---|
| Card Number | `="3700 2145 0855 2239"` | strip `="`/trailing `"` → strip whitespace → store raw digits |
| Expiry date | `="2031-02"` | strip `="`/trailing `"` → store as-is |
| CVV | `="123"` | strip `="`/trailing `"` |
| Check In / Check Out / Review Collection Date | `Feb 28, 2026` | `new Date(value)` (Node accepts `MMM dd, yyyy`); validate with `isNaN(d.getTime())` before storing |
| Card Activity | `[{...}, {...}]` (JSON string) | `JSON.parse(...)`, then re-hydrate `dateTime` to `Date` if your ORM expects `Date` |

Suggested helper:

```ts
function unwrapExcelText(cell: unknown): string {
  if (typeof cell !== 'string') return cell == null ? '' : String(cell);
  const m = cell.match(/^="(.*)"$/);
  return m ? m[1] : cell;
}

function unwrapCardNumber(cell: unknown): string {
  return unwrapExcelText(cell).replace(/\s+/g, '');
}
```

---

## 5. Required vs optional columns at upload time

### 5.1 Expedia (minimum required)

- `OTA` (must be `"Expedia"`)
- `OTA ID` (Expedia property ID — for property lookup)
- `Reservation ID` (per-job uniqueness)
- `Hotel Confirmation Code`
- `Guest name`
- `Check In`, `Check Out`
- `Currency`
- `Booking Amount`
- `Amount to Charge`
- `Card Number`, `Expiry date`, `CVV`

Optional but useful: `OTA Posting Type`, `Batch`, `Review Collection Date`,
`Card Status`, `Card Activity`.

### 5.2 Booking (minimum required)

- `OTA` (must be `"Booking"`)
- `OTA ID` (Booking property ID)
- `Reservation ID`
- `Guest name`
- `Charge Before`
- `Currency`
- `Amount to Charge`
- `Card Number`, `Expiry date`, `CVV`

Booking does not carry `Hotel Confirmation Code`, `Check In`, `Check Out`,
`Booking Amount`, `Card Status`, or any of the Expedia-only columns —
they are always `"N/A"` in export and should be ignored on import.

### 5.3 Agoda (minimum required)

- `OTA` (must be `"Agoda"`)
- `OTA ID` (Agoda property ID)
- `Reservation ID`
- `Guest name`
- `Check In`, `Check Out`
- `Currency`
- `Amount to Charge`
- `Card Number`, `Expiry date`, `CVV`

Agoda does not carry `Hotel Confirmation Code`, `Charge Before`,
`Booking Amount`, `Card Status`, or any of the Expedia-only columns.

### 5.4 Always-ignore on upload

- `Due to Property`
- `Due to VNP/Invoice`
- `Processor (DBMS Based on OTA)`
- `QP Username (From DBMS)`
- `Case Contact (From DBMS)`
- `Reporting Contact (From DBMS)`
- `Calculated Amount to Charge` (derived)
- `Amount Match` (derived)
- Every `Card Activity Approved Amount K` (derived)

---

## 6. Sample rows

### 6.1 Expedia

```
OTA: Expedia
OTA Posting Type: OTA
OTA ID: 795920
Batch: April-VCC
Review Collection Date: Feb 28, 2026
Portfolio: Rainmaker Hospitality
Property Name: Springhill Suites by Marriott Louisville Hurstbourne/North
Reservation ID: 2403723113
Hotel Confirmation Code: 70637294
Guest name: Kayla Dunning
Check In: Feb 27, 2026
Check Out: Feb 28, 2026
Charge Before: N/A
Currency: USD
Booking Amount: 113.15
Amount to Charge: 0
Card Status:
Card Number: ="3700 2145 0855 2239"
Expiry date: ="2031-02"
CVV: ="2239"
Due to Property:
Due to VNP/Invoice:
Processor (DBMS Based on OTA):
QP Username (From DBMS):
Case Contact (From DBMS):
Reporting Contact (From DBMS):
Card Activity: [{"dateTime":"2026-03-30T08:02:18.000Z","status":"Approved","authCode":"A731JC","declineCode":null,"responseDescription":null,"amount":{"amount":113.15,"currency":"USD"}}]
Calculated Amount to Charge: 0
Amount Match: Yes
Card Activity Approved Amount 1: USD 113.15
```

### 6.2 Booking

```
OTA: Booking
OTA Posting Type: OTA
OTA ID: 268264
Batch: April-VCC
Review Collection Date: Feb 28, 2026
Portfolio: Rainmaker Hospitality
Property Name: Springhill Suites by Marriott Louisville Hurstbourne/North
Reservation ID: 4502123881
Hotel Confirmation Code: N/A
Guest name: John Smith
Check In: N/A
Check Out: N/A
Charge Before: 2026-02-25
Currency: EUR
Booking Amount: N/A
Amount to Charge: 250.00
Card Status: N/A
Card Number: ="5500 0000 0000 0004"
Expiry date: ="2030-08"
CVV: ="123"
Due to Property:
Due to VNP/Invoice:
Processor (DBMS Based on OTA):
QP Username (From DBMS):
Case Contact (From DBMS):
Reporting Contact (From DBMS):
```

### 6.3 Agoda

```
OTA: Agoda
OTA Posting Type: OTA
OTA ID: 2459970
Batch: April-VCC
Review Collection Date: Feb 28, 2026
Portfolio: Rainmaker Hospitality
Property Name: Springhill Suites by Marriott Louisville Hurstbourne/North
Reservation ID: A-71238820
Hotel Confirmation Code: N/A
Guest name: Maria Garcia
Check In: Feb 27, 2026
Check Out: Feb 28, 2026
Charge Before: N/A
Currency: USD
Booking Amount: N/A
Amount to Charge: 175.40
Card Status: N/A
Card Number: ="4111 1111 1111 1111"
Expiry date: ="2029-11"
CVV: ="999"
Due to Property:
Due to VNP/Invoice:
Processor (DBMS Based on OTA):
QP Username (From DBMS):
Case Contact (From DBMS):
Reporting Contact (From DBMS):
```

---

## 7. Validation suggestions for the upload feature

- Reject sheets where `OTA` mixes multiple values inside the same file
  (or split by OTA before parsing).
- `OTA` must equal one of `"Expedia"`, `"Booking"`, `"Agoda"`. Anything
  else → reject the row with a descriptive error.
- `OTA ID` must resolve to a `Property` whose corresponding ID column
  matches: `expedia_id` for Expedia, `booking_id` for Booking,
  `agoda_id` for Agoda.
- `Reservation ID` must be unique within `(job_id, reservation_id)` —
  this matches the existing schema constraint.
- If `Card Activity` is present (Expedia only), it must parse to a JSON
  array of objects matching the documented shape; warn on schema drift.
- `Check In` / `Check Out` / `Review Collection Date` must parse cleanly
  via `MMM dd, yyyy`; reject the row otherwise.
- After hydrating each row, recompute `Calculated Amount to Charge` and
  `Amount Match`. Warn if they disagree with the values in the CSV —
  it usually means the user edited a derived/derivable column.
