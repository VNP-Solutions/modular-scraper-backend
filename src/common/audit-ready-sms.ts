import twilio from "twilio";

/**
 * Body intros for outbound audit SMS.
 *
 * - READY    — sent when a job finishes with status `Completed` (existing flow).
 * - STARTED  — sent when the property-run-job API accepts a request (so the
 *   recipient knows scraping has begun and can keep an eye on the link).
 */
const SMS_INTRO_READY = "Your Audit is ready please take a look";
const SMS_INTRO_STARTED = "Your Audit has started";

/** Returns DEMO_WEBSITE_URL with any trailing slashes trimmed (empty string if unset). */
function demoSiteBase(): string {
  return (process.env.DEMO_WEBSITE_URL || "").trim().replace(/\/+$/, "");
}

/**
 * Link placed inside the **"Audit ready"** SMS — points at the final report.
 * Pattern: `{DEMO_WEBSITE_URL}/audits/{jobId}`.
 */
export function buildAuditReadyUrl(jobId: string): string {
  return `${demoSiteBase()}/audits/${jobId}`;
}

/**
 * Link placed inside the **"Audit started"** SMS — points at the live progress
 * page so the recipient can watch the scrape happen.
 * Pattern: `{DEMO_WEBSITE_URL}/progress/{jobId}`.
 */
export function buildAuditProgressUrl(jobId: string): string {
  return `${demoSiteBase()}/progress/${jobId}`;
}

function twilioFromNumber(): string {
  return (
    process.env.TWILIO_FROM_NUMBER?.trim() ||
    process.env.TWILIO_PHONE_NUMBER?.trim() ||
    ""
  );
}

/** Twilio path (optional fallback). */
export function isTwilioAuditSmsConfigured(): boolean {
  const from = twilioFromNumber();
  return !!(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
    process.env.TWILIO_AUTH_TOKEN?.trim() &&
    from &&
    process.env.DEMO_WEBSITE_URL?.trim()
  );
}

/**
 * Ejointech / Ejoin ACOM6xx HTTP API (v3+): POST /submit_sms_tasks
 *
 * Env (two different URLs — do not confuse them):
 *
 * - EJOIN_SMS_GATEWAY_URL — **SMS hardware only**: LAN IP of the gateway, or ngrok URL
 *   that tunnels to that device (e.g. https://xxxx.ngrok-free.dev). No path; not your
 *   product website. Used only to call `/submit_sms_tasks` on the device.
 * - EJOIN_SMS_USERNAME / EJOIN_SMS_PASSWORD — **device** web/API login (same as dashboard).
 * - DEMO_WEBSITE_URL — **your project / audit site** shown *inside* the SMS text.
 *   The "started" SMS links to `{DEMO_WEBSITE_URL}/progress/{jobId}` (live progress
 *   page) and the "ready" SMS links to `{DEMO_WEBSITE_URL}/audits/{jobId}` (final
 *   report). Never the device URL.
 * - EJOIN_SMS_FROM_PORT (optional) — modem port index 1–64. If unset, the gateway
 *   auto-picks an available port/SIM per Ejoin docs ("Automatically selected by device").
 */
export function isEjoinAuditSmsConfigured(): boolean {
  return !!(
    process.env.EJOIN_SMS_GATEWAY_URL?.trim() &&
    process.env.EJOIN_SMS_USERNAME?.trim() &&
    process.env.EJOIN_SMS_PASSWORD?.trim() &&
    process.env.DEMO_WEBSITE_URL?.trim()
  );
}

export function isAuditSmsConfigured(): boolean {
  return isEjoinAuditSmsConfigured() || isTwilioAuditSmsConfigured();
}

function ejoinGatewayBase(): string {
  return (process.env.EJOIN_SMS_GATEWAY_URL || "").trim().replace(/\/+$/, "");
}

/** Optional 1–64: which modem port / SIM slot sends the SMS (Ejoin `from` field). */
function ejoinFromPort(): number | undefined {
  const raw = process.env.EJOIN_SMS_FROM_PORT?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 64) {
    throw new Error(
      `Ejoin: EJOIN_SMS_FROM_PORT must be an integer 1–64, got "${raw}"`
    );
  }
  return n;
}

/** Unique numeric task id per submit (docs use numeric `id`, e.g. 1). */
function ejoinTaskId(): number {
  return Date.now() % 2_147_000_000;
}

async function sendAuditSmsViaTwilio(
  toPhone: string,
  intro: string,
  link: string
): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = twilioFromNumber();
  if (!sid || !token || !from) {
    throw new Error(
      "Twilio: missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER"
    );
  }
  if (!process.env.DEMO_WEBSITE_URL?.trim()) {
    throw new Error("Twilio: DEMO_WEBSITE_URL is not set");
  }
  const body = `${intro}\n${link}`;
  const client = twilio(sid, token);
  await client.messages.create({
    from,
    to: toPhone.trim(),
    body,
  });
}

