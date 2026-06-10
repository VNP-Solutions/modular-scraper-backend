import { Page } from "puppeteer";
import {
  getRetrievalJobId,
  isOtpReleasedForRetrieval,
  markOtpReleasedForRetrieval,
} from "../../agoda-retriveal.js";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { otpStatusManager } from "../../common/otp-status-manager.js";
import { takeScreenshot } from "../../common/screenshot-helper.js";
import { retrievalService } from "../../services/retriveal-job.service.js";
import { getYcsRetrievalOtpCode } from "../utils/retriveal-email.js";
import {
  BOOKING_DETAIL,
  BOOKING_RESULTS,
  BOOKING_SEARCH,
  OTP_CHECK_SELECTORS,
  OTP_VERIFICATION,
  UPC_WIDGET,
} from "../utils/selectors.js";

/** Data extracted from the booking result table row (guest name, stay dates, etc.) */
export interface BookingRowData {
  guest_name: string;
  check_in_date: Date | null;
  check_out_date: Date | null;
  check_in_str: string | null;
  check_out_str: string | null;
  reservation_status: string;
  room_type: string;
}

const AGODA_ROW_DATE_PATTERN =
  /([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/;

/** Matches short or long stay-date text (e.g. "Apr 26, 2026" or "Sunday, April 26, 2026") */
const AGODA_STAY_DATE_PART_PATTERN =
  /(?:[A-Za-z]+,\s+)?([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/g;

const AGODA_ROW_MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse date string from Agoda row (e.g. "Mar 11, 2026", "Mar 14, 2026")
 * Uses UTC calendar date so check-in/check-out match the UI regardless of server TZ.
 */
function parseAgodaRowDate(text: string): Date | null {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/\s*-\s*$/, "").trim();
  if (!cleaned) return null;

  const match = cleaned.match(AGODA_ROW_DATE_PATTERN);
  if (match) {
    const month = AGODA_ROW_MONTH_MAP[match[1].toLowerCase().slice(0, 3)];
    if (month === undefined) return null;
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    const parsed = new Date(Date.UTC(year, month, day));
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * Parse a stay-date range string into check-in / check-out text parts.
 * Handles "Apr 26, 2026 - Apr 27, 2026" and "Sunday, April 26, 2026 - Monday, April 27, 2026".
 */
function parseStayDateRangeText(text: string): {
  checkInStr: string | null;
  checkOutStr: string | null;
} {
  if (!text?.trim()) return { checkInStr: null, checkOutStr: null };

  const matches = [...text.matchAll(AGODA_STAY_DATE_PART_PATTERN)];
  if (matches.length < 2) return { checkInStr: null, checkOutStr: null };

  const toShortDate = (m: RegExpMatchArray) =>
    `${m[1]} ${m[2]}, ${m[3]}`;

  return {
    checkInStr: toShortDate(matches[0]),
    checkOutStr: toShortDate(matches[1]),
  };
}

function bookingRowDataFromDateStrings(
  checkInStr: string | null,
  checkOutStr: string | null,
  partial?: BookingRowData | null
): BookingRowData | null {
  if (!checkInStr || !checkOutStr) return null;

  const checkInDate = parseAgodaRowDate(checkInStr);
  const checkOutDate = parseAgodaRowDate(checkOutStr);
  if (!checkInDate || !checkOutDate) return null;

  return {
    guest_name: partial?.guest_name ?? "",
    check_in_str: checkInStr,
    check_out_str: checkOutStr,
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    reservation_status: partial?.reservation_status ?? "",
    room_type: partial?.room_type ?? "",
  };
}

/**
 * Wait until sidebar summary or accordion stay-date content is in the DOM.
 * Tab list alone is not enough — summary card loads asynchronously.
 */
async function waitForSidebarStayDatesContent(
  page: Page,
  bookingId: string
): Promise<void> {
  const jobId = getRetrievalJobId();

  try {
    await Promise.race([
      page.waitForSelector(BOOKING_DETAIL.SUMMARY_STAY_DATES, {
        visible: true,
        timeout: 15000,
      }),
      page.waitForSelector(BOOKING_DETAIL.ACCORDION_STAY_DATES, {
        visible: true,
        timeout: 15000,
      }),
      page.waitForSelector(BOOKING_DETAIL.ACCORDION_STAY_DATES_VALUE, {
        visible: true,
        timeout: 15000,
      }),
      page.waitForSelector(BOOKING_DETAIL.SHORT_SUMMARY, {
        visible: true,
        timeout: 15000,
      }),
    ]);
    await dualLogInfo("Sidebar stay-date container appeared", {
      jobId,
      bookingId,
    });
    await delay(500);
  } catch {
    await dualLogInfo(
      "Sidebar stay-date container wait timed out (will still try to read)",
      { jobId, bookingId }
    );
  }
}

/**
 * Wait for accordion "Stay dates" row in booking details (below summary card).
 */
async function waitForAccordionStayDateSection(
  page: Page,
  bookingId: string
): Promise<void> {
  const jobId = getRetrievalJobId();

  try {
    await page.waitForSelector(BOOKING_DETAIL.ACCORDION_STAY_DATES, {
      visible: true,
      timeout: 10000,
    });
    await page.evaluate((accordionSelector: string) => {
      const el = document.querySelector(accordionSelector);
      el?.scrollIntoView({ block: "center", behavior: "instant" });
    }, BOOKING_DETAIL.ACCORDION_STAY_DATES);
    await delay(400);
    await dualLogInfo("Accordion stay-date section ready", { jobId, bookingId });
  } catch {
    await dualLogInfo(
      "Accordion stay-date section wait timed out (will still try to read)",
      { jobId, bookingId }
    );
  }
}

/**
 * Extract stay dates from the booking detail sidebar (fallback when table row fails).
 * Tries in order until a full check-in + check-out range is parsed:
 * 1) Summary block — "Apr 26, 2026 - Apr 27, 2026"
 * 2) Accordion value — "Saturday, March 21, 2026 - Sunday, March 22, 2026"
 * 3) Accordion row — same text via parent [data-testid="accordion-staydate"]
 */
async function extractStayDatesFromSidebar(
  page: Page
): Promise<{
  checkInStr: string | null;
  checkOutStr: string | null;
  source: string;
  debug?: Record<string, unknown>;
}> {
  const result = await page.evaluate(
    (selectors: {
      panel: string;
      summary: string;
      accordionRow: string;
      accordionValue: string;
    }) => {
      const panel =
        document.querySelector("#detail-side-panel") ||
        document.querySelector(selectors.panel);

      const queryScoped = (selector: string): Element | null =>
        panel?.querySelector(selector) ?? document.querySelector(selector);

      const dateInText = (text: string) =>
        /[A-Za-z]{3,}\s+\d{1,2},\s*\d{4}/.test(text);

      const readDateText = (root: Element | null): string | null => {
        if (!root) return null;
        for (const p of Array.from(root.querySelectorAll("p"))) {
          const t = (p.textContent || "").trim();
          if (t && dateInText(t)) return t;
        }
        const cellText = (root.textContent || "").trim();
        return dateInText(cellText) ? cellText : null;
      };

      const candidates: { text: string; source: string }[] = [];

      const summaryBlock = queryScoped(selectors.summary);
      const summaryText = readDateText(summaryBlock);
      if (summaryText) {
        candidates.push({ text: summaryText, source: "summary-staydates" });
      }

      const accordionValueBlock = queryScoped(selectors.accordionValue);
      const accordionValueText = readDateText(accordionValueBlock);
      if (accordionValueText) {
        candidates.push({
          text: accordionValueText,
          source: "accordion-staydate-value",
        });
      }

      const accordionRowBlock = queryScoped(selectors.accordionRow);
      const accordionRowText = readDateText(accordionRowBlock);
      if (
        accordionRowText &&
        accordionRowText !== accordionValueText
      ) {
        candidates.push({
          text: accordionRowText,
          source: "accordion-staydate",
        });
      }

      return {
        candidates,
        debug: {
          hasPanel: !!panel,
          hasSummaryBlock: !!summaryBlock,
          hasAccordionValueBlock: !!accordionValueBlock,
          hasAccordionRowBlock: !!accordionRowBlock,
          summarySnippet: summaryBlock?.textContent?.trim().slice(0, 80),
          accordionSnippet: accordionValueBlock?.textContent?.trim().slice(0, 120),
        },
      };
    },
    {
      panel: BOOKING_DETAIL.PANEL,
      summary: BOOKING_DETAIL.SUMMARY_STAY_DATES,
      accordionRow: BOOKING_DETAIL.ACCORDION_STAY_DATES,
      accordionValue: BOOKING_DETAIL.ACCORDION_STAY_DATES_VALUE,
    }
  );

  for (const candidate of result.candidates) {
    const { checkInStr, checkOutStr } = parseStayDateRangeText(candidate.text);
    if (checkInStr && checkOutStr) {
      return {
        checkInStr,
        checkOutStr,
        source: candidate.source,
        debug: result.debug,
      };
    }
  }

  return {
    checkInStr: null,
    checkOutStr: null,
    source: "",
    debug: {
      ...result.debug,
      candidateCount: result.candidates.length,
      candidates: result.candidates.map((c) => c.text.slice(0, 80)),
    },
  };
}

/**
 * Persist guest name and stay dates to the retrieval item.
 */
async function persistBookingDates(
  retrievalId: string,
  bookingId: string,
  rowData: BookingRowData,
  source: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();

  if (!rowData.check_in_date || !rowData.check_out_date) {
    return false;
  }

  try {
    const checkIn = rowData.check_in_date;
    const checkOut = rowData.check_out_date;
    const updated = await retrievalService.updateRetrievalItemGuestAndDates(
      retrievalId,
      bookingId,
      {
        guest_name: rowData.guest_name || "—",
        check_in_date: checkIn,
        check_out_date: checkOut,
        room_type: rowData.room_type || "—",
        reservation_status: rowData.reservation_status || "—",
      }
    );
    if (updated) {
      await dualLogInfo(
        `✅ Saved stay dates for booking ${bookingId} (${source}): ${checkIn.toISOString().slice(0, 10)} - ${checkOut.toISOString().slice(0, 10)}`,
        { jobId, bookingId }
      );
      return true;
    }

    const retrieval = await retrievalService.getRetrievalById(retrievalId);
    if (retrieval?.property_id) {
      const propertyId = retrieval.property_id.toString();
      const parentRetrievalId =
        retrieval.parent_retrieval_id?.toString() ?? retrievalId;
      await retrievalService.upsertRetrievalItem({
        retrieval_id: retrievalId,
        parent_retrieval_id: parentRetrievalId,
        property_id: propertyId,
        guest_name: rowData.guest_name || "—",
        reservation_id: bookingId,
        check_in_date: checkIn,
        check_out_date: checkOut,
        room_type: rowData.room_type || "—",
        booked_date: rowData.check_in_date,
        reservation_status: rowData.reservation_status || "—",
      });
      await dualLogInfo(
        `✅ Created retrieval item with stay dates for booking ${bookingId} (${source}): ${checkIn.toISOString().slice(0, 10)} - ${checkOut.toISOString().slice(0, 10)}`,
        { jobId, bookingId }
      );
      return true;
    }
  } catch (dbErr: any) {
    await dualLogError(
      `Failed to save stay dates for booking ${bookingId} (${source})`,
      dbErr,
      { jobId, bookingId }
    );
  }

  return false;
}

/**
 * Save guest name and stay dates from an already-extracted booking row.
 */
async function persistBookingRowData(
  rowData: BookingRowData | null,
  bookingId: string,
  retrievalId: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  if (!rowData) return false;

  if (!rowData.check_in_date || !rowData.check_out_date) {
    await dualLogInfo(
      `Table row dates incomplete for booking ${bookingId}, will try sidebar fallback`,
      {
        jobId,
        bookingId,
        check_in_str: rowData.check_in_str,
        check_out_str: rowData.check_out_str,
      }
    );
    return false;
  }

  return persistBookingDates(retrievalId, bookingId, rowData, "booking-row");
}

/**
 * Fallback: read stay dates from the booking detail sidebar after it opens.
 */
async function persistBookingDatesFromSidebar(
  page: Page,
  bookingId: string,
  retrievalId: string,
  partialRowData?: BookingRowData | null
): Promise<boolean> {
  const jobId = getRetrievalJobId();

  await waitForSidebarStayDatesContent(page, bookingId);
  let sidebarDates = await extractStayDatesFromSidebar(page);

  if (!sidebarDates.checkInStr || !sidebarDates.checkOutStr) {
    await dualLogInfo(
      "Summary stay dates incomplete — trying accordion stay-date section",
      { jobId, bookingId, debug: sidebarDates.debug }
    );
    await waitForAccordionStayDateSection(page, bookingId);
    sidebarDates = await extractStayDatesFromSidebar(page);
  }

  if (!sidebarDates.checkInStr || !sidebarDates.checkOutStr) {
    await dualLogError(
      `Sidebar stay dates not found for booking ${bookingId}`,
      undefined,
      {
        jobId,
        bookingId,
        source: sidebarDates.source,
        debug: sidebarDates.debug,
      }
    );
    return false;
  }

  const rowData = bookingRowDataFromDateStrings(
    sidebarDates.checkInStr,
    sidebarDates.checkOutStr,
    partialRowData
  );

  if (!rowData) {
    await dualLogError(
      `Could not parse sidebar stay dates for booking ${bookingId}`,
      undefined,
      {
        jobId,
        bookingId,
        check_in_str: sidebarDates.checkInStr,
        check_out_str: sidebarDates.checkOutStr,
        source: sidebarDates.source,
      }
    );
    return false;
  }

  return persistBookingDates(
    retrievalId,
    bookingId,
    rowData,
    sidebarDates.source
  );
}

/**
 * Extract guest name, stay dates (check-in/check-out), reservation status, and room type from a booking result row.
 * Row structure: td[0]=booking id+status, td[1]=guest name, td[2]=dates (two p), td[3]=room type.
 */
export async function extractBookingRowData(
  page: Page,
  bookingRowSelector: string
): Promise<BookingRowData | null> {
  try {
    const raw = await page.evaluate(
      (rowSelector: string) => {
        const row = document.querySelector(rowSelector);
        if (!row) return null;
        const tds = row.querySelectorAll("td");
        let checkInStr: string | null = null;
        let checkOutStr: string | null = null;

        // Date cell: td[2] — first <p> is check-in, last <p> is check-out
        // e.g. <p>Jan 28, 2026 - </p><p>Feb 1, 2026</p>
        // or single <p>Mar 21, 2026 - Mar 22, 2026</p>
        const dateRangePattern =
          /([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})\s*-\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/;

        if (tds.length >= 3) {
          const datePs = tds[2].querySelectorAll("p");
          if (datePs.length >= 2) {
            checkInStr =
              (datePs[0].textContent || "").replace(/\s*-\s*$/, "").trim() ||
              null;
            checkOutStr =
              (datePs[datePs.length - 1].textContent || "").trim() || null;
          } else if (datePs.length === 1) {
            const full = (datePs[0].textContent || "").trim();
            const rangeMatch = full.match(dateRangePattern);
            if (rangeMatch) {
              checkInStr = rangeMatch[1];
              checkOutStr = rangeMatch[2];
            } else {
              checkInStr = full.replace(/\s*-\s*$/, "").trim() || null;
            }
          }

          // Second <p> may be empty/hidden while td still has full range text
          if (!checkOutStr && tds[2]) {
            const cellText = (tds[2].textContent || "").trim();
            const rangeMatch = cellText.match(dateRangePattern);
            if (rangeMatch) {
              checkInStr = rangeMatch[1];
              checkOutStr = rangeMatch[2];
            }
          }
        }
        return {
          guest_name: (row.querySelector('p[data-testid="guest-name"]')?.textContent || "").trim(),
          reservation_status: (row.querySelector('span[data-testid="booking-ack-view"]')?.textContent || "").trim(),
          room_type: (() => {
            if (tds.length < 4) return "";
            const p = tds[3].querySelector("p");
            return (p?.textContent || "").trim();
          })(),
          check_in_str: checkInStr,
          check_out_str: checkOutStr,
        };
      },
      bookingRowSelector
    );

    if (!raw) return null;

    return {
      guest_name: raw.guest_name,
      check_in_str: raw.check_in_str,
      check_out_str: raw.check_out_str,
      check_in_date: raw.check_in_str ? parseAgodaRowDate(raw.check_in_str) : null,
      check_out_date: raw.check_out_str
        ? parseAgodaRowDate(raw.check_out_str)
        : null,
      reservation_status: raw.reservation_status,
      room_type: raw.room_type,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Searches for a booking ID and navigates to the Get payout (UPC) tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID to search for
 * @param userEmail - The user's email address (agodausername) for OTP verification
 * @param retrievalId - Optional retrieval ID for saving card info to database
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
export async function searchBookingAndNavigateToPayout(
  page: Page,
  bookingId: string,
  userEmail?: string,
  retrievalId?: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(`Starting search for booking ID: ${bookingId}`, {
      jobId,
      bookingId,
    });

    // Step 1: Find and fill the booking ID input field
    await dualLogInfo("Looking for booking ID / Guest name input field...", {
      jobId,
      bookingId,
    });

    // Wait for the search input field to be available
    try {
      await page.waitForSelector(BOOKING_SEARCH.INPUT, {
        visible: true,
        timeout: 10000,
      });
    } catch (error) {
      await dualLogError(
        `Search input field not found: ${BOOKING_SEARCH.INPUT}`,
        error
      );
      return false;
    }

    // Clear existing value and type the booking ID
    await dualLogInfo(`Entering booking ID: ${bookingId} in search field`, {
      jobId,
      bookingId,
    });

    // Click on the input field first
    await page.click(BOOKING_SEARCH.INPUT);
    await delay(300);

    // Use $eval to directly manipulate the input element (most reliable)
    await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
      input.focus();
      input.select();
      input.value = "";
      // Trigger all necessary events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    await delay(300);

    // Also use keyboard method to ensure it's cleared
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA"); // Select all (Ctrl+A)
    await page.keyboard.up("Control");
    await delay(100);
    await page.keyboard.press("Delete"); // Delete selected text
    await delay(200);
    await page.keyboard.press("Backspace"); // Additional backspace for safety
    await delay(200);

    // Verify the field is actually empty before typing
    const currentValue = await page.$eval(
      BOOKING_SEARCH.INPUT,
      (input: HTMLInputElement) => input.value
    );

    if (currentValue && currentValue.length > 0) {
      await dualLogInfo(
        `Input field still has value: "${currentValue}", force clearing...`,
        { jobId, bookingId }
      );
      // Force clear using $eval
      await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await delay(300);
    } else {
      await dualLogInfo("Input field cleared successfully", {
        jobId,
        bookingId,
      });
    }

    // Now type the new booking ID
    await page.type(BOOKING_SEARCH.INPUT, bookingId, { delay: 100 });

    // Wait for input to be fully processed (React debouncing)
    await delay(500);

    // Step 2: Click the Search button
    await dualLogInfo("Clicking Search button...", { jobId, bookingId });

    try {
      await page.waitForSelector(BOOKING_SEARCH.BUTTON, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_SEARCH.BUTTON);
      await dualLogInfo("Search button clicked", { jobId, bookingId });
    } catch (error) {
      await dualLogError("Search button not found or not clickable", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 3: Wait for search results to load using smart waiting
    await dualLogInfo("Waiting for search results to load...", {
      jobId,
      bookingId,
    });

    // Wait for network idle or booking row to appear
    const bookingRowSelector = BOOKING_RESULTS.ROW(bookingId);

    try {
      // Use Promise.race to wait for either network idle or booking row
      await Promise.race([
        // Wait for network idle (search completed)
        page
          .waitForNetworkIdle({ idleTime: 500, timeout: 10000 })
          .then(() =>
            dualLogInfo("Network idle after search", { jobId, bookingId })
          ),

        // Wait for booking row to appear
        page
          .waitForSelector(bookingRowSelector, {
            visible: true,
            timeout: 15000,
          })
          .then(() =>
            dualLogInfo("Booking row appeared", { jobId, bookingId })
          ),

        // Minimum wait as fallback
        delay(2000).then(() =>
          dualLogInfo("Minimum search wait completed", { jobId, bookingId })
        ),
      ]);
    } catch (error) {
      await dualLogInfo("Network idle timeout (continuing to check for row)", {
        jobId,
        bookingId,
      });
    }

    // Now verify the booking row is actually present
    let datesSaved = false;
    let partialRowData: BookingRowData | null = null;

    try {
      await page.waitForSelector(bookingRowSelector, {
        visible: true,
        timeout: 5000,
      });
      await dualLogInfo(`✅ Booking row found for ID: ${bookingId}`, {
        jobId,
        bookingId,
      });
      // Screenshot: search results with matched booking row
      await takeScreenshot(page, retrievalId ?? jobId ?? "", `search_results_${bookingId}`, "step", "agoda", retrievalId ? "retrieval" : "job");

      if (retrievalId) {
        partialRowData = await extractBookingRowData(page, bookingRowSelector);
        datesSaved = await persistBookingRowData(
          partialRowData,
          bookingId,
          retrievalId
        );
      }
    } catch (error) {
      await dualLogError(`Booking row not found for ID: ${bookingId}`, error, {
        jobId,
        bookingId,
      });
      await takeScreenshot(page, retrievalId ?? jobId ?? "", `search_results_not_found_${bookingId}`, "error", "agoda", retrievalId ? "retrieval" : "job");
      return false;
    }

    // Step 4: Click on the booking row (preferably on the guest name)
    await dualLogInfo("Clicking on booking row (guest name)...", {
      jobId,
      bookingId,
    });

    // Try to click on the guest name first, fallback to the row
    const guestNameSelector = BOOKING_RESULTS.GUEST_NAME(bookingId);

    try {
      const guestNameElement = await page.$(guestNameSelector);
      if (guestNameElement) {
        await guestNameElement.click();
        await dualLogInfo("Clicked on guest name", { jobId, bookingId });
      } else {
        // Fallback to clicking the row itself
        await page.click(bookingRowSelector);
        await dualLogInfo("Clicked on booking row", { jobId, bookingId });
      }
    } catch (error) {
      await dualLogError("Failed to click on booking row", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 5: Wait for the right sidebar to appear
    await dualLogInfo("Waiting for booking detail sidebar to appear...", {
      jobId,
      bookingId,
    });

    // Use smart waiting instead of static delay
    try {
      // Wait for either network idle or tab list to appear
      await Promise.race([
        // Wait for network idle (sidebar loaded)
        page
          .waitForNetworkIdle({ idleTime: 500, timeout: 8000 })
          .then(() =>
            dualLogInfo("Network idle after clicking booking row", {
              jobId,
              bookingId,
            })
          ),

        // Wait for tab list to appear
        page
          .waitForSelector(BOOKING_DETAIL.TAB_LIST, {
            visible: true,
            timeout: 10000,
          })
          .then(() => dualLogInfo("Tab list appeared", { jobId, bookingId })),

        // Minimum wait
        delay(1000).then(() =>
          dualLogInfo("Minimum sidebar wait completed", { jobId, bookingId })
        ),
      ]);
    } catch (error) {
      await dualLogInfo("Sidebar wait race completed (checking for tab list)", {
        jobId,
        bookingId,
      });
    }

    // Wait for the tab list to be visible (indicates sidebar is open)
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 5000,
      });
      await dualLogInfo("✅ Booking detail sidebar appeared", {
        jobId,
        bookingId,
      });

      if (retrievalId && !datesSaved) {
        await dualLogInfo(
          "Trying sidebar fallback for stay dates after panel opened",
          { jobId, bookingId }
        );
        datesSaved = await persistBookingDatesFromSidebar(
          page,
          bookingId,
          retrievalId,
          partialRowData
        );
      }
    } catch (error) {
      await dualLogError("Booking detail sidebar did not appear", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 6: Click on "Get payout (UPC)" tab
    await dualLogInfo("Clicking on 'Get payout (UPC)' tab...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_DETAIL.PAYOUT_TAB, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_DETAIL.PAYOUT_TAB);
      await dualLogInfo("Successfully clicked on 'Get payout (UPC)' tab", {
        jobId,
        bookingId,
      });

      // Wait for network activity to settle after clicking payout tab
      await dualLogInfo("Waiting for payout content to load...", {
        jobId,
        bookingId,
      });

      // Use Promise.race to wait for either:
      // 1. Network becomes idle (content loaded)
      // 2. UPC widget appears (no OTP required)
      // 3. Iframe appears (OTP required)
      // 4. Timeout after 10 seconds
      await Promise.race([
        // Wait for network idle
        page
          .waitForNetworkIdle({ idleTime: 500, timeout: 10000 })
          .then(() =>
            dualLogInfo("Network idle detected after payout tab click", {
              jobId,
              bookingId,
            })
          )
          .catch(() =>
            dualLogInfo(
              "Network idle timeout (continuing anyway - content may still be loading)",
              { jobId, bookingId }
            )
          ),

        // Wait for UPC widget (if no OTP required)
        page
          .waitForSelector(UPC_WIDGET.CONTAINER, {
            visible: true,
            timeout: 10000,
          })
          .then(() =>
            dualLogInfo("UPC widget appeared (no OTP required)", {
              jobId,
              bookingId,
            })
          )
          .catch(() => {}), // Silent fail - OTP might be required

        // Wait for iframe (if OTP required)
        page
          .waitForSelector('iframe[data-cy="ul-app-frame"]', {
            visible: true,
            timeout: 10000,
          })
          .then(() =>
            dualLogInfo("Universal Login iframe appeared (OTP required)", {
              jobId,
              bookingId,
            })
          )
          .catch(() => {}), // Silent fail - direct UPC might appear

        // Fallback: minimum wait
        delay(2000).then(() =>
          dualLogInfo("Minimum wait completed", { jobId, bookingId })
        ),
      ]);

      await dualLogInfo("Payout content loading phase completed", {
        jobId,
        bookingId,
      });

      // Small additional delay to ensure DOM is fully updated
      await delay(500);
      // Screenshot: page state immediately after Get payout tab loaded
      await takeScreenshot(page, retrievalId ?? jobId ?? "", `payout_tab_loaded_${bookingId}`, "step", "agoda", retrievalId ? "retrieval" : "job");
    } catch (error) {
      await dualLogError("Failed to click on 'Get payout (UPC)' tab", error, {
        jobId,
        bookingId,
      });
      await takeScreenshot(page, retrievalId ?? jobId ?? "", `payout_tab_click_failed_${bookingId}`, "error", "agoda", retrievalId ? "retrieval" : "job");
      return false;
    }

    // Step 7: Check if OTP verification is required (iframe with login form)
    await dualLogInfo("Checking if OTP verification is required...", {
      jobId,
      bookingId,
    });

    try {
      // CRITICAL: Wait longer to ensure iframe has time to appear
      // Some pages load iframe after initial content, so we need to be patient
      await dualLogInfo(
        "Waiting additional time for potential iframe to appear...",
        { jobId, bookingId }
      );

      // Wait up to 8 seconds for iframe to appear OR UPC widget to appear
      const iframeOrWidgetCheck = await Promise.race([
        // Check if iframe appears
        page
          .waitForSelector('iframe[data-cy="ul-app-frame"]', {
            visible: true,
            timeout: 8000,
          })
          .then(() => ({ type: "iframe", found: true }))
          .catch(() => ({ type: "iframe", found: false })),

        // Check if UPC widget appears (no OTP needed)
        page
          .waitForSelector(UPC_WIDGET.CONTAINER, {
            visible: true,
            timeout: 8000,
          })
          .then(() => ({ type: "widget", found: true }))
          .catch(() => ({ type: "widget", found: false })),

        // Minimum wait to ensure page settles
        delay(6000).then(() => ({ type: "timeout", found: false })),
      ]);

      await dualLogInfo("Iframe/Widget check result:", {
        jobId,
        bookingId,
        result: iframeOrWidgetCheck,
      });

      // If iframe was detected, wait for it to fully load
      if (iframeOrWidgetCheck.type === "iframe" && iframeOrWidgetCheck.found) {
        await dualLogInfo("Iframe detected, waiting for content to load...", {
          jobId,
          bookingId,
        });

        await page
          .waitForFunction(
            () => {
              const iframe = document.querySelector(
                'iframe[data-cy="ul-app-frame"]'
              );
              if (!iframe) return false;

              try {
                const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
                return (
                  iframeDoc &&
                  iframeDoc.readyState === "complete" &&
                  iframeDoc.body &&
                  iframeDoc.body.children.length > 0
                );
              } catch {
                return false;
              }
            },
            { timeout: 10000 }
          )
          .then(() =>
            dualLogInfo("✅ Iframe content fully loaded", { jobId, bookingId })
          )
          .catch(() =>
            dualLogError(
              "Iframe detected but content failed to load",
              undefined,
              { jobId, bookingId }
            )
          );
      } else if (
        iframeOrWidgetCheck.type === "widget" &&
        iframeOrWidgetCheck.found
      ) {
        await dualLogInfo("✅ UPC widget detected, no OTP required", {
          jobId,
          bookingId,
        });
      } else {
        await dualLogInfo(
          "No iframe or widget detected after waiting, checking page state...",
          { jobId, bookingId }
        );
      }

      // First, check if the universal login iframe exists on the main page
      const hasUniversalLoginIframe = await page.evaluate(() => {
        const ulFrame = document.querySelector(
          'iframe[data-cy="ul-app-frame"]'
        );
        return !!ulFrame;
      });

      if (hasUniversalLoginIframe) {
        await dualLogInfo(
          "✅ Universal Login iframe detected (data-cy='ul-app-frame')",
          { jobId, bookingId }
        );
      }

      // Check if there's an iframe with the login/OTP form
      const iframes = await page.frames();
      let otpFrame = null;

      await dualLogInfo(`Found ${iframes.length} frames on the page`, {
        jobId,
        bookingId,
      });

      for (const frame of iframes) {
        try {
          // Get frame URL for debugging
          const frameUrl = frame.url();
          await dualLogInfo(`Checking frame: ${frameUrl}`, {
            jobId,
            bookingId,
          });

          // CRITICAL: Wait for frame content to be ready before checking
          // This prevents false negatives when iframe is still loading
          // MFA iframe URL pattern: /iam/mfa?mfaOperation=0&redirect=...
          // Universal Login iframe: /ul/login?appId=ycs&initialPath=verifyOtp
          if (
            frameUrl.includes("iam/mfa") ||
            frameUrl.includes("ul/login") ||
            frameUrl.includes("mfaOperation")
          ) {
            await dualLogInfo(
              `MFA/Login iframe detected (URL: ${frameUrl.substring(0, 100)}...), waiting for content to stabilize...`,
              { jobId, bookingId }
            );

            // Wait for iframe body to have content
            await frame
              .waitForFunction(
                () => {
                  return (
                    document.body &&
                    document.body.children.length > 0 &&
                    document.readyState === "complete"
                  );
                },
                { timeout: 8000 }
              )
              .then(() =>
                dualLogInfo("Frame content stabilized", { jobId, bookingId })
              )
              .catch(() =>
                dualLogInfo("Frame stabilization timeout", { jobId, bookingId })
              );

            // Additional wait for React/dynamic content to render
            await delay(2000);
          }

          // Check if this frame contains the OTP verification form
          const hasOtpForm = await frame.evaluate((selectors) => {
            // Check for old OTP verification method selection
            const otpOptionEmail = document.querySelector(
              selectors.EMAIL_OPTION
            );
            // Check for old OTP input form
            const otpInputs = document.querySelector(selectors.FIRST_INPUT);

            // Check for new unified auth OTP form
            const verifyOtpPanel = document.querySelector(
              selectors.VERIFY_OTP_PANEL
            );
            const verifyOtpForm = document.querySelector(
              selectors.VERIFY_OTP_FORM
            );

            // Also check for "OTP has been sent to" text which indicates OTP form is present
            const otpSentText = Array.from(document.querySelectorAll("*")).some(
              (el) => el.textContent?.includes("OTP has been sent to")
            );

            // Check for "Please verify your identity" which indicates verification method selection
            const verifyIdentityText = Array.from(
              document.querySelectorAll("*")
            ).some((el) => el.textContent?.includes("Please verify your identity"));

            return {
              hasOtpOptionEmail: !!otpOptionEmail,
              hasOtpInputs: !!otpInputs,
              hasVerifyOtpPanel: !!verifyOtpPanel,
              hasVerifyOtpForm: !!verifyOtpForm,
              hasOtpSentText: otpSentText,
              hasVerifyIdentityText: verifyIdentityText,
              hasAnyOtpElements:
                !!otpOptionEmail ||
                !!otpInputs ||
                !!verifyOtpPanel ||
                !!verifyOtpForm ||
                otpSentText ||
                verifyIdentityText,
            };
          }, OTP_CHECK_SELECTORS);

          await dualLogInfo(`Frame OTP check result:`, {
            jobId,
            bookingId,
            frameUrl,
            hasOtpForm,
          });

          if (hasOtpForm.hasAnyOtpElements) {
            otpFrame = frame;
            await dualLogInfo("✅ Found OTP verification iframe", {
              jobId,
              bookingId,
              frameUrl,
              hasOtpForm,
            });
            break;
          }
        } catch (frameError) {
          // Frame might not be accessible, continue checking other frames
          await dualLogInfo(`Frame check error (continuing): ${frameError}`, {
            jobId,
            bookingId,
          });
          continue;
        }
      }

      // If no iframe found, check the main page
      if (!otpFrame) {
        await dualLogInfo("No OTP iframe found, checking main page...", {
          jobId,
          bookingId,
        });

        // Wait a bit more and check again - OTP form might appear with a delay
        await delay(2000);

        const hasOtpOnMainPage = await page.evaluate((selectors) => {
          // Check for old OTP form selectors
          const otpOptionEmail = document.querySelector(selectors.EMAIL_OPTION);
          const otpInputs = document.querySelector(selectors.FIRST_INPUT);

          // Check for new unified auth OTP form
          const verifyOtpPanel = document.querySelector(
            selectors.VERIFY_OTP_PANEL
          );
          const verifyOtpForm = document.querySelector(
            selectors.VERIFY_OTP_FORM
          );

          // Also check for "OTP has been sent to" text which indicates OTP form is present
          const otpSentText = Array.from(document.querySelectorAll("*")).some(
            (el) => el.textContent?.includes("OTP has been sent to")
          );

          // Log what we found for debugging
          const found = !!(
            otpOptionEmail ||
            otpInputs ||
            verifyOtpPanel ||
            verifyOtpForm ||
            otpSentText
          );
          if (found) {
            console.log("OTP form detected on main page:", {
              otpOptionEmail: !!otpOptionEmail,
              otpInputs: !!otpInputs,
              verifyOtpPanel: !!verifyOtpPanel,
              verifyOtpForm: !!verifyOtpForm,
              otpSentText: otpSentText,
            });
          }

          return found;
        }, OTP_CHECK_SELECTORS);

        if (hasOtpOnMainPage) {
          await dualLogInfo("OTP form found on main page", {
            jobId,
            bookingId,
          });
          // Use main page for OTP handling
          const otpHandled = await handleOtpVerification(
            page,
            null,
            bookingId,
            userEmail
          );
          if (!otpHandled) {
            return false;
          }

          // After OTP verification, we need to search again and navigate to payout tab
          await dualLogInfo(
            "OTP verification completed, re-searching for booking ID to access payout tab...",
            { jobId, bookingId }
          );
          await delay(3000); // Wait for page to settle after OTP submission

          // Re-search for the same booking ID
          const reSearchSuccess = await reSearchAndNavigateToPayout(
            page,
            bookingId,
            retrievalId
          );
          if (!reSearchSuccess) {
            await dualLogError(
              "Failed to re-search and navigate to payout tab after OTP verification",
              undefined,
              { jobId, bookingId }
            );
            return false;
          }
        } else {
          await dualLogInfo(
            "No OTP verification required - proceeding to scrape UPC widget data",
            { jobId, bookingId }
          );

          // Release OTP immediately since no payout OTP verification is needed
          // This allows other jobs to start sooner
          // IMPORTANT: Verify OTP is still owned by this job before releasing to avoid race conditions
          const retrievalJobId = getRetrievalJobId();
          if (retrievalJobId && !isOtpReleasedForRetrieval()) {
            // Check if OTP is still owned by this job before attempting release
            const isOwnedByThisJob = await otpStatusManager.isOtpOwnedByJob(
              retrievalJobId
            );

            if (isOwnedByThisJob) {
              await dualLogInfo(
                "No payout OTP needed - verifying OTP ownership before release",
                { jobId, bookingId }
              );
              // Screenshot before releasing OTP — captures page state at release moment
              await takeScreenshot(page, retrievalId ?? jobId ?? "", "before_otp_release_no_payout_needed", "step", "agoda", retrievalId ? "retrieval" : "job");
              if (markOtpReleasedForRetrieval()) {
                // Directly release OTP in the database
                const released = await otpStatusManager.releaseOtp(
                  retrievalJobId
                );
                if (released) {
                  await dualLogInfo(
                    "✅ OTP released (no payout OTP verification needed)",
                    { jobId, bookingId }
                  );
                } else {
                  await dualLogError(
                    "⚠️ Failed to release OTP (no payout OTP needed)",
                    new Error("OTP release returned false"),
                    { jobId, bookingId }
                  );
                }

                // Also notify the worker pool (for queue processing)
                otpCompletionNotifier.notifyOtpCompleted(retrievalJobId);
              }
            } else {
              await dualLogInfo(
                "No payout OTP needed - OTP not owned by this job (job_id mismatch). OTP may have been released by another job.",
                { jobId, bookingId }
              );
            }
          } else if (retrievalJobId && isOtpReleasedForRetrieval()) {
            await dualLogInfo(
              "No payout OTP needed - OTP already released earlier",
              { jobId, bookingId }
            );
          }
        }
      } else {
        // Handle OTP in iframe
        const otpHandled = await handleOtpVerification(
          page,
          otpFrame,
          bookingId,
          userEmail
        );
        if (!otpHandled) {
          return false;
        }

        // After OTP verification, we need to search again and navigate to payout tab
        await dualLogInfo(
          "OTP verification completed, re-searching for booking ID to access payout tab...",
          { jobId, bookingId }
        );
        await delay(3000); // Wait for page to settle after OTP submission

        // Re-search for the same booking ID
        const reSearchSuccess = await reSearchAndNavigateToPayout(
          page,
          bookingId,
          retrievalId
        );
        if (!reSearchSuccess) {
          await dualLogError(
            "Failed to re-search and navigate to payout tab after OTP verification",
            undefined,
            { jobId, bookingId }
          );
          return false;
        }
      }

      // Step 8: If no OTP verification was needed, or after OTP is completed, scrape UPC widget data
      await dualLogInfo("Checking for UPC widget data...", {
        jobId,
        bookingId,
      });
      await delay(2000); // Wait for page/widget to load

      const upcData = await scrapeUpcWidgetData(page, bookingId);
      if (upcData) {
        await dualLogInfo("✅ UPC widget data scraped successfully", {
          jobId,
          bookingId,
        });
        console.log("=== UPC Widget Data ===");
        console.log("Card Holder Name:", upcData.cardHolderName);
        console.log("Card Number:", upcData.cardNumber);
        console.log("Expiration Date:", upcData.expirationDate);
        console.log("CVC Code:", upcData.cvcCode);
        console.log("======================");

        // Save card info to database if retrievalId is provided
        if (retrievalId && upcData.cardNumber && upcData.expirationDate) {
          try {
            // Format expiration date from "2026/01" to "01/26" or keep as is
            let formattedExpiryDate = upcData.expirationDate;
            if (formattedExpiryDate.includes("/")) {
              // Format: "2026/01" -> "01/26"
              const [year, month] = formattedExpiryDate.split("/");
              if (year && month) {
                const shortYear = year.length === 4 ? year.slice(-2) : year;
                formattedExpiryDate = `${month}/${shortYear}`;
              }
            }

            const cardInfo = {
              card_number: upcData.cardNumber || "",
              expiry_date: formattedExpiryDate,
              cvv: upcData.cvcCode || undefined,
              reason_for_charge: upcData.cardHolderName || undefined,
            };

            const updatedItem =
              await retrievalService.updateRetrievalItemCardInfo(
                retrievalId,
                bookingId,
                cardInfo
              );

            if (updatedItem) {
              await dualLogInfo(
                `✅ Card info saved to database for booking ID: ${bookingId}`,
                { jobId, bookingId }
              );
            } else {
              await dualLogError(
                `Failed to save card info to database for booking ID: ${bookingId}. Item may not exist yet.`,
                undefined,
                { jobId, bookingId }
              );
            }
          } catch (dbError: any) {
            await dualLogError(
              `Error saving card info to database for booking ID ${bookingId}:`,
              dbError,
              { jobId, bookingId }
            );
          }
        }
      } else {
        await dualLogInfo("UPC widget data not found or not accessible", {
          jobId,
          bookingId,
        });
      }
    } catch (error) {
      await dualLogError("Error checking for OTP verification", error, {
        jobId,
        bookingId,
      });
      // Continue anyway - OTP might not be required

      // Try to scrape UPC data even if OTP check failed
      try {
        await delay(2000);
        const upcData = await scrapeUpcWidgetData(page, bookingId);
        if (upcData) {
          await dualLogInfo(
            "✅ UPC widget data scraped successfully (after error)"
          );
          console.log("=== UPC Widget Data ===");
          console.log("Card Holder Name:", upcData.cardHolderName);
          console.log("Card Number:", upcData.cardNumber);
          console.log("Expiration Date:", upcData.expirationDate);
          console.log("CVC Code:", upcData.cvcCode);
          console.log("======================");

          // Save card info to database if retrievalId is provided
          if (retrievalId && upcData.cardNumber && upcData.expirationDate) {
            try {
              // Format expiration date from "2026/01" to "01/26" or keep as is
              let formattedExpiryDate = upcData.expirationDate;
              if (formattedExpiryDate.includes("/")) {
                // Format: "2026/01" -> "01/26"
                const [year, month] = formattedExpiryDate.split("/");
                if (year && month) {
                  const shortYear = year.length === 4 ? year.slice(-2) : year;
                  formattedExpiryDate = `${month}/${shortYear}`;
                }
              }

              const cardInfo = {
                card_number: upcData.cardNumber || "",
                expiry_date: formattedExpiryDate,
                cvv: upcData.cvcCode || undefined,
                reason_for_charge: upcData.cardHolderName || undefined,
              };

              const updatedItem =
                await retrievalService.updateRetrievalItemCardInfo(
                  retrievalId,
                  bookingId,
                  cardInfo
                );

              if (updatedItem) {
                await dualLogInfo(
                  `✅ Card info saved to database for booking ID: ${bookingId}`,
                  { jobId, bookingId }
                );
              } else {
                await dualLogError(
                  `Failed to save card info to database for booking ID: ${bookingId}. Item may not exist yet.`,
                  undefined,
                  { jobId, bookingId }
                );
              }
            } catch (dbError: any) {
              await dualLogError(
                `Error saving card info to database for booking ID ${bookingId}:`,
                dbError,
                { jobId, bookingId }
              );
            }
          }
        }
      } catch (scrapeError) {
        await dualLogError("Error scraping UPC widget data", scrapeError, {
          jobId,
          bookingId,
        });
      }
    }

    await dualLogInfo(
      `✅ Successfully navigated to Get payout (UPC) tab for booking ID: ${bookingId}`,
      { jobId, bookingId }
    );
    return true;
  } catch (error: any) {
    await dualLogError(
      `Error in searchBookingAndNavigateToPayout for booking ID ${bookingId}:`,
      error,
      { jobId, bookingId }
    );
    return false;
  }
}

/**
 * Handles OTP verification flow after clicking "Get payout (UPC)"
 * @param page - Puppeteer page instance
 * @param frame - Puppeteer frame instance (if OTP is in iframe, null if on main page)
 * @param bookingId - The booking ID for logging purposes
 * @param userEmail - The user's email address (agodausername) for OTP verification
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
async function handleOtpVerification(
  page: Page,
  frame: any,
  bookingId: string,
  userEmail?: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  const targetPage = frame || page;
  const selectorTimeout = 30000;
  const isIframe = !!frame;

  try {
    await dualLogInfo(
      `🔐 Processing OTP verification for Get payout (UPC)... ${
        isIframe ? "(inside iframe)" : "(on main page)"
      }`,
      { jobId, bookingId, isIframe, frameUrl: frame?.url() || "N/A" }
    );

    // Step 1: Check if we need to select verification method (via Email)
    await dualLogInfo(
      `Checking for OTP verification method selection... ${
        isIframe ? "(inside iframe)" : "(on main page)"
      }`,
      {
        jobId,
        bookingId,
      }
    );

    // Debug: Check what elements are present in the iframe/page
    try {
      const pageElements = await targetPage.evaluate(() => {
        return {
          hasVerifyOtpPanel: !!document.querySelector(
            '[data-cy="verify-otp-panel"]'
          ),
          hasEmailOption: !!document.querySelector(
            '[data-cy="otp-option-email"]'
          ),
          hasSmsOption: !!document.querySelector('[data-cy="otp-option-phone"]'),
          hasOtpInputs: !!document.querySelector('[data-cy="otp-0"]'),
          hasVerifyIdentity: Array.from(document.querySelectorAll("*")).some(
            (el) => el.textContent?.includes("Please verify your identity")
          ),
          hasViaEmail: Array.from(document.querySelectorAll("*")).some((el) =>
            el.textContent?.includes("via Email")
          ),
          bodyTextPreview: document.body.textContent?.substring(0, 200) || "",
        };
      });

      await dualLogInfo(`Elements present in ${isIframe ? "iframe" : "page"}:`, {
        jobId,
        bookingId,
        pageElements,
      });
    } catch (debugError) {
      await dualLogError("Debug check failed:", debugError, {
        jobId,
        bookingId,
      });
    }

    // Try multiple selectors and click methods for the email option
    const emailOptionSelectors = [
      '[data-cy="otp-option-email"]',
      '[data-cy="email-option"]',
      'div[data-cy="otp-option-email"]',
      'button:has-text("via Email")',
      'span:has-text("via Email")',
    ];

    let emailOptionClicked = false;

    for (const selector of emailOptionSelectors) {
      try {
        await targetPage.waitForSelector(selector, {
          visible: true,
          timeout: 5000,
        });

        await dualLogInfo(
          `Found OTP verification method selection with selector: ${selector}, clicking 'via Email'...`,
          { jobId, bookingId }
        );

        // Try multiple click methods for better reliability
        try {
          // Method 1: Regular Puppeteer click
          await targetPage.click(selector);
          await dualLogInfo("Email option clicked using regular click", {
            jobId,
            bookingId,
          });
          emailOptionClicked = true;
        } catch (clickError) {
          await dualLogInfo(
            "Regular click failed, trying JavaScript click...",
            { jobId, bookingId }
          );

          // Method 2: JavaScript click with comprehensive event simulation
          await targetPage.evaluate((sel: string) => {
            const element = document.querySelector(sel) as HTMLElement;
            if (element) {
              // Try direct click
              element.click();

              // Also try clicking on parent elements (sometimes the whole div needs to be clicked)
              const parent = element.parentElement;
              if (parent) {
                parent.click();
              }

              // Dispatch comprehensive mouse events
              const events = [
                new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
                new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
                new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
                new MouseEvent("click", { bubbles: true, cancelable: true }),
              ];

              events.forEach((event) => {
                element.dispatchEvent(event);
                if (parent) {
                  parent.dispatchEvent(event);
                }
              });
            }
          }, selector);

          await dualLogInfo("Email option clicked using JavaScript click", {
            jobId,
            bookingId,
          });
          emailOptionClicked = true;
        }

        await delay(3000); // Wait longer for OTP form to appear after selection
        // Screenshot: shows the "via Email" selection page after clicking
        await takeScreenshot(page, jobId ?? "", `via_email_option_clicked_${bookingId}`, "step", "agoda", "retrieval");
        break; // Exit loop if successful
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }

    if (!emailOptionClicked) {
      await dualLogInfo(
        "No verification method selection found, OTP form may already be visible",
        { jobId, bookingId }
      );
    }

    // Step 2: Wait for OTP input fields to be visible
    await dualLogInfo("Waiting for OTP input fields...", { jobId, bookingId });

    // If email option was clicked, give extra time for the form to appear
    if (emailOptionClicked) {
      await dualLogInfo(
        "Email option was clicked, waiting for OTP form to appear...",
        { jobId, bookingId }
      );
      await delay(2000);
    }

    try {
      await targetPage.waitForSelector(OTP_VERIFICATION.FIRST_INPUT, {
        visible: true,
        timeout: selectorTimeout,
      });
      await dualLogInfo("✅ OTP input fields found", { jobId, bookingId });
      // Screenshot: OTP input form visible — shows "OTP has been sent to" + digit boxes
      await takeScreenshot(page, jobId ?? "", `otp_input_form_visible_${bookingId}`, "step", "agoda", "retrieval");
    } catch (error) {
      await dualLogError(
        "OTP input fields not found after waiting. Checking page state...",
        error,
        { jobId, bookingId }
      );
      // Screenshot: captures what's on screen when OTP input is missing
      await takeScreenshot(page, jobId ?? "", `otp_input_form_missing_${bookingId}`, "error", "agoda", "retrieval");

      // Debug: Check what's on the page
      const pageDebug = await targetPage.evaluate(() => {
        return {
          hasVerifyOtpPanel: !!document.querySelector(
            '[data-cy="verify-otp-panel"]'
          ),
          hasEmailOption: !!document.querySelector(
            '[data-cy="otp-option-email"]'
          ),
          hasSmsOption: !!document.querySelector('[data-cy="otp-option-phone"]'),
          hasOtpInputs: !!document.querySelector('[data-cy="otp-0"]'),
          bodyText: document.body.textContent?.substring(0, 500) || "",
        };
      });

      await dualLogInfo("Page state debug info:", {
        jobId,
        bookingId,
        pageDebug,
      });

      // If the verification panel is still visible but inputs are not, something went wrong
      if (pageDebug.hasVerifyOtpPanel && !pageDebug.hasOtpInputs) {
        await dualLogError(
          "Verification panel exists but OTP inputs not found. The email option may not have been clicked properly.",
          undefined,
          { jobId, bookingId }
        );
        return false;
      }

      await dualLogInfo(
        "OTP input fields not found, OTP verification may not be required",
        { jobId, bookingId }
      );
      return true; // Not an error - OTP might not be needed
    }

    // Extract reference code and email address from the page
    await dualLogInfo(
      "Extracting reference code and email address from payout OTP page...",
      {
        jobId,
        bookingId,
      }
    );
    let referenceCode: string | null = null;
    let recipientEmail: string | null = userEmail || null;

    try {
      // Extract reference code from [data-cy="otp-refcode"]
      try {
        await targetPage.waitForSelector('[data-cy="otp-refcode"]', {
          timeout: selectorTimeout,
        });

        referenceCode = await targetPage.evaluate(() => {
          const refElement = document.querySelector('[data-cy="otp-refcode"]');
          if (refElement) {
            const text = refElement.textContent?.trim() || "";
            // Extract the code part (e.g., "Refcode: NVQLhK" -> "NVQLhK")
            const match = text.match(/Refcode:\s*([A-Za-z0-9]+)/i);
            return match ? match[1] : text.replace(/^Refcode:\s*/i, "").trim();
          }
          return null;
        });

        if (referenceCode) {
          await dualLogInfo(`✅ Reference code extracted: ${referenceCode}`, {
            jobId,
            bookingId,
          });
        } else {
          await dualLogInfo("⚠️ Could not extract reference code from page", {
            jobId,
            bookingId,
          });
        }
      } catch (refError) {
        await dualLogError(
          "Error extracting reference code (will search without it):",
          refError,
          { jobId, bookingId }
        );
      }

      // Extract email address from "OTP has been sent to {email}"
      try {
        const emailText = await targetPage.evaluate(() => {
          // Look for the specific span element that contains "OTP has been sent to"
          // The email is in a span with class "sc-iGgWBj ecoUic" that contains just this text
          // According to the HTML: <span class="sc-iGgWBj ecoUic">OTP has been sent to chartwell@epchotels.com</span>
          const spans = Array.from(
            document.querySelectorAll("span.sc-iGgWBj.ecoUic")
          );
          for (const span of spans) {
            const text = span.textContent?.trim() || "";
            // Check if this span contains "OTP has been sent to" and is short (just the email line)
            if (text.includes("OTP has been sent to") && text.length < 100) {
              // Verify it doesn't contain other text like "OTP will expire" or "Refcode"
              if (
                !text.includes("OTP will expire") &&
                !text.includes("Refcode") &&
                !text.includes("Submit")
              ) {
                return text;
              }
            }
          }

          // Fallback: look for any element containing "OTP has been sent to" but exclude parent elements
          const allElements = Array.from(document.querySelectorAll("*"));
          for (const element of allElements) {
            const text = element.textContent?.trim() || "";
            if (text.includes("OTP has been sent to")) {
              // Prefer elements that contain only the email sentence (shorter text, no other OTP-related text)
              if (
                text.length < 100 &&
                !text.includes("OTP will expire") &&
                !text.includes("Refcode") &&
                !text.includes("Submit OTP") &&
                !text.includes("Resend")
              ) {
                return text;
              }
            }
          }
          return null;
        });

        if (emailText) {
          // Log the full text for debugging
          await dualLogInfo(`📄 Full email text extracted: ${emailText}`, {
            jobId,
            bookingId,
          });

          // More strict regex to match email address and stop at word boundary
          // This prevents matching "OTP" or other text after the email
          // Pattern: "OTP has been sent to " followed by email
          // The email must end with TLD (2+ letters) followed by whitespace, end of string, or non-alphanumeric
          // This ensures we don't match "comOTP" - we stop at "com"
          const emailMatch = emailText.match(
            /OTP has been sent to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=\s|$|[^a-zA-Z0-9])/i
          );
          if (emailMatch && emailMatch[1]) {
            recipientEmail = emailMatch[1].trim();

            // Additional validation: check if email ends with valid TLD (not followed by letters)
            // If the extracted email has letters after the TLD (like "comOTP"), trim them
            if (recipientEmail) {
              const emailParts = recipientEmail.split("@");
              if (emailParts.length === 2) {
                const domain = emailParts[1];
                // Find the last dot and extract what should be the TLD
                const lastDotIndex = domain.lastIndexOf(".");
                if (lastDotIndex !== -1) {
                  const afterDot = domain.substring(lastDotIndex + 1);
                  // TLD should be 2-4 letters. If there are more letters after a valid TLD, trim them
                  // Match TLD pattern: 2-4 letters, then check if there are more letters after
                  const tldMatch = afterDot.match(
                    /^([a-zA-Z]{2,4})([a-zA-Z]+)?$/
                  );
                  if (tldMatch && tldMatch[2]) {
                    // There are extra letters after the TLD (like "comOTP" -> TLD is "com", extra is "OTP")
                    const validTld = tldMatch[1];
                    const correctedDomain =
                      domain.substring(0, lastDotIndex + 1) + validTld;
                    recipientEmail = emailParts[0] + "@" + correctedDomain;
                    await dualLogInfo(
                      `🔧 Trimmed invalid text after TLD (${afterDot} -> ${validTld}), corrected email: ${recipientEmail}`,
                      { jobId, bookingId }
                    );
                  }
                }
              }
            }

            // Validate it's a proper email (doesn't contain "OTP" or other invalid characters)
            if (
              recipientEmail &&
              !recipientEmail.toLowerCase().includes("otp") &&
              recipientEmail.includes("@")
            ) {
              await dualLogInfo(
                `✅ Recipient email extracted: ${recipientEmail}`,
                {
                  jobId,
                  bookingId,
                }
              );
            } else {
              await dualLogError(
                `⚠️ Extracted email appears invalid (contains 'OTP' or invalid format): ${recipientEmail}`,
                undefined,
                { jobId, bookingId }
              );
              // Fall back to userEmail
              recipientEmail = userEmail || null;
              await dualLogInfo(
                `Using provided userEmail instead: ${recipientEmail}`,
                { jobId, bookingId }
              );
            }
          } else {
            await dualLogInfo(
              `⚠️ Could not extract email from text: ${emailText.substring(
                0,
                150
              )}`,
              { jobId, bookingId }
            );
            // Fall back to userEmail
            recipientEmail = userEmail || null;
            await dualLogInfo(
              `Using provided userEmail instead: ${recipientEmail}`,
              { jobId, bookingId }
            );
          }
        } else {
          await dualLogInfo(
            "Could not find 'OTP has been sent to' text on page, using provided userEmail",
            { jobId, bookingId }
          );
          recipientEmail = userEmail || null;
        }
      } catch (emailError) {
        await dualLogError(
          "Error extracting recipient email (will use provided userEmail):",
          emailError,
          { jobId, bookingId }
        );
        recipientEmail = userEmail || null;
      }
    } catch (error) {
      await dualLogError(
        "Error extracting page information (will search without filters):",
        error,
        { jobId, bookingId }
      );
    }

    // Step 3: Wait 60 seconds for OTP email to arrive
    await dualLogInfo("Waiting 60 seconds for OTP email delivery...", {
      jobId,
      bookingId,
    });
    await delay(60000);

    // Step 4: Fetch OTP code from email
    if (!recipientEmail) {
      await dualLogError(
        "User email (agodausername) is required for OTP verification",
        undefined,
        { jobId, bookingId }
      );
      return false;
    }

    await dualLogInfo(
      `Now fetching YCS retrieval OTP code from email for ${recipientEmail}...`,
      { jobId, bookingId }
    );

    let otpResult: any = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await dualLogInfo(
        `Attempt ${attempt}/${maxRetries} to fetch YCS retrieval OTP code...`,
        { jobId, bookingId }
      );

      // Fetch the OTP code from email using YCS retrieval email helper
      // Note: Reference code is passed for logging but NOT used for email matching
      // (payout OTP emails don't contain the reference code)
      otpResult = await getYcsRetrievalOtpCode(
        recipientEmail,
        10,
        referenceCode || undefined
      );

      if (otpResult.otpCode) {
        await dualLogInfo(
          `OTP code found on attempt ${attempt}: ${otpResult.otpCode}`,
          { jobId, bookingId }
        );
        break;
      }

      if (attempt < maxRetries) {
        await dualLogInfo(
          `Attempt ${attempt} failed, waiting 10 seconds before retry...`,
          { jobId, bookingId }
        );
        await delay(10000);
      }
    }

    if (!otpResult || !otpResult.emailFound) {
      await dualLogError("Failed to access email for OTP code", undefined, {
        jobId,
        bookingId,
      });
      return false;
    }

    if (!otpResult.otpCode) {
      await dualLogError(
        "OTP code not found in recent emails after all attempts",
        undefined,
        { jobId, bookingId }
      );
      return false;
    }

    // Step 5: Fill OTP code into the input fields
    await dualLogInfo(`Filling OTP code: ${otpResult.otpCode}`, {
      jobId,
      bookingId,
    });

    // Split the 6-digit code into individual digits
    const otpDigits = otpResult.otpCode.split("");

    if (otpDigits.length !== 6) {
      await dualLogError(
        `Invalid OTP code length: ${otpDigits.length}. Expected 6 digits.`
      );
      return false;
    }

    // Fill each OTP input field (using data-cy="otp-0" to data-cy="otp-5")
    for (let i = 0; i < 6; i++) {
      const inputSelector = OTP_VERIFICATION.INPUT(i);
      await dualLogInfo(`Filling OTP box ${i} with digit: ${otpDigits[i]}`, {
        jobId,
        bookingId,
      });

      try {
        // Wait for the input field
        await targetPage.waitForSelector(inputSelector, {
          timeout: selectorTimeout,
        });

        // Focus and clear the field
        await targetPage.focus(inputSelector);
        await targetPage.evaluate((selector: string) => {
          const input = document.querySelector(selector) as HTMLInputElement;
          if (input) {
            input.value = "";
            input.focus();
          }
        }, inputSelector);

        // Type the digit
        await targetPage.type(inputSelector, otpDigits[i], { delay: 150 });
      } catch (inputError) {
        await dualLogError(`Failed to fill OTP box ${i}`, inputError, {
          jobId,
          bookingId,
        });
        return false;
      }
    }

    await dualLogInfo("All OTP digits filled successfully", {
      jobId,
      bookingId,
    });
    await delay(1000);
    // Screenshot: all OTP digits filled — shows the form just before submit
    await takeScreenshot(page, jobId ?? "", `otp_digits_filled_${bookingId}`, "step", "agoda", "retrieval");

    // Step 6: Click the Submit OTP button
    await dualLogInfo("Looking for Submit OTP button...", { jobId, bookingId });

    try {
      // Wait for button to be enabled
      await targetPage.waitForFunction(
        (selector: string) => {
          const button = document.querySelector(selector) as HTMLButtonElement;
          return button && !button.disabled;
        },
        { timeout: selectorTimeout },
        OTP_VERIFICATION.SUBMIT_BUTTON
      );

      await targetPage.click(OTP_VERIFICATION.SUBMIT_BUTTON);
      await dualLogInfo("Submit OTP button clicked successfully!", {
        jobId,
        bookingId,
      });
      await delay(3000); // Wait for submission to process
    } catch (error) {
      await dualLogError("Failed to click Submit OTP button", error, {
        jobId,
        bookingId,
      });
      await takeScreenshot(page, jobId ?? "", `otp_submit_failed_${bookingId}`, "error", "agoda", "retrieval");
      return false;
    }

    await dualLogInfo("✅ OTP verification completed successfully", {
      jobId,
      bookingId,
    });
    // Screenshot: OTP submit result — shows if page redirected or shows error
    await takeScreenshot(page, jobId ?? "", `otp_submit_success_${bookingId}`, "step", "agoda", "retrieval");

    // Release OTP immediately after payout verification completes (only once)
    // This frees up OTP for other jobs as soon as payout verification is done
    // IMPORTANT: Verify OTP is still owned by this job before releasing to avoid race conditions
    const retrievalJobId = getRetrievalJobId();
    if (retrievalJobId && markOtpReleasedForRetrieval()) {
      // Check if OTP is still owned by this job before attempting release
      const isOwnedByThisJob = await otpStatusManager.isOtpOwnedByJob(
        retrievalJobId
      );

      if (isOwnedByThisJob) {
        await dualLogInfo(
          "Payout OTP verification completed - verifying OTP ownership before release",
          { jobId, bookingId }
        );

        // Screenshot before releasing OTP — captures final payout page state
        await takeScreenshot(page, retrievalJobId, "before_otp_release_after_payout_verification", "step", "agoda", "retrieval");

        // Directly release OTP in the database
        const released = await otpStatusManager.releaseOtp(retrievalJobId);
        if (released) {
          await dualLogInfo(
            "✅ OTP released after payout verification (verified ownership)",
            { jobId, bookingId }
          );
        } else {
          await dualLogError(
            "⚠️ Failed to release OTP after payout verification",
            new Error("OTP release returned false"),
            { jobId, bookingId }
          );
        }

        // Also notify the worker pool (for queue processing)
        otpCompletionNotifier.notifyOtpCompleted(retrievalJobId);
      } else {
        await dualLogInfo(
          `Payout OTP verification completed - OTP not owned by this job (job_id mismatch). OTP may have been released by another job.`,
          { jobId, bookingId }
        );
      }
    } else if (retrievalJobId) {
      await dualLogInfo(
        "Payout OTP verification completed - OTP already released earlier",
        { jobId, bookingId }
      );
    }

    return true;
  } catch (error: any) {
    await dualLogError("Error in handleOtpVerification:", error, {
      jobId,
      bookingId,
    });
    await takeScreenshot(page, jobId ?? "", `otp_verification_error_${bookingId}`, "error", "agoda", "retrieval");
    return false;
  }
}

