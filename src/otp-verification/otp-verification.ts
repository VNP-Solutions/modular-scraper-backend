import dotenv from "dotenv";
import { google } from "googleapis";
import { Browser, Page } from "puppeteer";
import {
  inferOtpFailedReasonCode,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import { delay } from "../common/delay.js";
import { loadAndSetCredentials } from "../common/load-token.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { takeScreenshot } from "../common/screenshot-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

/**
 * Partner Central OTP notification subject (e.g. SMS → email / IFTTT). Full example:
 * Login attempt from ASHBURN, US to Partner Central Your verification code is 584207. Don't share this code; we will never ask for it.
 *
 * The origin city in "Login attempt from <CITY>" is dynamic (it reflects wherever
 * the login appears to originate), so we must NOT hardcode a specific city. We only
 * anchor on the stable phrases shared by every OTP email.
 */
const PARTNER_CENTRAL_OTP_SUBJECT_LOGIN_PREFIX = "Login attempt from";
const PARTNER_CENTRAL_OTP_SUBJECT_CODE_PHRASE =
  "Partner Central Your verification code is";

/** Gmail list: both fragments appear in the subject line. */
const PARTNER_CENTRAL_OTP_GMAIL_QUERY = `subject:"${PARTNER_CENTRAL_OTP_SUBJECT_LOGIN_PREFIX}" subject:"${PARTNER_CENTRAL_OTP_SUBJECT_CODE_PHRASE}"`;

function subjectMatchesPartnerCentralOtpTemplate(subject: string): boolean {
  const s = subject.trim();
  return (
    s.includes(PARTNER_CENTRAL_OTP_SUBJECT_LOGIN_PREFIX) &&
    s.includes(PARTNER_CENTRAL_OTP_SUBJECT_CODE_PHRASE)
  );
}

/**
 * Partner Central MFA / passcode step lives here (e.g. after login).
 * https://www.expediapartnercentral.com/account/mfa/initiate
 */
const PARTNER_CENTRAL_MFA_INITIATE_PATH = "/account/mfa/initiate";

const OTP_EMAIL_MAX_AGE_MS =
  Number(process.env.OTP_EMAIL_WINDOW_MS) || 5 * 60 * 1000;

/** Max submit attempts when Partner Central rejects the passcode (visible validation error). */
const OTP_VERIFY_MAX_ATTEMPTS = 4;

/** One minute before first Gmail read (same as legacy `delay(60000)` on email flow). */
const OTP_WAIT_BEFORE_FIRST_CODE_MS = 60 * 1000;

/** Brief pause between VERIFY clicks when cycling codes from the same batch (no Gmail refetch). */
const OTP_WAIT_BETWEEN_SUBMIT_MS =
  Number(process.env.OTP_WAIT_BETWEEN_SUBMIT_MS) ||
  Number(process.env.OTP_WAIT_BETWEEN_RETRY_MS) ||
  2 * 1000;

const OTP_POST_SUBMIT_CHECK_MS =
  Number(process.env.OTP_POST_SUBMIT_CHECK_MS) || 5 * 1000;

// Function to load and set credentials from S3
async function loadCredentials() {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";
    const success = await loadAndSetCredentials(tokenPath);

    if (!success) {
      throw new Error(
        "Failed to load Gmail credentials from S3 or local file. Please run the authentication setup first."
      );
    }

    await dualLogInfo("Gmail credentials loaded successfully from S3");
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}

/** Minimal shape for recursive MIME walk (Gmail API message payload parts). */
interface GmailMessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailMessagePart[] | null;
}

