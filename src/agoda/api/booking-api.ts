import { randomUUID } from "crypto";
import { Page } from "puppeteer";
import { BROWSER_CONFIG } from "../../common/browser-constants.js";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";

// Interface for CSV record mapping (shared with booking-data.ts)
export interface CsvRecord {
  BookingIDExternal_reference_ID: string;
  Status: string;
  StayDateFrom: string;
  StayDateTo: string;
  BookedDate: string;
  Customer_Name: string;
  RoomType: string;
  CancellationPolicyDescription?: string;
  amount_to_charge_or_refund?: number; // From bookingSummaryPriceViewModel.price
  amount_to_charge_or_refund_currency?: string; // From bookingSummaryPriceViewModel.currencyCode
  [key: string]: any; // For other CSV fields
}

/**
 * Extract bookings array from API response.
 * Tries multiple possible keys: pagedBookingList.items (new shape), bookings (browser), etc.
 */
function extractBookingsArray(data: any): any[] | null {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.pagedBookingList?.items, // New API shape: list inside pagedBookingList
    data.bookings,
    data.Bookings,
    data.data?.bookings,
    data.data?.Bookings,
    data.data?.pagedBookingList?.items,
    data.data?.list,
    data.data?.items,
    data.results,
    data.result,
    data.list,
    data.items,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr)) return arr;
  }
  // Fallback: first top-level key that is an array
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.data && typeof data.data === "object") {
    for (const key of Object.keys(data.data)) {
      if (Array.isArray(data.data[key])) return data.data[key];
    }
  }
  return null;
}

/**
 * Parses date from various formats to JavaScript Date object in UTC
 * Handles both YYYY-MM-DD and MM/DD/YYYY formats
 * Uses Date.UTC() to avoid timezone offset issues
 */
function parseCsvDate(dateString: string): Date {
  if (!dateString) return new Date();

  let year: string, month: string, day: string;

  if (dateString.includes("/")) {
    // MM/DD/YYYY format
    const parts = dateString.split("/");
    month = parts[0];
    day = parts[1];
    year = parts[2];
  } else if (dateString.includes("-")) {
    // YYYY-MM-DD format
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1];
    day = parts[2];
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }

  // OLD METHOD (COMMENTED OUT): Local timezone parsing
  // This caused timezone offset issues (e.g., Sep 1 became Aug 31 in UTC+6 timezone)
  /*
  const parsed = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  );
  return isNaN(parsed.getTime()) ? new Date() : parsed;
  */

  // NEW METHOD: Use Date.UTC() to create date in UTC timezone (avoiding local timezone offset)
  // Note: Month is 0-indexed in Date.UTC (0 = January, 11 = December)
  const yearNum = parseInt(year, 10);
  const monthNum = parseInt(month, 10) - 1; // Convert to 0-indexed (1-12 -> 0-11)
  const dayNum = parseInt(day, 10);

  const timestamp = Date.UTC(yearNum, monthNum, dayNum, 0, 0, 0, 0);
  
  if (isNaN(timestamp)) {
    return new Date();
  }
  
  return new Date(timestamp);
}

/**
 * Converts date string to milliseconds timestamp for API
 * @param dateString - Date in YYYY-MM-DD or MM/DD/YYYY format
 * @returns Milliseconds timestamp
 */
function convertDateToTimestamp(dateString: string): number {
  const date = parseCsvDate(dateString);
  return date.getTime();
}

/**
 * Extracts cookies from Puppeteer page
 * @param page - Puppeteer page object
 * @param jobId - Optional job ID for logging
 * @returns Cookie string for API requests
 */