interface EjoinSubmitResponseItem {
  id?: number;
  code?: number;
  reason?: string;
}

async function sendAuditSmsViaEjoin(
  toPhone: string,
  intro: string,
  link: string
): Promise<void> {
  const base = ejoinGatewayBase();
  const username = process.env.EJOIN_SMS_USERNAME?.trim();
  const password = process.env.EJOIN_SMS_PASSWORD?.trim();
  if (!base || !username || !password) {
    throw new Error(
      "Ejoin: set EJOIN_SMS_GATEWAY_URL, EJOIN_SMS_USERNAME, EJOIN_SMS_PASSWORD"
    );
  }
  const smsBody = `${intro}\n${link}`;

  const url = new URL(`${base}/submit_sms_tasks`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);

  const fromPort = ejoinFromPort();
  /**
   * Plain text SMS: `recipients` + `sms` per [Ejoin API](https://ejoin-api.github.io/gateway/#tag/Message-Operations/paths/http:~1~1host:port~1submit_sms_tasks/post).
   * Numeric `id` (unique per request); omit `sms_type` for text — some firmware returns `[]`
   * if `sms_type` does not match the body.
   */
  const task: Record<string, unknown> = {
    id: ejoinTaskId(),
    recipients: [toPhone.trim()],
    sms: smsBody,
    charset: "UTF-8",
    coding: 0,
    timeout: 30,
    to_all: false,
  };
  if (fromPort !== undefined) {
    task.from = fromPort;
  }

  const payload = [task];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // ngrok free tier may return an HTML interstitial for programmatic clients
  if (/ngrok/i.test(base)) {
    headers["Ngrok-Skip-Browser-Warning"] = "true";
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed: EjoinSubmitResponseItem[] | null = null;
  try {
    parsed = JSON.parse(text) as EjoinSubmitResponseItem[];
  } catch {
    // non-JSON body
  }

  if (!res.ok) {
    throw new Error(
      `Ejoin HTTP ${res.status}: ${text.slice(0, 500)}`
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `Ejoin: empty or non-JSON response (${text.slice(0, 200)}). ` +
        `Often caused by invalid JSON (use straight ASCII quotes in curl, not “smart” quotes), ` +
        `wrong URL path, or auth failure. Try EJOIN_SMS_FROM_PORT=1..64 to pin a modem port. ` +
        `If using ngrok free, add header Ngrok-Skip-Browser-Warning: true to curl.`
    );
  }

  const first = parsed[0];
  if (first.code !== undefined && first.code !== 0) {
    throw new Error(
      `Ejoin submit_sms_tasks code=${first.code} reason=${first.reason ?? "?"}`
    );
  }
}

/**
 * Send an audit SMS with the given `intro` line and pre-built `link`. Provider
 * order:
 * - AUDIT_SMS_PROVIDER=ejoin → Ejoin only
 * - AUDIT_SMS_PROVIDER=twilio → Twilio only
 * - unset / auto → Ejoin if configured, else Twilio if configured
 *
 * Both public entry points (`sendAuditReadySms`, `sendAuditStartedSms`) build
 * their own URL via `buildAuditReadyUrl` / `buildAuditProgressUrl` so each
 * message lands on the correct page (`/audits/{jobId}` vs `/progress/{jobId}`).
 */
async function sendAuditSms(
  toPhone: string,
  intro: string,
  link: string
): Promise<void> {
  const mode = (process.env.AUDIT_SMS_PROVIDER || "auto")
    .trim()
    .toLowerCase();

  if (mode === "twilio") {
    return sendAuditSmsViaTwilio(toPhone, intro, link);
  }
  if (mode === "ejoin") {
    return sendAuditSmsViaEjoin(toPhone, intro, link);
  }

  // auto
  if (isEjoinAuditSmsConfigured()) {
    return sendAuditSmsViaEjoin(toPhone, intro, link);
  }
  if (isTwilioAuditSmsConfigured()) {
    return sendAuditSmsViaTwilio(toPhone, intro, link);
  }

  throw new Error(
    "No SMS provider configured: set Ejoin (EJOIN_SMS_*) or Twilio (TWILIO_*) + DEMO_WEBSITE_URL"
  );
}

/**
 * Sent by the worker once a job's `finalStatus` resolves to Completed.
 * Links to `{DEMO_WEBSITE_URL}/audits/{jobId}`.
 */
export async function sendAuditReadySms(
  toPhone: string,
  jobId: string
): Promise<void> {
  return sendAuditSms(toPhone, SMS_INTRO_READY, buildAuditReadyUrl(jobId));
}

/**
 * Sent by `/api/expedia/graphql-run-job` as soon as the job is accepted.
 * Links to `{DEMO_WEBSITE_URL}/progress/{jobId}` (live progress page).
 */
export async function sendAuditStartedSms(
  toPhone: string,
  jobId: string
): Promise<void> {
  return sendAuditSms(
    toPhone,
    SMS_INTRO_STARTED,
    buildAuditProgressUrl(jobId)
  );
}