function extractPlainBodyFromPayload(
  payload: GmailMessagePart | undefined
): string {
  if (!payload) {
    return "";
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString();
  }
  if (payload.body?.data && !payload.parts?.length) {
    return Buffer.from(payload.body.data, "base64").toString();
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = extractPlainBodyFromPayload(part);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

/** Prefer explicit phrase; code often appears in subject as well as body. */
function extractPartnerCentralOtpCode(
  subject: string,
  emailBody: string
): string | null {
  const combined = `${subject}\n${emailBody}`;
  const primary = combined.match(/Your verification code is (\d{6})/i);
  if (primary?.[1]) {
    return primary[1];
  }
  const fallbackBody = emailBody.match(/\b\d{6}\b/);
  return fallbackBody ? fallbackBody[0] : null;
}

/**
 * Single Gmail pass: all Partner Central OTP messages in the time window, then
 * distinct 6-digit codes ordered newest-first (by message internalDate).
 */
async function fetchPartnerCentralOtpCodesFromGmail(): Promise<string[]> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const cutoffMs = Date.now() - OTP_EMAIL_MAX_AGE_MS;

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 40,
      q: PARTNER_CENTRAL_OTP_GMAIL_QUERY,
    });

    if (!res.data.messages?.length) {
      await dualLogInfo(
        "No verification emails found with Partner Central verification code."
      );
      return [];
    }

    await dualLogInfo(
      `OTP batch fetch (one Gmail scan): up to ${res.data.messages.length} id(s), window ${OTP_EMAIL_MAX_AGE_MS / 60000} min`
    );

    type Entry = { internalMs: number; code: string };
    const entries: Entry[] = [];

    for (const msg of res.data.messages) {
      if (!msg.id) {
        continue;
      }

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      if (email.data.internalDate == null) {
        continue;
      }
      const internalMs = Number(email.data.internalDate);
      if (!Number.isFinite(internalMs)) {
        continue;
      }
      if (internalMs < cutoffMs) {
        await dualLogInfo(
          `Reached messages older than OTP window; stopping scan (id ${msg.id})`
        );
        break;
      }

      const headers = email.data.payload?.headers || [];
      const subjectHeader = headers.find(
        (header) => header.name?.toLowerCase() === "subject"
      );
      const subject = subjectHeader?.value || "";
      if (!subjectMatchesPartnerCentralOtpTemplate(subject)) {
        continue;
      }

      let emailBody = extractPlainBodyFromPayload(email.data.payload);
      if (!emailBody) {
        emailBody = email.data.snippet || "";
      }

      const code = extractPartnerCentralOtpCode(subject, emailBody);
      if (!code) {
        continue;
      }

      entries.push({ internalMs, code });
    }

    entries.sort((a, b) => b.internalMs - a.internalMs);

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const e of entries) {
      if (seen.has(e.code)) {
        continue;
      }
      seen.add(e.code);
      ordered.push(e.code);
    }

    await dualLogInfo(
      `OTP batch fetch done: ${entries.length} message(s) with a code, ${ordered.length} distinct code(s) newest-first`
    );
    return ordered;
  } catch (error: any) {
    await dualLogError("Error fetching emails:", error.message);
    return [];
  }
}

async function clearPasscodeInput(page: Page): Promise<void> {
  await page.focus('input[name="passcode-input"]').catch(() => undefined);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="passcode-input"]'
    );
    if (el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

function urlPathnameIndicatesMfaInitiatePage(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return pathname.includes(PARTNER_CENTRAL_MFA_INITIATE_PATH);
  } catch {
    return url.includes(PARTNER_CENTRAL_MFA_INITIATE_PATH);
  }
}

