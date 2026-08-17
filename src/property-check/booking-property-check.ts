import mongoose from "mongoose";
import { Page } from "puppeteer";
import {
  BOOKING_SELECTORS,
  PASSWORD_MISMATCH_PATTERNS,
} from "../common/booking-selectors.js";
import { delay } from "../common/delay.js";
import {
  getFailedReasonForUser,
  isFatalBookingGroupAbortError,
} from "../common/failed-reason.js";
import { humanType } from "../common/human-browser-helper.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  patchManyOtaVerificationFields,
  patchOtaVerificationFields,
} from "../common/ota-verification-patch.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { SelectorUtils } from "../common/selector-utils.js";
import { BookingScraper, ScraperContext } from "../scrapers/booking-scraper.js";

export interface BookingPropertyToCheck {
  _id: string;
  booking_id: string | number;
}

export interface BookingPropertyCheckResult {
  _id: string;
  booking_id: string | number;
  status: boolean;
  success_message: string;
  error_message: string;
}

function isValidObjectId(id: string): boolean {
  return (
    mongoose.Types.ObjectId.isValid(id) &&
    new mongoose.Types.ObjectId(id).toString() === id
  );
}

/**
 * Marks every requested property as not credential-verified. Used when the
 * Booking.com email/password is rejected, so the credentials clearly can't be
 * trusted for any of these properties.
 */
async function markAllCredentialUnverified(
  properties: BookingPropertyToCheck[]
): Promise<void> {
  const ids = properties
    .filter((p) => isValidObjectId(p._id))
    .map((p) => p._id);

  if (ids.length === 0) {
    return;
  }

  try {
    await patchManyOtaVerificationFields("booking", ids, {
      credential_verified: false,
    });
    await dualLogInfo(
      `Set booking_credential_verified=false for ${ids.length} properties (login failed).`
    );
  } catch (error) {
    await dualLogError(
      "Failed to update booking_credential_verified after login failure:",
      error
    );
  }
}

/**
 * Marks a single property as credential-verified with Booking.com access. Used
 * when login succeeds and the property is found for this account.
 */