/**
 * Re-searches for a booking ID and navigates to the Get payout (UPC) tab
 * This is used after OTP verification to re-access the payout tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID to search for
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
async function reSearchAndNavigateToPayout(
  page: Page,
  bookingId: string,
  retrievalId?: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(
      `Re-searching for booking ID: ${bookingId} after OTP verification`,
      { jobId, bookingId }
    );

    // Step 1: Find and fill the booking ID input field
    await dualLogInfo("Looking for booking ID / Guest name input field...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_SEARCH.INPUT, {
        visible: true,
        timeout: 10000,
      });
    } catch (error) {
      await dualLogError(
        `Search input field not found: ${BOOKING_SEARCH.INPUT}`,
        error,
        { jobId, bookingId }
      );
      return false;
    }

    // Clear existing value and type the booking ID
    await dualLogInfo(`Entering booking ID: ${bookingId} in search field`, {
      jobId,
      bookingId,
    });

    // Click on the input field first to focus it
    await page.click(BOOKING_SEARCH.INPUT);
    await delay(300);

    // For React-controlled inputs, use keyboard method first (most reliable)
    // Select all existing text
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA"); // Select all (Ctrl+A)
    await page.keyboard.up("Control");
    await delay(100);

    // Delete the selected text
    await page.keyboard.press("Delete");
    await delay(200);

    // Also try Backspace as backup
    await page.keyboard.press("Backspace");
    await delay(200);

    // Use native value setter to properly update React-controlled input
    await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
      // Get the native input value setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;

      if (nativeInputValueSetter) {
        // Use native setter to set empty value (bypasses React's value tracking)
        nativeInputValueSetter.call(input, "");
      } else {
        input.value = "";
      }

      // Trigger React's synthetic events
      const inputEvent = new Event("input", {
        bubbles: true,
        cancelable: true,
      });
      const changeEvent = new Event("change", {
        bubbles: true,
        cancelable: true,
      });

      // Set target property for React compatibility
      Object.defineProperty(inputEvent, "target", {
        value: input,
        enumerable: true,
      });
      Object.defineProperty(changeEvent, "target", {
        value: input,
        enumerable: true,
      });

      input.dispatchEvent(inputEvent);
      input.dispatchEvent(changeEvent);

      // Update React's internal value tracker if it exists
      if ((input as any)._valueTracker) {
        (input as any)._valueTracker.setValue("");
      }
    });
    await delay(300);

    // Verify the field is actually empty before typing
    const currentValue = await page.$eval(
      BOOKING_SEARCH.INPUT,
      (input: HTMLInputElement) => input.value
    );

    if (currentValue && currentValue.length > 0) {
      await dualLogInfo(
        `Input field still has value: "${currentValue}", trying alternative clear method...`
      );

      // Try triple-click and delete as last resort
      await page.click(BOOKING_SEARCH.INPUT, { clickCount: 3 });
      await delay(200);
      await page.keyboard.press("Delete");
      await delay(200);
      await page.keyboard.press("Backspace");
      await delay(200);

      // Final verification
      const finalValue = await page.$eval(
        BOOKING_SEARCH.INPUT,
        (input: HTMLInputElement) => input.value
      );

      if (finalValue && finalValue.length > 0) {
        await dualLogError(
          `Warning: Input field still contains "${finalValue}" after clearing attempts. Proceeding anyway.`
        );
      } else {
        await dualLogInfo(
          "Input field cleared successfully after alternative method"
        );
      }
    } else {
      await dualLogInfo("Input field cleared successfully", {
        jobId,
        bookingId,
      });
    }

    // Now type the new booking ID
    await page.type(BOOKING_SEARCH.INPUT, bookingId, { delay: 100 });

    // Wait for input to be fully processed (React debouncing)
    await delay(500);

    // Step 2: Click the Search button
    await dualLogInfo("Clicking Search button...", { jobId, bookingId });

    try {
      await page.waitForSelector(BOOKING_SEARCH.BUTTON, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_SEARCH.BUTTON);
      await dualLogInfo("Search button clicked", { jobId, bookingId });
    } catch (error) {
      await dualLogError("Search button not found or not clickable", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 3: Wait for search results to load using smart waiting
    await dualLogInfo("Waiting for search results to load...", {
      jobId,
      bookingId,
    });

    // Wait for network idle or booking row to appear
    const bookingRowSelector = BOOKING_RESULTS.ROW(bookingId);

    try {
      // Use Promise.race to wait for either network idle or booking row
      await Promise.race([
        // Wait for network idle (search completed)
        page
          .waitForNetworkIdle({ idleTime: 500, timeout: 10000 })
          .then(() =>
            dualLogInfo("Network idle after search", { jobId, bookingId })
          ),

        // Wait for booking row to appear
        page
          .waitForSelector(bookingRowSelector, {
            visible: true,
            timeout: 15000,
          })
          .then(() =>
            dualLogInfo("Booking row appeared", { jobId, bookingId })
          ),

        // Minimum wait as fallback
        delay(2000).then(() =>
          dualLogInfo("Minimum search wait completed", { jobId, bookingId })
        ),
      ]);
    } catch (error) {
      await dualLogInfo("Network idle timeout (continuing to check for row)", {
        jobId,
        bookingId,
      });
    }

    // Now verify the booking row is actually present
    let datesSaved = false;
    let partialRowData: BookingRowData | null = null;

    try {
      await page.waitForSelector(bookingRowSelector, {
        visible: true,
        timeout: 5000,
      });
      await dualLogInfo(`✅ Booking row found for ID: ${bookingId}`, {
        jobId,
        bookingId,
      });
      // Screenshot: search results with matched booking row (re-search after OTP)
      await takeScreenshot(page, jobId ?? "", `re_search_results_${bookingId}`, "step", "agoda", "retrieval");

      if (retrievalId) {
        partialRowData = await extractBookingRowData(page, bookingRowSelector);
        datesSaved = await persistBookingRowData(
          partialRowData,
          bookingId,
          retrievalId
        );
      }
    } catch (error) {
      await dualLogError(`Booking row not found for ID: ${bookingId}`, error, {
        jobId,
        bookingId,
      });
      await takeScreenshot(page, jobId ?? "", `re_search_results_not_found_${bookingId}`, "error", "agoda", "retrieval");
      return false;
    }

    // Step 4: Click on the booking row (preferably on the guest name)
    await dualLogInfo("Clicking on booking row (guest name)...", {
      jobId,
      bookingId,
    });

    const guestNameSelector = BOOKING_RESULTS.GUEST_NAME(bookingId);

    try {
      const guestNameElement = await page.$(guestNameSelector);
      if (guestNameElement) {
        await guestNameElement.click();
        await dualLogInfo("Clicked on guest name", { jobId, bookingId });
      } else {
        await page.click(bookingRowSelector);
        await dualLogInfo("Clicked on booking row", { jobId, bookingId });
      }
    } catch (error) {
      await dualLogError("Failed to click on booking row", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 5: Wait for the right sidebar to appear
    await dualLogInfo("Waiting for booking detail sidebar to appear...", {
      jobId,
      bookingId,
    });

    // Use smart waiting instead of static delay
    try {
      // Wait for either network idle or tab list to appear
      await Promise.race([
        // Wait for network idle (sidebar loaded)
        page
          .waitForNetworkIdle({ idleTime: 500, timeout: 8000 })
          .then(() =>
            dualLogInfo("Network idle after clicking booking row", {
              jobId,
              bookingId,
            })
          ),

        // Wait for tab list to appear
        page
          .waitForSelector(BOOKING_DETAIL.TAB_LIST, {
            visible: true,
            timeout: 10000,
          })
          .then(() =>
            dualLogInfo("Tab list appeared", { jobId, bookingId })
          ),

        // Minimum wait
        delay(1000).then(() =>
          dualLogInfo("Minimum sidebar wait completed", { jobId, bookingId })
        ),
      ]);
    } catch (error) {
      await dualLogInfo("Sidebar wait race completed (checking for tab list)", {
        jobId,
        bookingId,
      });
    }

    // Verify tab list is present
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 5000,
      });
      await dualLogInfo("✅ Booking detail sidebar appeared", {
        jobId,
        bookingId,
      });

      if (retrievalId && !datesSaved) {
        await dualLogInfo(
          "Trying sidebar fallback for stay dates after panel opened (re-search)",
          { jobId, bookingId }
        );
        datesSaved = await persistBookingDatesFromSidebar(
          page,
          bookingId,
          retrievalId,
          partialRowData
        );
      }
    } catch (error) {
      await dualLogError("Booking detail sidebar did not appear", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 6: Click on "Get payout (UPC)" tab
    await dualLogInfo("Clicking on 'Get payout (UPC)' tab...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_DETAIL.PAYOUT_TAB, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_DETAIL.PAYOUT_TAB);
      await dualLogInfo("Successfully clicked on 'Get payout (UPC)' tab", {
        jobId,
        bookingId,
      });
      await delay(2000);
    } catch (error) {
      await dualLogError("Failed to click on 'Get payout (UPC)' tab", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    await dualLogInfo(
      `✅ Successfully re-navigated to Get payout (UPC) tab for booking ID: ${bookingId}`
    );
    return true;
  } catch (error: any) {
    await dualLogError(
      `Error in reSearchAndNavigateToPayout for booking ID ${bookingId}:`,
      error
    );
    return false;
  }
}

/**
 * Interface for UPC widget scraped data
 */