function normalizeUrlForCompare(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * After VERIFY, success = browser leaves the MFA initiate URL (SPA may not fire networkidle).
 * If checkpoint was not on MFA path, fall back to "any URL change" vs normalized checkpoint.
 */
async function waitUntilUrlLeavesMfaOtpPage(
  page: Page,
  otpCheckpointUrl: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  const checkpointNorm = normalizeUrlForCompare(otpCheckpointUrl);
  const useMfaPathRule = urlPathnameIndicatesMfaInitiatePage(otpCheckpointUrl);

  await dualLogInfo(
    useMfaPathRule
      ? `Waiting until URL leaves MFA initiate (${PARTNER_CENTRAL_MFA_INITIATE_PATH})...`
      : `Waiting until URL changes from OTP checkpoint (not on expected MFA path)...`
  );

  const pollMs = 400;
  while (Date.now() - start < timeoutMs) {
    const current = page.url();
    if (useMfaPathRule) {
      if (!urlPathnameIndicatesMfaInitiatePage(current)) {
        await dualLogInfo(`Left MFA / OTP page. New URL: ${current}`);
        return;
      }
    } else if (normalizeUrlForCompare(current) !== checkpointNorm) {
      await dualLogInfo(`OTP checkpoint URL changed. New URL: ${current}`);
      return;
    }
    await delay(pollMs);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms: still on MFA/OTP URL (${page.url()}). Checkpoint was ${otpCheckpointUrl}`
  );
}

async function passcodeInputShowsFailure(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const err = document.querySelector('[data-testid="passcode-input-error"]');
    if (!err) {
      return false;
    }
    const t = (err.textContent || "").trim();
    if (!t) {
      return false;
    }
    const lower = t.toLowerCase();
    const looksFailed =
      lower.includes("failed") ||
      lower.includes("expired") ||
      lower.includes("try again") ||
      lower.includes("request a new code");
    if (!looksFailed) {
      return false;
    }
    const el = err as HTMLElement;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }
    return true;
  });
}

/**
 * Wait for email, then one Gmail batch fetch for all in-window codes (newest first).
 * Submits up to OTP_VERIFY_MAX_ATTEMPTS times using that list only — no refetch between attempts.
 * After VERIFY with no inline error, waits until the URL leaves the MFA initiate page (see checkpoint).
 */
async function enterPasscodeFromEmailWithRetries(
  page: Page,
  jobId: string | undefined,
  entityType: "job" | "retrieval",
  options: {
    otpCheckpointUrl: string;
    postVerifyUrlWaitMs: number;
    initialDelayMs?: number;
  }
): Promise<void> {
  const { otpCheckpointUrl, postVerifyUrlWaitMs, initialDelayMs } = {
    initialDelayMs: OTP_WAIT_BEFORE_FIRST_CODE_MS,
    ...options,
  };

  await dualLogInfo("Waiting for verification email...");
  await delay(initialDelayMs);

  const codeQueue = await fetchPartnerCentralOtpCodesFromGmail();
  if (!codeQueue.length) {
    throw new Error("Failed to get verification code from email");
  }

  const rejectedCodes = new Set<string>();

  for (let attempt = 1; attempt <= OTP_VERIFY_MAX_ATTEMPTS; attempt++) {
    const code = codeQueue.find((c) => !rejectedCodes.has(c));
    if (!code) {
      throw new Error(
        "No untried verification codes left from the Gmail batch for this OTP page."
      );
    }

    await dualLogInfo(
      `OTP submit attempt ${attempt}/${OTP_VERIFY_MAX_ATTEMPTS} (code from batch, no Gmail refetch)`
    );
    await dualLogInfo("Trying verification code:", code);

    await clearPasscodeInput(page);
    await page.type('input[name="passcode-input"]', code, { delay: 100 });
    await delay(1000);

    const verifyButtonHandle = await page.$(
      'button[data-testid="passcode-submit-button"]'
    );
    if (!verifyButtonHandle) {
      throw new Error("Verify button not found");
    }

    const isDisabled = await page.evaluate(
      (button) => button.disabled,
      verifyButtonHandle
    );
    if (isDisabled) {
      throw new Error("Verify button is disabled");
    }

    await verifyButtonHandle.click();
    await dualLogInfo("Clicked VERIFY DEVICE / passcode submit.");

    await delay(OTP_POST_SUBMIT_CHECK_MS);
    const failed = await passcodeInputShowsFailure(page);
    if (!failed) {
      await waitUntilUrlLeavesMfaOtpPage(
        page,
        otpCheckpointUrl,
        postVerifyUrlWaitMs
      );
      await takeScreenshot(
        page,
        jobId ?? "",
        "otp_submitted",
        "step",
        "expedia",
        entityType
      );
      return;
    }

    rejectedCodes.add(code);
    await dualLogInfo(
      "Partner Central reported passcode error; will try next code from the same batch if any."
    );

    if (attempt >= OTP_VERIFY_MAX_ATTEMPTS) {
      throw new Error(
        "OTP verification failed: code rejected or expired after maximum attempts."
      );
    }

    await dualLogInfo(
      `Waiting ${OTP_WAIT_BETWEEN_SUBMIT_MS / 1000}s before next submit (same Gmail batch)...`
    );
    await delay(OTP_WAIT_BETWEEN_SUBMIT_MS);
  }
}

async function handleOtpVerification(
  browser: Browser,
  page: Page,
  jobId?: string,
  entityType: "job" | "retrieval" = "job"
): Promise<void> {
  try {
    // Check if scraping is paused before starting OTP verification
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during OTP verification");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    // Wait for verification code page using the correct selector
    await dualLogInfo("Waiting for verification page...");
    try {
      await page.waitForSelector('input[name="passcode-input"]', {
        visible: true,
        timeout: selectorTimeout,
      });

      // Screenshot: OTP page detected
      await takeScreenshot(page, jobId ?? "", "otp_page_detected", "step", "expedia", entityType);
    } catch (error: any) {
      await dualLogError("Error waiting for verification page:", error);
      // Send email notification for verification page error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send verification page error notification:",
            emailError
          );
        }
      }
      throw error;
    }

    const otpCheckpointUrl = page.url();
    await dualLogInfo(
      `OTP page checkpoint URL (expect to leave this after successful VERIFY): ${otpCheckpointUrl}`
    );

    const ourContact = process.env.OUR_CONTACT || "01828704004";

    // Extract the phone number from the verification message
    const currentContact = await page.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="passcode-entry"] p b'
      );
      if (element) {
        return element.textContent?.trim();
      }
      return null;
    });

    await dualLogInfo(`Current contact from page: ${currentContact}`);
    await dualLogInfo(`Our contact: ${ourContact}`);

    // Compare last three digits
    const currentLastThree = currentContact ? currentContact.slice(-3) : "";
    const ourLastThree = ourContact.slice(-3);

    await dualLogInfo(`Current contact last 3 digits: ${currentLastThree}`);
    await dualLogInfo(`Our contact last 3 digits: ${ourLastThree}`);

    if (currentLastThree === ourLastThree) {
      await dualLogInfo(
        "Phone numbers match! Using email verification flow..."
      );

      try {
        await enterPasscodeFromEmailWithRetries(page, jobId, entityType, {
          otpCheckpointUrl,
          postVerifyUrlWaitMs: loadingTimeout,
        });
      } catch (error: any) {
        await dualLogError("Error in primary verification flow:", error);

        if (jobId) {
          try {
          } catch (emailError) {
            await dualLogError(
              "Failed to send primary verification error notification:",
              emailError
            );
          }
        }

        throw error;
      }
    } else {
      await dualLogInfo(
        `Phone numbers don't match! Looking for fallback verification options...`
      );

      // Look for fallback verification options
      try {
        // Check if fallbacks section exists
        const fallbacksExists = await page
          .waitForSelector('[data-testid="fallbacks"]', {
            visible: true,
            timeout: selectorTimeout,
          })
          .catch(() => null);

        if (!fallbacksExists) {
          const error = new Error("No fallback verification options found");

          // Send email notification for no fallback options
          if (jobId) {
            try {
            } catch (emailError) {
              await dualLogError(
                "Failed to send fallback options error notification:",
                emailError
              );
            }
          }

          throw error;
        }

        // Click the dropdown toggle: a <span data-testid="fallbacks-toggle">.
        await dualLogInfo(
          "Found fallbacks section, opening dropdown via fallbacks-toggle..."
        );

        const fallbacksToggle = await page
          .waitForSelector('span[data-testid="fallbacks-toggle"]', {
            visible: true,
            timeout: selectorTimeout,
          })
          .catch(() => null);

        if (!fallbacksToggle) {
          throw new Error(
            'Fallback dropdown toggle (span[data-testid="fallbacks-toggle"]) not found'
          );
        }

        await fallbacksToggle.click();
        await delay(2000);

        // Wait for the dropdown to expand and items to be visible.
        await dualLogInfo("Waiting for fallback items to be visible...");
        await page.waitForSelector('[data-testid="fallback-item"]', {
          visible: true,
          timeout: selectorTimeout,
        });
        await delay(2000);

        // Select the option whose phone number ends with our last 3 digits,
        // then click its "Send me a text" link (wrapped by div.fds-list-item-link).
        await dualLogInfo(`Looking for phone ending with: ${ourLastThree}`);

        const clickResult = await page.evaluate((ourLastThree) => {
          try {
            const items = Array.from(
              document.querySelectorAll('[data-testid="fallback-item"]')
            );

            const available: string[] = [];

            for (const item of items) {
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const phoneNumber = phoneHeader?.textContent?.trim() || "";

              // Only consider masked phone numbers (e.g. "*******408").
              if (!phoneNumber.includes("*")) continue;
              available.push(phoneNumber);

              if (phoneNumber.slice(-3) !== ourLastThree) continue;

              // The "Send me a text" link is wrapped by a div.fds-list-item-link.
              const wrappers = Array.from(
                item.querySelectorAll(".fds-list-item-link")
              );

              for (const wrapper of wrappers) {
                const text = wrapper.textContent?.trim() || "";
                if (text.includes("Send me a text")) {
                  const clickable =
                    (wrapper.querySelector("a, button") as HTMLElement | null) ||
                    (wrapper as HTMLElement);
                  clickable.click();
                  return { success: true, phoneNumber, available };
                }
              }
            }

            return { success: false, phoneNumber: "", available };
          } catch (error) {
            return {
              success: false,
              phoneNumber: "",
              available: [] as string[],
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        }, ourLastThree);

        await dualLogInfo("Fallback selection result:", JSON.stringify(clickResult));

        if (!clickResult.success) {
          throw new Error(
            `No matching phone number found in fallback options. Expected ending with ${ourLastThree}. Available options: ${
              clickResult.available?.join(", ") || "none found"
            }${clickResult.error ? `. Error: ${clickResult.error}` : ""}`
          );
        }

        await dualLogInfo(
          `Clicked 'Send me a text' for phone: ${clickResult.phoneNumber}`
        );
        await delay(3000);

        // Continue: wait for the SMS passcode input, then enter the code from email.
        await page.waitForSelector('input[name="passcode-input"]', {
          visible: true,
          timeout: selectorTimeout,
        });

        await dualLogInfo(
          "SMS verification page loaded, trying to get verification code from email..."
        );

        const smsOtpCheckpointUrl = page.url();
        await dualLogInfo(
          `OTP checkpoint URL (SMS path): ${smsOtpCheckpointUrl}`
        );
        await enterPasscodeFromEmailWithRetries(page, jobId, entityType, {
          otpCheckpointUrl: smsOtpCheckpointUrl,
          postVerifyUrlWaitMs: loadingTimeout,
          initialDelayMs: 30 * 1000,
        });
      } catch (fallbackError) {
        const errorMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : "Unknown error";
        await dualLogError(`Error with fallback verification: ${errorMessage}`);

        // Send email notification for fallback verification error
        if (jobId) {
          try {
          } catch (emailError) {
            await dualLogError(
              "Failed to send fallback verification error notification:",
              emailError
            );
          }
        }

        throw new Error(
          `Phone number mismatch and fallback verification failed. Expected ending with ${ourLastThree}, but got ${currentLastThree}. Fallback error: ${errorMessage}`
        );
      }
    }

    await dualLogInfo(
      "OTP verification finished: URL left MFA initiate (or checkpoint) after successful VERIFY."
    );
  } catch (error: any) {
    await dualLogError("Error in handleOtpVerification:", error);
    // Screenshot: OTP verification failed
    await takeScreenshot(page, jobId ?? "", "otp_failed", "error", "expedia", entityType);
    setFailedReasonCode(error, inferOtpFailedReasonCode(error?.message));

    // Send email notification for general OTP verification error
    if (jobId) {
      try {
      } catch (emailError) {
        await dualLogError(
          "Failed to send general OTP error notification:",
          emailError
        );
      }
    }

    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

export default handleOtpVerification;
