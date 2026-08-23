import { Browser, Page } from "puppeteer";
import mongoose from "mongoose";
import { browserSetupLocal } from "../browser-setup/browser-local.js";
import { browserSetupProduction } from "../browser-setup/browser-prod.js";
import { delay } from "../common/delay.js";
import { FAILED_REASON } from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  patchManyOtaVerificationFields,
  patchOtaVerificationFields,
} from "../common/ota-verification-patch.js";
import { clearPropertyScreenshots } from "../common/property-screenshot-store.js";
import { ScreenshotHelper } from "../common/screenshot-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import login from "../login/login.js";
import handleOtpVerification from "../otp-verification/otp-verification.js";

export interface PropertyToCheck {
  _id: string;
  expedia_id: string | number;
}

export interface PropertyCheckResult {
  _id: string;
  expedia_id: string | number;
  status: boolean;
  success_message: string;
  error_message: string;
}

const PROPERTY_SEARCH_INPUT = ".all-properties__search input.fds-field-input";

function isValidObjectId(id: string): boolean {
  return (
    mongoose.Types.ObjectId.isValid(id) &&
    new mongoose.Types.ObjectId(id).toString() === id
  );
}

/**
 * Marks every requested property as not credential-verified. Used when the
 * Expedia email/password is incorrect, so the credentials clearly can't be
 * trusted for any of these properties.
 */
async function markAllCredentialUnverified(
  properties: PropertyToCheck[]
): Promise<void> {
  const ids = properties
    .filter((p) => isValidObjectId(p._id))
    .map((p) => new mongoose.Types.ObjectId(p._id));

  if (ids.length === 0) {
    return;
  }

  try {
    await patchManyOtaVerificationFields(
      "expedia",
      ids.map((id) => id.toString()),
      { credential_verified: false }
    );
    await dualLogInfo(
      `Set expedia_credential_verified=false for ${ids.length} properties (login failed).`
    );
  } catch (error) {
    await dualLogError(
      "Failed to update expedia_credential_verified after login failure:",
      error
    );
  }
}

/**
 * Marks a single property as credential-verified with Expedia access. Used when
 * login succeeds and the property is found for this account.
 */