async function extractCookiesFromPage(
  page: Page,
  jobId?: string
): Promise<string> {
  try {
    // Get all cookies from the page
    const cookies = await page.cookies();

    if (!cookies || cookies.length === 0) {
      await dualLogError("No cookies found on page!", {
        jobId,
        pageUrl: page.url(),
      });
      throw new Error("No cookies found on page");
    }

    // Filter cookies for ycs.agoda.com domain
    const agodaCookies = cookies.filter(
      (cookie) =>
        cookie.domain.includes("agoda.com") ||
        cookie.domain.includes("ycs.agoda.com") ||
        cookie.domain === ".agoda.com" ||
        cookie.domain === "ycs.agoda.com"
    );

    // If no domain-specific cookies, use all cookies
    const cookiesToUse = agodaCookies.length > 0 ? agodaCookies : cookies;

    // Build cookie string
    const cookieString = cookiesToUse
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    // Log important cookies for debugging (without exposing sensitive values)
    const importantCookieNames = [
      "ASP.NET_SessionId",
      "xsrf_token",
      "tokenp",
      "agoda.user.03",
      "agoda.analytics",
      "ai_session",
    ];
    const foundImportantCookies = cookiesToUse
      .filter((c) => importantCookieNames.includes(c.name))
      .map((c) => c.name);

    // Log cookie details (truncate values for security)
    const cookieDetails = cookiesToUse.map((c) => ({
      name: c.name,
      domain: c.domain,
      valueLength: c.value?.length || 0,
      valuePreview: c.value?.substring(0, 10) + "..." || "",
    }));

    await dualLogInfo("Extracted cookies from page", {
      jobId,
      totalCookies: cookies.length,
      agodaCookies: cookiesToUse.length,
      cookieStringLength: cookieString.length,
      foundImportantCookies: foundImportantCookies,
      missingImportantCookies: importantCookieNames.filter(
        (name) => !foundImportantCookies.includes(name)
      ),
      pageUrl: page.url(),
      cookieDetails: cookieDetails.slice(0, 10), // Log first 10 cookies
    });

    // Validate that we have at least some important cookies
    if (foundImportantCookies.length === 0) {
      await dualLogError(
        "Warning: No important authentication cookies found!",
        {
          jobId,
          allCookieNames: cookiesToUse.map((c) => c.name),
          pageUrl: page.url(),
        }
      );
    }

    // Validate cookie string is not empty
    if (!cookieString || cookieString.trim().length === 0) {
      await dualLogError("Cookie string is empty!", {
        jobId,
        pageUrl: page.url(),
        totalCookies: cookies.length,
      });
      throw new Error(
        "Cookie string is empty - cannot make authenticated request"
      );
    }

    return cookieString;
  } catch (error: any) {
    await dualLogError("Error extracting cookies from page:", error.message, {
      jobId,
      pageUrl: page.url(),
    });
    throw error;
  }
}

/**
 * Generates a Request-Id header in the format expected by Agoda API
 * Format: |{uuid}.{short-uuid}
 */
function generateRequestId(): string {
  const uuid1 = randomUUID().replace(/-/g, "");
  const uuid2 = randomUUID().replace(/-/g, "");
  const shortUuid = uuid2.substring(0, 16);
  return `|${uuid1}.${shortUuid}`;
}

/**
 * Generates a traceparent header for distributed tracing
 * Format: 00-{trace-id}-{parent-id}-01
 */
