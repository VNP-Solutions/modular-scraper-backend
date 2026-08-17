# Booking Property Check Backend

A single-purpose service: given a Booking.com Partner Admin account and a list of
properties, it logs in once and records — per property — whether that account can
actually reach the property. Verdicts are written straight to the `Property`
collection; the API itself returns nothing but an acknowledgement.

## The endpoint

### `POST /api/booking/check-properties`

```jsonc
{
  "username": "user@example.com",
  "password": "…",
  "booking_ids": [
    { "_id": "507f1f77bcf86cd799439011", "booking_id": "12345678" }
  ]
}
```

A single property may instead be sent as top-level `property_id` + `booking_id`.

Responds `200` immediately and runs the check in the background, because a run
involves a full login (captcha + 2FA) plus one search per property.

| Response | Meaning |
| --- | --- |
| `200` | Accepted; the check is running, results go to the database |
| `400` | Missing `username`/`password`, or a malformed `booking_ids` entry |
| `409` | Another check is already running |
| `500` | Could not accept the request |

### What lands in the database

| Outcome | `booking_credential_verified` | `booking_access_level` |
| --- | --- | --- |
| Credentials rejected by Booking.com | `false` (all requested properties) | untouched |
| Logged in, property found | `true` | `true` |
| Logged in, property not found | `true` | `false` |

Only a genuine username/password rejection sets `booking_credential_verified` to
`false`. A Booking.com server-side failure — "too many attempts", "sign in failed,
try again later", technical difficulties — leaves every flag untouched, because
*could not check* is a different verdict from *no access*, and writing the latter
would corrupt the DBMS record. When such a failure happens mid-run the remaining
properties are reported as `Not checked — <reason>` and are likewise left alone.

Both single-property and multi-property accounts are handled: multi-property
accounts are searched through the property list, while a single-property account
(which never shows a list) is matched against the `hotel_id` it landed on.

## Other routes

| Route | Purpose |
| --- | --- |
| `GET /` | Health check |
| `GET /auth`, `GET /oauth2callback` | Google OAuth — authorises the mailbox the OTP flow reads Booking.com verification codes from |
| `GET /api-docs` | Swagger UI |

## How a run works

1. `BookingScraper.setupBrowser()` — Browserless session, or local Chrome when
   `ENVIRONMENT=local`, with anti-detection applied.
2. `BookingScraper.login()` — resolves whatever Booking.com puts in the way:
   captcha, account lock, forced password reset, and 2FA/OTP.
3. Property list search, one `booking_id` at a time, never clicking through.
4. `patchOtaVerificationFields()` writes only the two verification flags via
   `$set`, so no other OTA fields on the document are disturbed.
5. `triggerDbmsOtaCheckLambda("booking")` tells the DBMS to release the next
   queued account group.

### OTP and worker threads

The OTP machinery is intact and is what makes concurrent runs safe:

- `otp-aware-worker-pool` spawns worker threads (`MAX_WORKER_THREADS`, default 3).
- `phone_number_slots` leases a phone/port contact per job through an atomic
  `findOneAndUpdate`, so two threads can never drive an SMS OTP on the same
  number simultaneously.
- `scraping-worker.ts` holds the per-thread half of that contract: lease the
  contact, run the payload, release it.

No scraping job payload ships in this build — the property check runs on the main
thread. Register one in `ScrapingWorker.runJobPayload` and the surrounding OTP
lease, messaging and stop handling apply unchanged.

## Setup

```bash
npm install
cp .env.example .env     # then fill it in
npm run dev              # or: npm run build && npm start
```

`DATABASE_URI`, `ENCRYPTION_KEY` (32 chars, AES-256) and the Booking.com browser
settings are the minimum needed to run. `OPENAI_API_KEY` is required for captcha
solving, and `CLIENT_ID`/`CLIENT_SECRET`/`TOKEN_PATH` for the Gmail OAuth token
that the OTP flow needs. Every variable the code reads is documented in
`.env.example`.

## Layout

```
src/
  app/app.ts                  Express app and the four routes
  property-check/             The check itself + request normalisation
  scrapers/                   BaseScraper and BookingScraper (login, captcha, 2FA)
  otp-verification/           Booking OTP handling and mailbox code retrieval
  workers/                    OTP-aware worker thread
  common/                     Selectors, anti-detection, failure reasons, logging
  services/                   Captcha, sessions, cookies, credentials, phone slots
  models/                     Mongoose schemas
  docs/                       Swagger path definitions (YAML)
```
