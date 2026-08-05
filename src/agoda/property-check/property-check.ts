import { Browser } from "puppeteer";
import mongoose from "mongoose";
import agodaLogin from "../login-system/login.js";
import { searchAgodaProperty } from "../property-search/property-search.js";
import { browserSetupLocal } from "../../browser-setup/browser-local.js";
import { browserSetupProduction } from "../../browser-setup/browser-prod.js";
import { configs, useRemoteBrowser } from "../../config/index.js";
import { isAgodaCredentialLoginFailure } from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import {
  patchManyOtaVerificationFields,
  patchOtaVerificationFields,
} from "../../common/ota-verification-patch.js";
import { scrapingStateManager } from "../../common/scraping-state.js";

export interface AgodaPropertyToCheck {
  _id: string;
  agoda_id: string | number;
}

export interface AgodaPropertyCheckResult {
  _id: string;
  agoda_id: string | number;
  status: boolean;
  success_message: string;
  error_message: string;
}

function formatUsDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function defaultSearchDateRange(): { startDate: string; endDate: string } {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  return {
    startDate: formatUsDate(startDate),
    endDate: formatUsDate(endDate),
  };
}

/**
 * Marks every requested property as not credential-verified. Used when the
 * Agoda username/password is incorrect, so the credentials clearly can't be
 * trusted for any of these properties.
 */
async function markAllAgodaCredentialUnverified(
  properties: AgodaPropertyToCheck[]
): Promise<void> {
  const ids = properties
    .filter((p) => mongoose.Types.ObjectId.isValid(p._id))
    .map((p) => new mongoose.Types.ObjectId(p._id));

  if (ids.length === 0) {
    return;
  }

  try {
    await patchManyOtaVerificationFields(
      "agoda",
      ids.map((id) => id.toString()),
      { credential_verified: false }
    );
    await dualLogInfo(
      `Set agoda_credential_verified=false for ${ids.length} properties (login failed).`
    );
  } catch (error) {
    await dualLogError(
      "Failed to update agoda_credential_verified after login failure:",
      error
    );
  }
}

/**
 * Marks a single property as credential-verified with Agoda access. Used when
 * login succeeds and the property is found for this account.
 */
async function markAgodaPropertyVerified(propertyId: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(propertyId)) {
    return;
  }

  try {
    const result = await patchOtaVerificationFields("agoda", propertyId, {
      credential_verified: true,
      access_level: true,
    });

    if (result.matchedCount === 0) {
      await dualLogError(
        `[agoda-check] No property document matched _id=${propertyId}; flags were NOT updated.`
      );
      return;
    }

    await dualLogInfo(
      `Set agoda_credential_verified=true and agoda_access_level=true for property ${propertyId}.`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update Agoda verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Marks a single property as credential-verified but without Agoda access.
 * Used when login succeeds but the property could not be found for this account.
 */
async function markAgodaAccessLevelFalse(propertyId: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(propertyId)) {
    return;
  }

  try {
    const result = await patchOtaVerificationFields("agoda", propertyId, {
      credential_verified: true,
      access_level: false,
    });

    if (result.matchedCount === 0) {
      await dualLogError(
        `[agoda-check] No property document matched _id=${propertyId}; flags were NOT updated.`
      );
      return;
    }

    await dualLogInfo(
      `Set agoda_credential_verified=true and agoda_access_level=false for property ${propertyId} (not found).`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update Agoda verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Logs into Agoda YCS once (email link / OTP via Gmail), then checks each
 * provided agoda_id for Reservations access.
 *
 * Throws if login fails (the whole operation cannot proceed). Per-property
 * errors are captured in the returned results.
 */
export async function checkAgodaProperties(
  username: string,
  password: string,
  properties: AgodaPropertyToCheck[],
  jobId?: string
): Promise<AgodaPropertyCheckResult[]> {
  const remoteBrowser = useRemoteBrowser();
  const sessionId = jobId || `agoda-check_${Date.now()}`;
  const { startDate, endDate } = defaultSearchDateRange();
  let browser: Browser | null = null;

  console.log(
    `[agoda-check] Starting job ${jobId ?? sessionId}: ENVIRONMENT=${
      process.env.ENVIRONMENT ?? "(unset → local)"
    }, browser=${remoteBrowser ? "remote (Browserless)" : "local"}, headless=${
      configs.headless_browser
    }, properties=${properties.length}`
  );

  scrapingStateManager.startScraping(sessionId, jobId || sessionId);

  try {
    const setup = remoteBrowser
      ? await browserSetupProduction(jobId)
      : await browserSetupLocal(jobId);
    browser = setup.browser;
    const page = setup.page;

    // Login (throws with AGODA_LOGIN_FAILED on bad credentials).
    try {
      await agodaLogin(browser, page, username, password, jobId);
    } catch (loginError) {
      // Wrong username/password → none of these properties' credentials are valid.
      // OTP / email-inbox failures are excluded (same rule as Expedia LOGIN_FAILED).
      if (isAgodaCredentialLoginFailure(loginError)) {
        await markAllAgodaCredentialUnverified(properties);
      }
      throw loginError;
    }
    await dualLogInfo("Agoda login completed for property check.");

    const results: AgodaPropertyCheckResult[] = [];
    for (const property of properties) {
      const agodaId = String(property.agoda_id);
      try {
        const searchResult = await searchAgodaProperty(
          browser,
          page,
          agodaId,
          startDate,
          endDate,
          jobId
        );

        if (searchResult.found) {
          await markAgodaPropertyVerified(property._id);
        } else {
          // Logged in but property not found → no Agoda access for this property.
          await markAgodaAccessLevelFalse(property._id);
        }

        results.push({
          _id: property._id,
          agoda_id: property.agoda_id,
          status: searchResult.found,
          success_message: searchResult.found ? "Property found" : "",
          error_message: searchResult.found ? "" : "Property not found",
        });
        await dualLogInfo(
          `Agoda property ${agodaId} check: ${searchResult.found ? "found" : "not found"}`
        );
      } catch (error: any) {
        results.push({
          _id: property._id,
          agoda_id: property.agoda_id,
          status: false,
          success_message: "",
          error_message: error?.message || "Failed to search property",
        });
        await dualLogError(`Error checking Agoda property ${agodaId}:`, error);
      }
    }

    return results;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        await dualLogError(
          "Error closing browser after Agoda property check:",
          closeError
        );
      }
    }
    scrapingStateManager.stopScraping();
  }
}
