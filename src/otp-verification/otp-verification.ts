import dotenv from "dotenv";
import { Types } from "mongoose";
import { Browser, Page } from "puppeteer";
import {
  inferOtpFailedReasonCode,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { takeScreenshot } from "../common/screenshot-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { OTAProvider } from "../models/job.model.js";
import { OtpCode } from "../models/otp-code.model.js";

dotenv.config();

/**
 * Partner Central MFA / passcode step lives here (e.g. after login).
 * https://www.expediapartnercentral.com/account/mfa/initiate
 */
const PARTNER_CENTRAL_MFA_INITIATE_PATH = "/account/mfa/initiate";

/** Brief pause between VERIFY clicks when cycling codes within the watch window. */
const OTP_WAIT_BETWEEN_SUBMIT_MS =
  Number(process.env.OTP_WAIT_BETWEEN_SUBMIT_MS) ||
  Number(process.env.OTP_WAIT_BETWEEN_RETRY_MS) ||
  2 * 1000;

const OTP_POST_SUBMIT_CHECK_MS =
  Number(process.env.OTP_POST_SUBMIT_CHECK_MS) || 5 * 1000;

/**
 * Hard cap on how long we wait for an OTP code to land in `otp_codes`
 * (provider=Expedia, job_id=current job). After this, the job fails.
 *
 * Default: 10 minutes — generous enough for slow inbox / SMS relay, but short
 * enough that a stuck job doesn't tie up a worker indefinitely.
 */
const OTP_DB_WAIT_MAX_MS =
  Number(process.env.OTP_DB_WAIT_MAX_MS) || 10 * 60 * 1000;

/** How often we re-query `otp_codes` while waiting. */
const OTP_DB_POLL_INTERVAL_MS =
  Number(process.env.OTP_DB_POLL_INTERVAL_MS) || 5 * 1000;

/** One unused OTP code as returned by the DB poller. We carry `_id` along
 * so the retry loop can flip exactly that doc to `used: true`. */
interface PendingOtpCode {
  _id: Types.ObjectId;
  otp_code: string;
}

/**
 * Single-pass query for fresh, unused Expedia OTP codes for this job.
 *
 * - `used: false` filters out codes we (or any prior attempt) already tried.
 * - `createdAt >= fromDate` filters out stale codes from a previous OTP
 *   attempt on the same job that would already be expired by Partner Central.
 *
 * On a transient DB error this returns `[]` and logs — the caller is in a
 * polling loop and will simply retry on the next tick.
 */
async function queryUnusedExpediaOtpCodes(
  jobId: string,
  fromDate: Date
): Promise<PendingOtpCode[]> {
  try {
    const docs = await OtpCode.find({
      provider: OTAProvider.Expedia,
      job_id: jobId,
      used: false,
      createdAt: { $gte: fromDate },
    })
      .sort({ createdAt: -1 })
      .select({ _id: 1, otp_code: 1 })
      .lean();

    return docs.map((d) => ({ _id: d._id, otp_code: d.otp_code }));
  } catch (queryError) {
    await dualLogError(
      `otp_codes query failed (will retry on next poll):`,
      queryError
    );
    return [];
  }
}

/**
 * Flip an OTP code's `used` flag to `true` after Partner Central accepted it.
 *
 * Called **only on successful verification**. Rejected codes are intentionally
 * left `used: false` — the row stays in the DB as historical evidence, and
 * the in-memory `triedIds` set already prevents the scraper from re-submitting
 * them within the current watch window.
 *
 * Best effort: a failed update is logged but never aborts the OTP flow.
 */
async function markOtpCodeUsed(otpCodeId: Types.ObjectId): Promise<void> {
  try {
    await OtpCode.updateOne(
      { _id: otpCodeId, used: false },
      { $set: { used: true } }
    );
  } catch (markError) {
    await dualLogError(
      `Failed to mark otp_codes._id=${otpCodeId} as used (will continue):`,
      markError
    );
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
 * Watch `otp_codes` (provider=Expedia, job_id=current job) for the entire
 * `waitTimeoutMs` window (default 10 minutes). The loop:
 *
 *   1. Polls every `OTP_DB_POLL_INTERVAL_MS` for unused codes (`used:false`).
 *   2. As soon as new code(s) appear, submits each on Partner Central
 *      (newest-first). On acceptance, flips that exact doc to `used:true`
 *      and returns. Rejected codes stay `used:false` in the DB; an in-memory
 *      `triedIds` set prevents re-submitting them within this watch window.
 *   3. If a code is rejected, **keeps polling** for codes inserted later in
 *      the window — so a re-issued / fresher code that arrives mid-loop
 *      still gets a chance.
 *   4. When the deadline is reached without success, throws a descriptive
 *      error so the worker fails the job.
 *
 * `jobId` is required because otp_codes is keyed on it.
 */
async function enterPasscodeWithRetries(
  page: Page,
  jobId: string | undefined,
  entityType: "job" | "retrieval",
  options: {
    otpCheckpointUrl: string;
    postVerifyUrlWaitMs: number;
    /**
     * How long to keep watching `otp_codes` before giving up. Defaults to
     * `OTP_DB_WAIT_MAX_MS` (10 min). Drives the entire poll+submit loop.
     */
    waitTimeoutMs?: number;
  }
): Promise<void> {
  if (!jobId) {
    throw new Error(
      "Cannot fetch OTP from otp_codes: jobId is required (codes are looked up by provider + job_id)"
    );
  }

  const { otpCheckpointUrl, postVerifyUrlWaitMs, waitTimeoutMs } = {
    waitTimeoutMs: OTP_DB_WAIT_MAX_MS,
    ...options,
  };

  const start = Date.now();
  const fromDate = new Date(start);
  const triedIds = new Set<string>();
  // Log "still waiting" only every Nth empty poll to keep logs quiet.
  const QUIET_LOG_EVERY_N_POLLS = 6;

  let pollCount = 0;
  let submitCount = 0;

  await dualLogInfo(
    `Watching otp_codes for Expedia OTP (job=${jobId}, used=false) for up to ${
      waitTimeoutMs / 60000
    } min, polling every ${OTP_DB_POLL_INTERVAL_MS / 1000}s...`
  );

  while (Date.now() - start < waitTimeoutMs) {
    pollCount++;

    const allCandidates = await queryUnusedExpediaOtpCodes(jobId, fromDate);
    const candidates = allCandidates.filter(
      (c) => !triedIds.has(c._id.toString())
    );

    if (candidates.length === 0) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const remainingSec = Math.max(
        0,
        Math.round((waitTimeoutMs - (Date.now() - start)) / 1000)
      );
      if (pollCount % QUIET_LOG_EVERY_N_POLLS === 0) {
        await dualLogInfo(
          `Still watching otp_codes (poll #${pollCount}, ${elapsedSec}s elapsed, ${remainingSec}s remaining, ${submitCount} submit(s) so far)...`
        );
      }
      await delay(OTP_DB_POLL_INTERVAL_MS);
      continue;
    }

    await dualLogInfo(
      `Poll #${pollCount}: found ${candidates.length} new unused code(s); submitting newest-first.`
    );

    for (const candidate of candidates) {
      // Re-check the deadline before each submit — if the window is up,
      // bail out cleanly instead of starting another VERIFY click.
      if (Date.now() - start >= waitTimeoutMs) {
        break;
      }

      const { _id: pendingId, otp_code: code } = candidate;
      triedIds.add(pendingId.toString());
      submitCount++;

      const elapsedSec = Math.round((Date.now() - start) / 1000);
      await dualLogInfo(
        `OTP submit #${submitCount} (${elapsedSec}s into ${
          waitTimeoutMs / 60000
        }-min window): trying code ${code}`
      );

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
        // Partner Central accepted this exact code — flip ONLY this doc to
        // `used: true`. Other (rejected) codes stay `used: false`; the
        // in-memory `triedIds` set above prevents re-submitting them in
        // this same watch window.
        await markOtpCodeUsed(pendingId);

        await waitUntilUrlLeavesMfaOtpPage(
          page,
          otpCheckpointUrl,
          postVerifyUrlWaitMs
        );
        await takeScreenshot(
          page,
          jobId,
          "otp_submitted",
          "step",
          "expedia",
          entityType
        );
        await dualLogInfo(
          `OTP accepted on submit #${submitCount} after ${elapsedSec}s; otp_codes._id=${pendingId} marked used=true.`
        );
        return;
      }

      // Rejected: leave `used: false` in the DB so the row remains as
      // historical evidence; only the in-memory triedIds set blocks a retry.
      const remainingSec = Math.max(
        0,
        Math.round((waitTimeoutMs - (Date.now() - start)) / 1000)
      );
      await dualLogInfo(
        `Partner Central rejected code (otp_codes._id=${pendingId} kept used=false); will keep watching otp_codes for newer codes (${remainingSec}s remaining in window).`
      );

      // Brief breather before next click — applies whether the next code is
      // already in `candidates` or arrives on a later poll.
      await delay(OTP_WAIT_BETWEEN_SUBMIT_MS);
    }
  }

  // Window elapsed. Distinguish "no codes ever appeared" from
  // "tried codes but all rejected" so the failed_reason is actionable.
  if (submitCount === 0) {
    throw new Error(
      `Failed to get verification code from otp_codes within ${
        waitTimeoutMs / 60000
      } minute(s) (provider=Expedia, job=${jobId}, polls=${pollCount}).`
    );
  }
  throw new Error(
    `OTP verification failed: tried ${submitCount} code(s) within ${
      waitTimeoutMs / 60000
    } minute(s); all rejected by Partner Central (provider=Expedia, job=${jobId}, polls=${pollCount}).`
  );
}

async function handleOtpVerification(
  browser: Browser,
  page: Page,
  jobId?: string,
  entityType: "job" | "retrieval" = "job",
  /**
   * Phone number to match against Partner Central's "We sent a passcode to ***-***-XXX"
   * box. Comes from `Property.phone_number` (assigned via `PhoneNumberSlot`).
   *
   * Falls back to `OUR_CONTACT` env var (legacy single-number deployment).
   */
  phoneNumber?: string
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

    // Prefer the phone number assigned to the property via PhoneNumberSlot,
    // then env fallback (legacy single-number deployment), then a hard-coded
    // last-resort default so we never throw at this comparison step.
    const ourContact =
      (phoneNumber && phoneNumber.trim()) ||
      process.env.OUR_CONTACT ||
      "01828704004";

    if (phoneNumber && phoneNumber.trim()) {
      await dualLogInfo(
        `Using property-assigned phone number for OTP verification.`
      );
    } else {
      await dualLogInfo(
        "No property-assigned phone number; falling back to env OUR_CONTACT."
      );
    }

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
        "Phone numbers match! Using DB-backed OTP verification flow..."
      );

      try {
        await enterPasscodeWithRetries(page, jobId, entityType, {
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

        await dualLogInfo(
          "Found fallbacks section, clicking dropdown arrow..."
        );

        // Click the dropdown arrow to expand options
        await page.click('[data-testid="fallbacks-toggle"]');
        await delay(2000);

        // Wait for the dropdown to fully expand and items to be visible
        await dualLogInfo("Waiting for fallback items to be visible...");
        await page.waitForSelector('[data-testid="fallback-item"]', {
          visible: true,
          timeout: selectorTimeout,
        });

        // Additional wait to ensure all content is loaded
        await delay(3000);

        await dualLogInfo(
          "Dropdown opened, looking for matching phone number..."
        );

        // First, let's check if the elements exist at all
        const elementsExist = await page.evaluate(() => {
          try {
            const fallbackItems = document.querySelectorAll(
              '[data-testid="fallback-item"]'
            );
            const itemsInfo = [];

            for (let i = 0; i < fallbackItems.length; i++) {
              const item = fallbackItems[i];
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const textLink = item.querySelector(".fds-list-item-link a");

              itemsInfo.push({
                hasPhoneHeader: !!phoneHeader,
                hasTextLink: !!textLink,
                phoneText: phoneHeader?.textContent?.trim() || "N/A",
                linkText: textLink?.textContent?.trim() || "N/A",
              });
            }

            return {
              success: true,
              itemCount: fallbackItems.length,
              items: itemsInfo,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        });

        await dualLogInfo(
          "Elements check result:",
          JSON.stringify(elementsExist, null, 2)
        );

        if (!elementsExist || !elementsExist.success) {
          throw new Error(
            `Failed to check fallback elements: ${
              elementsExist?.error || "Unknown error"
            }`
          );
        }

        if (elementsExist.itemCount === 0) {
          throw new Error("No fallback items found in the dropdown");
        }

        // Now look for phone numbers in the fallback options
        await dualLogInfo("Looking for phone ending with:", ourLastThree);

        const matchingOption = await page.evaluate((ourLastThree) => {
          try {
            const fallbackItems = document.querySelectorAll(
              '[data-testid="fallback-item"]'
            );

            console.log("Found fallback items:", fallbackItems.length);

            for (let i = 0; i < fallbackItems.length; i++) {
              const item = fallbackItems[i];
              const phoneHeader = item.querySelector(
                ".fds-list-item-content-header"
              );
              const textLink = item.querySelector(".fds-list-item-link a");

              if (phoneHeader && textLink) {
                const phoneNumber = phoneHeader.textContent?.trim() || "";
                const linkText = textLink.textContent?.trim() || "";

                console.log("Found item:", phoneNumber);

                // Check if this is a phone number (contains asterisks and digits)
                if (
                  phoneNumber.includes("*") &&
                  linkText === "Send me a text"
                ) {
                  // Extract last 3 digits from the phone number
                  const phoneLastThree = phoneNumber.slice(-3);

                  if (phoneLastThree === ourLastThree) {
                    console.log("Found matching phone number!");
                    return {
                      found: true,
                      phoneNumber: phoneNumber,
                      element: item,
                    };
                  }
                }
              }
            }

            console.log("No matching phone number found");
            return { found: false, phoneNumber: null };
          } catch (error) {
            console.error(
              "Error in page.evaluate:",
              error instanceof Error ? error.message : "Unknown error"
            );
            return {
              found: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        }, ourLastThree);

        await dualLogInfo(`Matching option result:`, matchingOption);

        if (!matchingOption) {
          // If page.evaluate returned undefined, try a simpler approach
          await dualLogInfo(
            "page.evaluate returned undefined, trying alternative approach..."
          );

          // Try clicking on the first "Send me a text" link that contains digits ending with our number
          const alternativeClick = await page.evaluate((ourLastThree) => {
            try {
              const textLinks = Array.from(
                document.querySelectorAll(".fds-list-item-link a")
              );

              for (const link of textLinks) {
                if (link.textContent?.trim() === "Send me a text") {
                  const item = link.closest('[data-testid="fallback-item"]');
                  if (item) {
                    const phoneHeader = item.querySelector(
                      ".fds-list-item-content-header"
                    );
                    if (phoneHeader) {
                      const phoneNumber = phoneHeader.textContent?.trim() || "";
                      if (phoneNumber.slice(-3) === ourLastThree) {
                        (link as HTMLElement).click();
                        return { success: true, phoneNumber: phoneNumber };
                      }
                    }
                  }
                }
              }
              return {
                success: false,
                error: "No matching phone found in alternative approach",
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }, ourLastThree);

          if (alternativeClick.success) {
            await dualLogInfo(
              `Alternative approach succeeded: clicked 'Send me a text' for ${alternativeClick.phoneNumber}`
            );
            await delay(3000);

            // Continue with verification process
            await page.waitForSelector('input[name="passcode-input"]', {
              visible: true,
              timeout: selectorTimeout,
            });

            await dualLogInfo(
              "SMS verification page loaded, polling otp_codes for the code..."
            );
            const smsOtpCheckpointUrl = page.url();
            await dualLogInfo(
              `OTP checkpoint URL (SMS path): ${smsOtpCheckpointUrl}`
            );
            await enterPasscodeWithRetries(page, jobId, entityType, {
              otpCheckpointUrl: smsOtpCheckpointUrl,
              postVerifyUrlWaitMs: loadingTimeout,
            });
          } else {
            throw new Error(
              `Both primary and alternative approaches failed: ${alternativeClick.error}`
            );
          }
        } else if (matchingOption.error) {
          throw new Error(`Error in page evaluation: ${matchingOption.error}`);
        } else if (matchingOption.found) {
          await dualLogInfo(
            `Found matching phone number: ${matchingOption.phoneNumber}`
          );

          // Click on "Send me a text" for the matching phone number
          const clickResult = await page.evaluate((ourLastThree) => {
            try {
              const fallbackItems = document.querySelectorAll(
                '[data-testid="fallback-item"]'
              );

              for (const item of fallbackItems) {
                const phoneHeader = item.querySelector(
                  ".fds-list-item-content-header"
                );
                const textLink = item.querySelector(".fds-list-item-link a");

                if (
                  phoneHeader &&
                  textLink &&
                  textLink.textContent?.trim() === "Send me a text"
                ) {
                  const phoneNumber = phoneHeader.textContent?.trim() || "";
                  if (phoneNumber.slice(-3) === ourLastThree) {
                    (textLink as HTMLElement).click();
                    return { success: true, phoneNumber: phoneNumber };
                  }
                }
              }
              return {
                success: false,
                error: "Could not find matching phone to click",
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          }, ourLastThree);

          if (!clickResult.success) {
            throw new Error(
              `Failed to click "Send me a text": ${clickResult.error}`
            );
          }

          await dualLogInfo(
            `Clicked 'Send me a text' for phone: ${clickResult.phoneNumber}`
          );
          await delay(3000);

          // Wait for SMS verification page to load
          await page.waitForSelector('input[name="passcode-input"]', {
            visible: true,
            timeout: selectorTimeout,
          });

          await dualLogInfo(
            "SMS verification page loaded, polling otp_codes for the code..."
          );

          const smsOtpCheckpointUrl = page.url();
          await dualLogInfo(
            `OTP checkpoint URL (SMS path): ${smsOtpCheckpointUrl}`
          );
          await enterPasscodeWithRetries(page, jobId, entityType, {
            otpCheckpointUrl: smsOtpCheckpointUrl,
            postVerifyUrlWaitMs: loadingTimeout,
          });
        } else {
          throw new Error(
            `No matching phone number found in fallback options. Expected ending with ${ourLastThree}. Available options: ${
              matchingOption.phoneNumber || "none found"
            }`
          );
        }
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
