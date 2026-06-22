import { Browser, Page } from "puppeteer";
import { browserSetupLocal } from "../browser-setup/browser-local.js";
import { browserSetupProduction } from "../browser-setup/browser-prod.js";
import { delay } from "../common/delay.js";
import { FAILED_REASON } from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import login from "../login/login.js";
import { Property } from "../models/property.model.js";
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

/**
 * Marks every requested property as not credential-verified. Used when the
 * Expedia email/password is incorrect, so the credentials clearly can't be
 * trusted for any of these properties.
 */
async function markAllCredentialUnverified(
  properties: PropertyToCheck[]
): Promise<void> {
  const ids = properties.map((p) => p._id);
  try {
    await Property.updateMany(
      { _id: { $in: ids } },
      { $set: { expedia_credential_verified: false } }
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
 * Marks a single property as not having Expedia access. Used when login
 * succeeds but the property could not be found for this account.
 */
async function markAccessLevelFalse(propertyId: string): Promise<void> {
  try {
    await Property.updateOne(
      { _id: propertyId },
      { $set: { expedia_access_level: false } }
    );
    await dualLogInfo(
      `Set expedia_access_level=false for property ${propertyId} (not found).`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update expedia_access_level for property ${propertyId}:`,
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
  expediaId: string
): Promise<boolean> {
  // Clear whatever is currently in the search box.
  await page.click(PROPERTY_SEARCH_INPUT, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await delay(500);

  // Type the property id and let the table filter.
  await page.type(PROPERTY_SEARCH_INPUT, expediaId, { delay: 150 });
  await delay(3000);

  return page.evaluate((searchId) => {
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    return rows.some((row) => {
      const idEl = row.querySelector(".property-cell__property-id span");
      return !!idEl?.textContent && idEl.textContent.includes(searchId);
    });
  }, expediaId);
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

  // login/OTP guards require the scraping state to be "running".
  scrapingStateManager.startScraping("property-check", sessionId);

  try {
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

    // 3. Resolve 2FA / OTP.
    await handleOtpVerification(browser, page);
    await dualLogInfo("OTP verification completed for property check.");

    // 4. Wait for the all-properties table and its search box.
    await page.waitForSelector(".fds-data-table-wrapper", { visible: true });
    await page.waitForSelector(PROPERTY_SEARCH_INPUT, { visible: true });
    await delay(5000);

    // 5. Search each property id.
    const results: PropertyCheckResult[] = [];
    for (const property of properties) {
      const expediaId = String(property.expedia_id);
      try {
        const found = await searchSingleProperty(page, expediaId);
        // Logged in but property not found → no Expedia access for this property.
        if (!found) {
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