async function markPropertyVerified(propertyId: string): Promise<void> {
  if (!isValidObjectId(propertyId)) {
    console.error(
      `[booking-property-check] Skipping DB update — invalid property _id: ${propertyId}`
    );
    return;
  }

  try {
    const result = await patchOtaVerificationFields("booking", propertyId, {
      credential_verified: true,
      access_level: true,
    });

    if (result.matchedCount === 0) {
      const message = `[booking-property-check] No property document matched _id=${propertyId}; flags were NOT updated.`;
      console.error(message);
      await dualLogError(message);
      return;
    }

    await dualLogInfo(
      `Set booking_credential_verified=true and booking_access_level=true for property ${propertyId}.`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update Booking.com verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Marks a single property as credential-verified but without Booking.com
 * access. Used when login succeeds but the property could not be found for
 * this account.
 */
async function markAccessLevelFalse(propertyId: string): Promise<void> {
  if (!isValidObjectId(propertyId)) {
    console.error(
      `[booking-property-check] Skipping DB update — invalid property _id: ${propertyId}`
    );
    return;
  }

  try {
    const result = await patchOtaVerificationFields("booking", propertyId, {
      credential_verified: true,
      access_level: false,
    });

    if (result.matchedCount === 0) {
      const message = `[booking-property-check] No property document matched _id=${propertyId}; verification flags were NOT updated.`;
      console.error(message);
      await dualLogError(message);
      return;
    }

    await dualLogInfo(
      `Set booking_credential_verified=true and booking_access_level=false for property ${propertyId} (not found).`
    );
  } catch (error) {
    await dualLogError(
      `Failed to update Booking.com verification flags for property ${propertyId}:`,
      error
    );
  }
}

/**
 * Reads the visible sign-in error text (not bundled JS/i18n strings) so a
 * genuine credential rejection can be told apart from a Booking.com
 * server-side error. Same visible-only technique the scraper uses.
 */
async function getVisibleLoginErrorText(page: Page): Promise<string> {
  try {
    return await page.evaluate((selectors) => {
      const candidates = [
        ...selectors.flatMap((s) => Array.from(document.querySelectorAll(s))),
        ...Array.from(document.querySelectorAll("span.error-block")),
      ];

      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = el.textContent?.replace(/\s+/g, " ").trim();
        if (text) return text;
      }
      return "";
    }, [...BOOKING_SELECTORS.errorMessages]);
  } catch {
    return "";
  }
}

/**
 * True only when Booking.com actually rejected the username/password. A
 * server-side error ("Sign in failed, try again later"), a 2FA problem or a
 * broken selector must NOT flip `booking_credential_verified` to false —
 * that would write a wrong verdict back to the DBMS.
 */
function isCredentialRejection(visibleErrorText: string): boolean {
  if (!visibleErrorText) return false;
  return PASSWORD_MISMATCH_PATTERNS.some((pattern) =>
    pattern.test(visibleErrorText)
  );
}

/**
 * Reads the hotel id Booking.com landed on, for accounts that hold exactly one
 * property and therefore never show a property list to search.
 */
function readLandedHotelId(page: Page): string | null {
  const match = /[?&]hotel_id=(\d+)/.exec(page.url());
  return match ? match[1] : null;
}

/**
 * Types a single Booking.com hotel id into the property search box and reports
 * whether a matching entry appears in the results.
 *
 * Unlike {@link BookingScraper.searchProperty} this never clicks the result —
 * the check must stay on the property list so the next id can be searched.
 */
async function searchSingleProperty(
  page: Page,
  searchInputSelector: string,
  bookingId: string
): Promise<boolean> {
  // Clear whatever is currently in the search box.
  await page.click(searchInputSelector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await delay(500);

  await humanType(page, searchInputSelector, bookingId);
  // Let the property list filter down.
  await delay(8000);

  const found = await page.evaluate((searchId) => {
    const links = Array.from(document.querySelectorAll("a[href]"));

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href.includes(`hotel_id=${searchId}`)) {
        return true;
      }
    }

    // Fall back to matching the id as visible text in the results.
    return links.some((link) => link.textContent?.trim() === searchId);
  }, bookingId);

  await dualLogInfo(
    `[booking-property-check] Search for hotel_id=${bookingId}: ${
      found ? "found" : "not found"
    }`
  );

  return found;
}

/**
 * Logs into Booking.com Partner Admin once (email/password + captcha + 2FA),
 * then checks each Booking.com property id to see whether the property exists
 * for this account.
 *
 * Throws if login or 2FA fails (the whole operation cannot proceed).
 * Per-property errors are captured in the returned results.
 */
export async function checkBookingProperties(
  username: string,
  password: string,
  properties: BookingPropertyToCheck[]
): Promise<BookingPropertyCheckResult[]> {
  const sessionId = `booking-property-check_${Date.now()}`;
  const scraper = new BookingScraper(ScraperContext.TRUST_VERIFICATION);

  // login/2FA guards require the scraping state to be "running".
  scrapingStateManager.startScraping("booking-property-check", sessionId);

  try {
    // 1. Set up the browser at the Booking.com login page.
    const { browser, page } = await scraper.setupBrowser(undefined, username);
    scraper.setBrowserData(page, browser);

    // 2. Login. Captcha, account-lock and 2FA are resolved inside login().
    try {
      await scraper.login({ email: username, password });
    } catch (loginError) {
      // Only a genuine username/password rejection invalidates the
      // credentials for every property on this account.
      const visibleError = await getVisibleLoginErrorText(page);
      if (isCredentialRejection(visibleError)) {
        await markAllCredentialUnverified(properties);
      } else {
        await dualLogInfo(
          `[booking-property-check] Login failed without a credential rejection (visible: "${
            visibleError || "none"
          }") — leaving booking_credential_verified untouched.`
        );
      }
      throw loginError;
    }
    await dualLogInfo("Login completed for Booking.com property check.");

    // 3. Wait for the property list and its search box. Single-property
    // accounts land straight on that property's dashboard and never show a
    // list, so fall back to the hotel id in the landed URL.
    const isMultiProperty = await scraper.checkMultiPropertyAccount();

    const searchInputSelector = isMultiProperty
      ? await SelectorUtils.waitForSelector(
          page,
          [...BOOKING_SELECTORS.property.searchInput],
          30000
        )
      : null;

    const landedHotelId = searchInputSelector ? null : readLandedHotelId(page);

    if (!searchInputSelector && !landedHotelId) {
      throw new Error(
        "Booking.com property search input not found and no hotel_id in the landed URL — cannot check properties"
      );
    }

    if (landedHotelId) {
      await dualLogInfo(
        `[booking-property-check] Single-property account — comparing against landed hotel_id=${landedHotelId}`
      );
    } else {
      // Give the property list time to fully populate.
      await delay(5000);
    }

    // 4. Search each property id.
    const results: BookingPropertyCheckResult[] = [];
    for (const [index, property] of properties.entries()) {
      const bookingId = String(property.booking_id);
      try {
        const found = searchInputSelector
          ? await searchSingleProperty(page, searchInputSelector, bookingId)
          : landedHotelId === bookingId;

        if (found) {
          await markPropertyVerified(property._id);
        } else {
          // Logged in but property not found → no Booking.com access.
          await markAccessLevelFalse(property._id);
        }

        results.push({
          _id: property._id,
          booking_id: property.booking_id,
          status: found,
          success_message: found ? "Property found" : "",
          error_message: found ? "" : "Property not found",
        });
      } catch (error: any) {
        results.push({
          _id: property._id,
          booking_id: property.booking_id,
          status: false,
          success_message: "",
          error_message: error?.message || "Failed to search property",
        });
        await dualLogError(`Error checking property ${bookingId}:`, error);

        // A Booking.com account-wide block (rate limit, "sign in failed —
        // try again later", technical difficulties) will hit every remaining
        // property too. Record them as unchecked rather than burning through
        // the account, and leave their DB flags untouched — "we couldn't
        // check" is not the same verdict as "no access".
        if (isFatalBookingGroupAbortError(error)) {
          const reason =
            getFailedReasonForUser(error) ||
            error?.message ||
            "Booking.com blocked further checks";

          await dualLogError(
            `[booking-property-check] Aborting remaining ${
              properties.length - index - 1
            } propert(ies) — ${reason}`
          );

          for (const remaining of properties.slice(index + 1)) {
            results.push({
              _id: remaining._id,
              booking_id: remaining.booking_id,
              status: false,
              success_message: "",
              error_message: `Not checked — ${reason}`,
            });
          }
          break;
        }
      }
    }

    return results;
  } finally {
    try {
      await scraper.cleanup();
    } catch (cleanupError) {
      await dualLogError(
        "Error cleaning up browser after Booking.com property check:",
        cleanupError
      );
    }
    scrapingStateManager.stopScraping();
  }
}