interface UpcWidgetData {
  cardHolderName: string | null;
  cardNumber: string | null;
  expirationDate: string | null;
  cvcCode: string | null;
}

/**
 * Scrapes UPC widget data from the Get payout (UPC) tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID for logging purposes
 * @returns Promise<UpcWidgetData | null> - Scraped data or null if not found
 */
async function scrapeUpcWidgetData(
  page: Page,
  bookingId: string
): Promise<UpcWidgetData | null> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(`Scraping UPC widget data for booking ID: ${bookingId}`, {
      jobId,
      bookingId,
    });

    // Wait for UPC widget to be visible
    try {
      await page.waitForSelector(UPC_WIDGET.CONTAINER, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("UPC widget found", { jobId, bookingId });
    } catch (error) {
      await dualLogInfo(
        "UPC widget not found - may not be available for this booking"
      );
      return null;
    }

    // Scrape the data from the UPC widget
    const upcData = await page.evaluate((selectors) => {
      const data: UpcWidgetData = {
        cardHolderName: null,
        cardNumber: null,
        expirationDate: null,
        cvcCode: null,
      };

      // Extract Card Holder Name
      const cardHolderNameElement = document.querySelector(
        selectors.CARD_HOLDER_NAME
      );
      if (cardHolderNameElement) {
        data.cardHolderName = cardHolderNameElement.textContent?.trim() || null;
      }

      // Extract Card Number
      const cardNumberElement = document.querySelector(selectors.CARD_NUMBER);
      if (cardNumberElement) {
        data.cardNumber = cardNumberElement.textContent?.trim() || null;
      }

      // Extract Expiration Date
      const expirationDateElement = document.querySelector(
        selectors.EXPIRATION_DATE
      );
      if (expirationDateElement) {
        data.expirationDate = expirationDateElement.textContent?.trim() || null;
      }

      // Extract CVC Code
      const cvcCodeElement = document.querySelector(selectors.CVC_CODE);
      if (cvcCodeElement) {
        data.cvcCode = cvcCodeElement.textContent?.trim() || null;
      }

      return data;
    }, UPC_WIDGET);

    await dualLogInfo("UPC widget data extracted successfully", {
      jobId,
      bookingId,
    });
    return upcData;
  } catch (error: any) {
    await dualLogError("Error scraping UPC widget data:", error, {
      jobId,
      bookingId,
    });
    return null;
  }
}