function generateTraceParent(): string {
  const traceId = randomUUID().replace(/-/g, "");
  const parentId = randomUUID().replace(/-/g, "").substring(0, 16);
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Extracts browser settings (User-Agent, Accept-Language, etc.) from Puppeteer page
 * Matches the exact settings configured in browser setup
 * @param page - Puppeteer page object
 * @returns Browser settings object
 */
async function extractBrowserSettings(page: Page): Promise<{
  userAgent: string;
  acceptLanguage: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
}> {
  try {
    // Get User-Agent from browser (should match BROWSER_CONFIG.USER_AGENT)
    const userAgent = await page.evaluate(() => navigator.userAgent);

    // Get Accept-Language from browser
    // The browser setup sets this via setExtraHTTPHeaders and also sets navigator.languages
    // Format should match: "en-GB,en-US;q=0.9,en;q=0.8"
    const acceptLanguage = await page.evaluate(() => {
      // Try to get from navigator.languages first (set by browser setup)
      if (navigator.languages && navigator.languages.length > 0) {
        // Format as Accept-Language header with quality values
        // First language gets q=1.0 (default), others get decreasing q values
        const languages = navigator.languages.map((lang, index) => {
          if (index === 0) return lang; // Primary language, no q value (defaults to 1.0)
          // Secondary languages get q values: 0.9, 0.8, etc.
          const qValue = (1.0 - index * 0.1).toFixed(1);
          return `${lang};q=${qValue}`;
        });
        return languages.join(", ");
      }
      // Fallback to navigator.language
      if (navigator.language) {
        return `${navigator.language},en;q=0.9`;
      }
      return null;
    });

    // Get sec-ch-ua from browser (if available via User-Agent Client Hints API)
    const secChUa = await page.evaluate(() => {
      // Try to get from navigator.userAgentData if available
      if ((navigator as any).userAgentData?.brands) {
        const brands = (navigator as any).userAgentData.brands;
        return brands
          .map((b: any) => `"${b.brand}";v="${b.version}"`)
          .join(", ");
      }
      return null;
    });

    // Get sec-ch-ua-platform from browser
    const secChUaPlatform = await page.evaluate(() => {
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac")) return '"macOS"';
      if (platform.includes("win")) return '"Windows"';
      if (platform.includes("linux")) return '"Linux"';
      return null;
    });

    // Use extracted values or fallback to BROWSER_CONFIG
    return {
      userAgent: userAgent || BROWSER_CONFIG.USER_AGENT,
      acceptLanguage:
        acceptLanguage || BROWSER_CONFIG.HEADERS["Accept-Language"],
      secChUa: secChUa || BROWSER_CONFIG.HEADERS["sec-ch-ua"],
      secChUaMobile: BROWSER_CONFIG.HEADERS["sec-ch-ua-mobile"] || "?0",
      secChUaPlatform:
        secChUaPlatform || BROWSER_CONFIG.HEADERS["sec-ch-ua-platform"],
    };
  } catch (error: any) {
    // Fallback to BROWSER_CONFIG if extraction fails
    await dualLogError(
      "Failed to extract browser settings, using defaults:",
      error.message
    );
    return {
      userAgent: BROWSER_CONFIG.USER_AGENT,
      acceptLanguage: BROWSER_CONFIG.HEADERS["Accept-Language"],
      secChUa: BROWSER_CONFIG.HEADERS["sec-ch-ua"],
      secChUaMobile: BROWSER_CONFIG.HEADERS["sec-ch-ua-mobile"] || "?0",
      secChUaPlatform: BROWSER_CONFIG.HEADERS["sec-ch-ua-platform"],
    };
  }
}

/**
 * Fetches booking data from Agoda API
 * @param page - Puppeteer page object (for cookies)
 * @param agodaId - Agoda property ID
 * @param startDate - Start date in YYYY-MM-DD format
 * @param endDate - End date in YYYY-MM-DD format
 * @param jobId - Optional job ID for logging
 * @returns API response data
 */
export async function fetchBookingDataFromAPI(
  page: Page,
  agodaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<any> {
  try {
    await dualLogInfo("Fetching booking data from Agoda API...", {
      agodaId,
      startDate,
      endDate,
      jobId,
    });

    // Extract cookies and browser settings from the page
    const cookieString = await extractCookiesFromPage(page, jobId);
    const browserSettings = await extractBrowserSettings(page);

    // Generate tracing headers
    const requestId = generateRequestId();
    const traceParent = generateTraceParent();

    await dualLogInfo("Extracted cookies and browser settings from page", {
      jobId,
      userAgent: browserSettings.userAgent.substring(0, 50) + "...",
      acceptLanguage: browserSettings.acceptLanguage,
    });

    // Convert dates to milliseconds timestamp
    const startTimestamp = convertDateToTimestamp(startDate);
    const endTimestamp = convertDateToTimestamp(endDate);

    // Construct API URL
    const apiUrl = `https://ycs.agoda.com/mldc/en-us/api/reporting/Booking/list/${agodaId}`;

    const headers = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": browserSettings.acceptLanguage,
      Connection: "keep-alive",
      "Content-Type": "application/json-patch+json",
      Cookie: cookieString,
      DNT: "1",
      Origin: "https://ycs.agoda.com",
      Referer: `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}`,
      "Request-Id": requestId,
      "User-Agent": browserSettings.userAgent,
      "sec-ch-ua": browserSettings.secChUa,
      "sec-ch-ua-mobile": browserSettings.secChUaMobile,
      "sec-ch-ua-platform": browserSettings.secChUaPlatform,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      traceparent: traceParent,
    };

    const stayDatePeriod = {
      from: `/Date(${startTimestamp})/`,
      to: `/Date(${endTimestamp})/`,
    };

    // Try 1: with bookingDatePeriod & lastUpdateDatePeriod (some properties need this)
    const bodyWithPeriods = {
      hotelId: parseInt(agodaId, 10),
      customerName: "",
      ackRequestTypes: ["All"],
      bookingDatePeriod: {},
      stayDatePeriod,
      lastUpdateDatePeriod: {},
      pageIndex: 1,
      pageSize: 1000,
    };

    await dualLogInfo("Making API request (with bookingDatePeriod/lastUpdateDatePeriod)", {
      url: apiUrl,
      body: bodyWithPeriods,
      jobId,
    });

    let response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyWithPeriods),
    });

    if (!response.ok) {
      const errorText = await response.text();
      await dualLogError(
        `API request failed with status ${response.status}: ${errorText}`,
        { jobId, status: response.status }
      );
      throw new Error(
        `Agoda API failed with status ${response.status}: ${errorText}`
      );
    }

    let responseData = await response.json();
    let list = extractBookingsArray(responseData);

    if (!list || list.length === 0) {
      // Try 2: browser-style body without period filters (some properties need this)
      const bodyWithoutPeriods = {
        hotelId: parseInt(agodaId, 10),
        customerName: "",
        ackRequestTypes: ["All"],
        stayDatePeriod,
        pageIndex: 1,
        pageSize: 1000,
      };
      await dualLogInfo("No bookings from first request, retrying with browser-style body (no period filters)", {
        url: apiUrl,
        jobId,
      });
      response = await fetch(apiUrl, {
        method: "POST",
        headers: { ...headers, "Request-Id": generateRequestId(), traceparent: generateTraceParent() },
        body: JSON.stringify(bodyWithoutPeriods),
      });
      if (!response.ok) {
        const errorText = await response.text();
        await dualLogError(
          `API fallback request failed with status ${response.status}: ${errorText}`,
          { jobId, status: response.status }
        );
        throw new Error(
          `Agoda API failed with status ${response.status}: ${errorText}`
        );
      }
      responseData = await response.json();
      list = extractBookingsArray(responseData);
    }

    const dataLen = JSON.stringify(responseData).length;
    await dualLogInfo("API request successful", {
      jobId,
      dataLength: dataLen,
      bookingsArrayLength: list?.length ?? null,
    });

    if (!list || list.length === 0) {
      const keys = responseData ? Object.keys(responseData) : [];
      const structure = keys.reduce((acc: Record<string, string>, k) => {
        const v = responseData[k];
        if (Array.isArray(v)) acc[k] = `array(${v.length})`;
        else if (v && typeof v === "object") acc[k] = `object(${Object.keys(v).join(",")})`;
        else acc[k] = typeof v;
        return acc;
      }, {});
      await dualLogError("API returned data but no bookings array found; response shape:", {
        jobId,
        responseKeys: keys,
        structure,
        dataLength: dataLen,
      });
    }

    return responseData;
  } catch (error: any) {
    await dualLogError("Error fetching booking data from API:", error.message, {
      jobId,
    });
    throw error;
  }
}