async function markPropertyVerified(propertyId: string): Promise<void> {
  if (!isValidObjectId(propertyId)) {
    console.error(
      `[property-check] Skipping DB update — invalid property _id: ${propertyId}`
    );
    return;
  }

  try {
    const result = await patchOtaVerificationFields("expedia", propertyId, {
      credential_verified: true,
      access_level: true,
    });

    if (result.matchedCount === 0) {
      const message = `[property-check] No property document matched _id=${propertyId}; flags were NOT updated.`;
      console.error(message);
      await dualLogError(message);
      return;
    }

    console.log(
      `[property-check] Updated property ${propertyId}: expedia_credential_verified=true, expedia_access_level=true (matched=${result.matchedCount}, modified=${result.modifiedCount})`
    );
    await dualLogInfo(
      `Set expedia_credential_verified=true and expedia_access_level=true for property ${propertyId}.`
    );
  } catch (error) {
    console.error(
      `[property-check] Failed to update verification flags for property ${propertyId}:`,
      error
    );
    await dualLogError(
      `Failed to update Expedia verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Marks a single property as credential-verified but without Expedia access.
 * Used when login succeeds but the property could not be found for this account.
 */
async function markAccessLevelFalse(propertyId: string): Promise<void> {
  if (!isValidObjectId(propertyId)) {
    console.error(
      `[property-check] Skipping DB update — invalid property _id: ${propertyId}`
    );
    return;
  }

  try {
    const result = await patchOtaVerificationFields("expedia", propertyId, {
      credential_verified: true,
      access_level: false,
    });

    if (result.matchedCount === 0) {
      const message = `[property-check] No property document matched _id=${propertyId}; verification flags were NOT updated.`;
      console.error(message);
      await dualLogError(message);
      return;
    }

    console.log(
      `[property-check] Updated property ${propertyId}: expedia_credential_verified=true, expedia_access_level=false (not found in Expedia account)`
    );
    await dualLogInfo(
      `Set expedia_credential_verified=true and expedia_access_level=false for property ${propertyId} (not found).`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update Expedia verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Types a single Expedia property id into the all-properties search box and
 * returns whether a matching row appears in the results table.
 */
async function searchSingleProperty(
  page: Page,
  expediaId: string,
  runId: string,
  propertyId: string
): Promise<boolean> {
  // Clear whatever is currently in the search box.
  await page.click(PROPERTY_SEARCH_INPUT, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await delay(500);

  // Type the property id and let the table filter (same pacing as property-search.ts).
  await page.type(PROPERTY_SEARCH_INPUT, expediaId, { delay: 500 });
  await delay(8000);

  await page.waitForSelector("tbody tr", { visible: true, timeout: 15000 });

  const found = await page.evaluate((searchId) => {
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    return rows.some((row) => {
      const idEl = row.querySelector(".property-cell__property-id span");
      return !!idEl?.textContent && idEl.textContent.includes(searchId);
    });
  }, expediaId);

  // Capture what the search actually returned, against this property only —
  // this is the evidence for the verdict written below.
  await ScreenshotHelper.takeScreenshotForProperties(
    page,
    runId,
    [propertyId],
    `property_search_${expediaId}_${found ? "found" : "not_found"}`,
    "step",
    "expedia"
  );

  console.log(
    `[property-check] Expedia search for id=${expediaId}: ${found ? "found" : "not found"}`
  );

  return found;
}

/**
 * Logs into Expedia Partner Central once (email/password + 2FA), then checks
 * each Expedia property id to see whether the property exists for this account.
 *
 * Throws if login or OTP verification fails (the whole operation cannot
 * proceed). Per-property errors are captured in the returned results.
 */
export async function checkExpediaProperties(
  email: string,
  password: string,
  properties: PropertyToCheck[]
): Promise<PropertyCheckResult[]> {
  const environment = process.env.ENVIRONMENT || "browserless";
  const sessionId = `property-check_${Date.now()}`;
  let browser: Browser | null = null;

  const propertyIds = properties.map((p) => p._id);

  // login/OTP guards require the scraping state to be "running".
  scrapingStateManager.startScraping("property-check", sessionId);

  try {
    // This run's screenshots replace whatever an earlier run stored, so the
    // property always shows the latest check rather than an endless history.
    try {
      await clearPropertyScreenshots("expedia", propertyIds);
    } catch (clearError) {
      await dualLogError(
        "Failed to clear previous Expedia property screenshots:",
        clearError
      );
    }

    // 1. Set up the browser at the Expedia login page.
    const setup =
      environment === "browserless"
        ? await browserSetupProduction(undefined, "expedia")
        : await browserSetupLocal(undefined, "expedia");
    browser = setup.browser;
    const page = setup.page;

    // 2. Login (throws with LOGIN_FAILED on bad credentials).
    try {
      await login(browser, page, email, password);
    } catch (loginError) {
      // Wrong email/password → none of these properties' credentials are valid.
      if (
        (loginError as any)?.failedReasonCode === FAILED_REASON.LOGIN_FAILED
      ) {
        await markAllCredentialUnverified(properties);
      }
      throw loginError;
    }
    await dualLogInfo("Login completed for property check.");
    await ScreenshotHelper.takeScreenshotForProperties(
      page,
      sessionId,
      propertyIds,
      "login_complete",
      "step",
      "expedia"
    );

    // 3. Resolve 2FA / OTP.
    await handleOtpVerification(browser, page);
    await dualLogInfo("OTP verification completed for property check.");
    await ScreenshotHelper.takeScreenshotForProperties(
      page,
      sessionId,
      propertyIds,
      "otp_complete",
      "step",
      "expedia"
    );

    // 4. Wait for the all-properties table and its search box.
    await page.waitForSelector(".fds-data-table-wrapper", { visible: true });
    await page.waitForSelector(PROPERTY_SEARCH_INPUT, { visible: true });
    await page.waitForSelector("tbody tr", { visible: true, timeout: 30000 });
    // Give the table time to fully populate (property-search.ts uses a long wait here).
    await delay(10000);

    // 5. Search each property id.
    const results: PropertyCheckResult[] = [];
    for (const property of properties) {
      const expediaId = String(property.expedia_id);
      try {
        const found = await searchSingleProperty(
          page,
          expediaId,
          sessionId,
          property._id
        );
        if (found) {
          console.log(
            `[property-check] Property ${expediaId} FOUND → calling markPropertyVerified(_id=${property._id})`
          );
          await markPropertyVerified(property._id);
        } else {
          console.log(
            `[property-check] Property ${expediaId} NOT FOUND → calling markAccessLevelFalse(_id=${property._id})`
          );
          // Logged in but property not found → no Expedia access for this property.
          await markAccessLevelFalse(property._id);
        }
        results.push({
          _id: property._id,
          expedia_id: property.expedia_id,
          status: found,
          success_message: found ? "Property found" : "",
          error_message: found ? "" : "Property not found",
        });
        await dualLogInfo(
          `Property ${expediaId} check: ${found ? "found" : "not found"}`
        );
      } catch (error: any) {
        results.push({
          _id: property._id,
          expedia_id: property.expedia_id,
          status: false,
          success_message: "",
          error_message: error?.message || "Failed to search property",
        });
        await dualLogError(`Error checking property ${expediaId}:`, error);
      }
    }

    return results;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        await dualLogError(
          "Error closing browser after property check:",
          closeError
        );
      }
    }
    scrapingStateManager.stopScraping();
  }
}