/**
 * Fetches booking summary from Agoda API
 * @param page - Puppeteer page object (for cookies)
 * @param agodaId - Agoda property ID
 * @param bookingToken - Booking token from the booking list
 * @param jobId - Optional job ID for logging
 * @returns Booking summary response data
 */
/**
 * Fetches booking summary with retry logic for rate limiting
 * @param page - Puppeteer page object (for cookies)
 * @param agodaId - Agoda property ID
 * @param bookingToken - Booking token from the booking list
 * @param jobId - Optional job ID for logging
 * @param retryCount - Current retry attempt (internal use)
 * @returns Booking summary response data
 */
export async function fetchBookingSummary(
  page: Page,
  agodaId: string,
  bookingToken: string,
  startDate?: string, // DD-MM-YYYY format for Referer header
  endDate?: string, // DD-MM-YYYY format for Referer header
  jobId?: string,
  retryCount: number = 0
): Promise<any> {
  const maxRetries = 3;
  const baseDelay = 1000; // Start with 1 second

  try {
    // Extract cookies and browser settings from the page
    const cookieString = await extractCookiesFromPage(page, jobId);
    const browserSettings = await extractBrowserSettings(page);

    // Construct API URL - bookingToken should already be URL encoded from the API response
    const encodedToken = encodeURIComponent(bookingToken);
    const apiUrl = `https://ycs.agoda.com/mldc/en-us/api/reporting/Booking/details/${agodaId}/bookingSummary?bookingToken=${encodedToken}`;

    // Build Referer header with date parameters (matching exact Postman format)
    let refererUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}`;
    if (startDate && endDate) {
      refererUrl += `?startDate=${startDate}&endDate=${endDate}`;
    }

    // Log request details for debugging
    await dualLogInfo("Making booking summary API request (Postman format)", {
      jobId,
      url: apiUrl,
      referer: refererUrl,
      cookieCount: cookieString.split(";").length,
      hasCookies: cookieString.length > 0,
      bookingToken: bookingToken.substring(0, 20) + "...",
    });

    // Make API request matching EXACT Postman/curl format (no Request-Id, no traceparent)
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": browserSettings.acceptLanguage,
        Connection: "keep-alive",
        Cookie: cookieString,
        DNT: "1",
        Referer: refererUrl,
        "User-Agent": browserSettings.userAgent,
        "sec-ch-ua": browserSettings.secChUa,
        "sec-ch-ua-mobile": browserSettings.secChUaMobile,
        "sec-ch-ua-platform": browserSettings.secChUaPlatform,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        // Note: Removed Request-Id and traceparent to match working Postman request
      },
    });

    // Handle rate limiting (429) with exponential backoff retry
    if (response.status === 429) {
      if (retryCount < maxRetries) {
        const retryDelay = baseDelay * Math.pow(2, retryCount); // Exponential backoff: 1s, 2s, 4s
        await dualLogInfo(
          `Rate limited (429) on booking summary. Retrying in ${retryDelay}ms (attempt ${
            retryCount + 1
          }/${maxRetries})`,
          { jobId, bookingToken, retryCount: retryCount + 1 }
        );
        await delay(retryDelay);
        return fetchBookingSummary(
          page,
          agodaId,
          bookingToken,
          startDate,
          endDate,
          jobId,
          retryCount + 1
        );
      } else {
        const errorText = await response.text();
        await dualLogError(
          `Booking summary API failed with status 429 after ${maxRetries} retries: ${errorText}`,
          { jobId, status: response.status, bookingToken, retryCount }
        );
        throw new Error(
          `Booking summary API failed with status 429 after ${maxRetries} retries`
        );
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      const responseHeaders = Object.fromEntries(response.headers.entries());

      await dualLogError(
        `Booking summary API failed with status ${response.status}: ${errorText}`,
        {
          jobId,
          status: response.status,
          statusText: response.statusText,
          bookingToken: bookingToken.substring(0, 20) + "...",
          responseHeaders: responseHeaders,
          cookieStringLength: cookieString.length,
        }
      );
      throw new Error(
        `Booking summary API failed with status ${response.status}: ${errorText}`
      );
    }

    const responseData = await response.json();

    // Validate response data structure
    if (!responseData || typeof responseData !== "object") {
      await dualLogError("Booking summary API returned invalid response data", {
        jobId,
        bookingToken: bookingToken.substring(0, 20) + "...",
        responseType: typeof responseData,
      });
      throw new Error("Invalid booking summary response data");
    }

    // Validate that we have at least bookingId (critical field)
    if (!responseData.bookingId && !responseData.booking_id) {
      await dualLogError("Booking summary API response missing bookingId", {
        jobId,
        bookingToken: bookingToken.substring(0, 20) + "...",
        responseKeys: Object.keys(responseData),
      });
      // Don't throw - return the data anyway, validation will happen at mapping level
    }

    await dualLogInfo("Booking summary API request successful", {
      jobId,
      bookingToken: bookingToken.substring(0, 20) + "...",
      responseKeys: Object.keys(responseData),
      hasBookingId: !!(responseData.bookingId || responseData.booking_id),
      hasCheckIn: !!responseData.checkInDate,
      hasCheckOut: !!responseData.checkOutDate,
      hasGuestName: !!responseData.guestName,
    });

    return responseData;
  } catch (error: any) {
    // Only log error if it's not a retryable 429 error
    if (!error.message.includes("429") || retryCount >= maxRetries) {
      await dualLogError("Error fetching booking summary:", error.message, {
        jobId,
        bookingToken,
        retryCount,
      });
    }
    throw error;
  }
}

/**
 * Maps API response data to CsvRecord format
 * Fetches booking summary for each booking (no booking details API needed)
 * @param apiData - API response data with structure: { bookings: [...], pagination: {...} }
 * @param page - Puppeteer page object (for cookies)
 * @param agodaId - Agoda property ID
 * @param jobId - Optional job ID for logging
 * @returns Array of CsvRecord objects with enriched data
 */
export async function mapApiResponseToCsvRecords(
  apiData: any,
  page: Page,
  agodaId: string,
  startDate?: string, // DD-MM-YYYY format for Referer header
  endDate?: string, // DD-MM-YYYY format for Referer header
  jobId?: string
): Promise<CsvRecord[]> {
  const bookings = extractBookingsArray(apiData);
  if (!apiData || !bookings || !Array.isArray(bookings)) {
    const keys = apiData ? Object.keys(apiData) : [];
    const structure = keys.length
      ? keys.reduce((acc: Record<string, string>, k) => {
          const v = apiData[k];
          if (Array.isArray(v)) acc[k] = `array(${v.length})`;
          else if (v && typeof v === "object") acc[k] = `object(${Object.keys(v).slice(0, 8).join(",")}${Object.keys(v).length > 8 ? "..." : ""})`;
          else acc[k] = typeof v;
          return acc;
        }, {})
      : {};
    await dualLogError("Booking list response missing bookings array", {
      jobId,
      responseKeys: keys,
      structure,
    });
    return [];
  }

  // Format dates from ISO format (2026-01-11T00:00:00) to YYYY-MM-DD
  const formatDate = (isoDate: string): string => {
    if (!isoDate) return "";
    // Extract date part from ISO string (YYYY-MM-DDTHH:mm:ss)
    const datePart = isoDate.split("T")[0];
    return datePart; // Returns YYYY-MM-DD format
  };

  const csvRecords: CsvRecord[] = [];
  const failedBookings: Array<{ item: any; attempt: number }> = [];
  const maxRetryAttempts = 3; // Maximum retry attempts for failed bookings

  // Normalize list item: browser returns camelCase (bookingId, checkinDate, guestName, ...); support snake_case as fallback
  const get = (item: any, camel: string, snake: string) =>
    item?.[camel] ?? item?.[snake];

  // Process each booking and fetch additional details
  for (let i = 0; i < bookings.length; i++) {
    const item = bookings[i];
    const bookingToken = get(item, "bookingToken", "booking_token");

    if (!bookingToken) {
      const bid = get(item, "bookingId", "booking_id");
      await dualLogError(
        `Skipping booking ${bid} - no bookingToken`,
        { jobId, bookingId: bid }
      );
      continue;
    }

    const listBookingId = get(item, "bookingId", "booking_id");
    let bookingSummary: any = null;
    let retryAttempt = 0;
    const maxAttempts = 3; // Retry up to 3 times per booking

    // Retry loop to ensure we get booking summary data
    while (retryAttempt < maxAttempts && !bookingSummary) {
      try {
        // Add human-like random delay before booking summary API call (1-5 seconds)
        // This simulates the time a human would take to click/interact with the UI
        // Helps reduce rate limiting (429 errors)
        const randomDelay =
          Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000; // Random between 1000ms (1s) and 5000ms (5s)
        await delay(randomDelay);

        // Fetch booking summary only (no booking details API needed)
        // Note: Function has retry logic for 429 errors
        // Pass startDate and endDate for proper Referer header (matching Postman format)
        bookingSummary = await fetchBookingSummary(
          page,
          agodaId,
          bookingToken,
          startDate, // DD-MM-YYYY format for Referer header
          endDate, // DD-MM-YYYY format for Referer header
          jobId
        );

        // Validate that we got meaningful data from booking summary
        if (bookingSummary) {
          // Check if we have at least some critical data
          const hasCriticalData =
            bookingSummary.checkInDate ||
            bookingSummary.checkOutDate ||
            bookingSummary.guestName ||
            bookingSummary.bookingId;

          if (!hasCriticalData) {
            await dualLogError(
              `Booking summary returned empty/invalid data for booking ${listBookingId}, will retry`,
              {
                jobId,
                bookingId: listBookingId,
                attempt: retryAttempt + 1,
                summaryKeys: Object.keys(bookingSummary || {}),
              }
            );
            bookingSummary = null; // Mark as failed to trigger retry
            retryAttempt++;
            if (retryAttempt < maxAttempts) {
              // Exponential backoff: 2s, 4s, 8s
              const retryDelay = 2000 * Math.pow(2, retryAttempt - 1);
              await dualLogInfo(
                `Retrying booking summary for ${
                  listBookingId
                } in ${retryDelay}ms (attempt ${
                  retryAttempt + 1
                }/${maxAttempts})`,
                { jobId, bookingId: listBookingId }
              );
              await delay(retryDelay);
            }
            continue;
          }

          // Success - we have valid booking summary data
          await dualLogInfo(
            `Successfully fetched booking summary for booking ${listBookingId}`,
            {
              jobId,
              bookingId: listBookingId,
              attempt: retryAttempt + 1,
              hasCheckIn: !!bookingSummary.checkInDate,
              hasCheckOut: !!bookingSummary.checkOutDate,
              hasGuestName: !!bookingSummary.guestName,
            }
          );
          break; // Exit retry loop
        }
      } catch (error: any) {
        retryAttempt++;
        await dualLogError(
          `Failed to fetch booking summary for booking ${listBookingId} (attempt ${retryAttempt}/${maxAttempts})`,
          error.message,
          { jobId, bookingId: listBookingId, attempt: retryAttempt }
        );

        if (retryAttempt < maxAttempts) {
          // Exponential backoff: 2s, 4s, 8s
          const retryDelay = 2000 * Math.pow(2, retryAttempt - 1);
          await dualLogInfo(
            `Retrying booking summary for ${
              listBookingId
            } in ${retryDelay}ms (attempt ${retryAttempt + 1}/${maxAttempts})`,
            { jobId, bookingId: listBookingId }
          );
          await delay(retryDelay);
        } else {
          // All retries exhausted - will use fallback data
          await dualLogError(
            `All retry attempts exhausted for booking ${listBookingId}, will use fallback data from booking list`,
            {
              jobId,
              bookingId: listBookingId,
              totalAttempts: retryAttempt,
            }
          );
        }
      }
    }

    // Create CSV record with priority: bookingSummary > bookingList item (browser shape: camelCase; snake_case fallback)
    const listCheckin = get(item, "checkinDate", "check_in_date");
    const listCheckout = get(item, "checkoutDate", "check_out_date");
    const listGuestName = get(item, "guestName", "guest_name");
    const listRoomType = get(item, "roomTypeName", "room_type_name");
    const csvRecord: CsvRecord = {
      BookingIDExternal_reference_ID: listBookingId
        ? String(listBookingId)
        : "",
      Status: "Confirmed",
      StayDateFrom:
        formatDate(bookingSummary?.checkInDate || "") ||
        formatDate(listCheckin || ""),
      StayDateTo:
        formatDate(bookingSummary?.checkOutDate || "") ||
        formatDate(listCheckout || ""),
      BookedDate: formatDate(bookingSummary?.bookingDate || ""),
      Customer_Name: bookingSummary?.guestName || listGuestName || "",
      RoomType: bookingSummary?.roomTypeName || listRoomType || "",
      CancellationPolicyDescription: "", // API doesn't provide cancellation policy
    };

    // Validate critical fields before adding
    if (!csvRecord.BookingIDExternal_reference_ID) {
      await dualLogError(
        `Skipping record - missing BookingIDExternal_reference_ID for booking ${listBookingId}`,
        { jobId, bookingId: listBookingId }
      );
      continue;
    }

    // Warn if we had to use fallback data
    if (!bookingSummary) {
      await dualLogError(
        `⚠️ Using fallback data from booking list for booking ${listBookingId} (summary API failed after ${maxAttempts} attempts)`,
        {
          jobId,
          bookingId: listBookingId,
          hasCheckIn: !!csvRecord.StayDateFrom,
          hasCheckOut: !!csvRecord.StayDateTo,
          hasGuestName: !!csvRecord.Customer_Name,
        }
      );
      // Track failed bookings for potential retry at the end
      failedBookings.push({ item, attempt: 0 });
    }

    csvRecords.push(csvRecord);

    // Log progress for large datasets
    if ((i + 1) % 10 === 0) {
      await dualLogInfo(
        `Processed ${i + 1}/${bookings.length} bookings (${
          csvRecords.length
        } successful, ${failedBookings.length} with fallback data)`,
        { jobId }
      );
    }
  }

  // Retry failed bookings one more time at the end (if any)
  if (failedBookings.length > 0) {
    await dualLogInfo(
      `Retrying ${failedBookings.length} bookings that failed to get summary data`,
      { jobId, failedCount: failedBookings.length }
    );

    for (const failed of failedBookings) {
      const { item } = failed;
      const bookingToken = get(item, "bookingToken", "booking_token");
      const bid = get(item, "bookingId", "booking_id");

      if (!bookingToken) continue;

      try {
        // Wait longer before retrying failed bookings
        await delay(5000); // 5 second delay for retry

        const bookingSummary = await fetchBookingSummary(
          page,
          agodaId,
          bookingToken,
          startDate,
          endDate,
          jobId
        ).catch(() => null);

        // If we got summary data, update the existing record
        if (bookingSummary) {
          const existingRecord =
            bid != null
              ? csvRecords.find((r) => r.BookingIDExternal_reference_ID === String(bid))
              : null;

          if (existingRecord) {
            // Update with summary data (prioritize summary over list data)
            existingRecord.StayDateFrom =
              formatDate(bookingSummary.checkInDate || "") ||
              existingRecord.StayDateFrom;
            existingRecord.StayDateTo =
              formatDate(bookingSummary.checkOutDate || "") ||
              existingRecord.StayDateTo;
            existingRecord.BookedDate =
              formatDate(bookingSummary.bookingDate || "") ||
              existingRecord.BookedDate;
            existingRecord.Customer_Name =
              bookingSummary.guestName || existingRecord.Customer_Name;
            existingRecord.RoomType =
              bookingSummary.roomTypeName || existingRecord.RoomType;

            await dualLogInfo(
              `✅ Successfully updated booking ${bid} with summary data on retry`,
              { jobId, bookingId: bid }
            );
          }
        }
      } catch (error: any) {
        await dualLogError(
          `Final retry failed for booking ${bid}`,
          error.message,
          { jobId, bookingId: bid }
        );
      }
    }
  }

  // Final summary
  const successfulCount = csvRecords.filter(
    (r) => r.StayDateFrom && r.StayDateTo
  ).length;
  const fallbackCount = failedBookings.length;

  await dualLogInfo(
    `Booking summary processing completed: ${successfulCount} with summary data, ${fallbackCount} with fallback data, ${csvRecords.length} total records`,
    {
      jobId,
      totalBookings: apiData.bookings.length,
      successfulWithSummary: successfulCount,
      usingFallback: fallbackCount,
      totalRecords: csvRecords.length,
    }
  );

  return csvRecords;
}
