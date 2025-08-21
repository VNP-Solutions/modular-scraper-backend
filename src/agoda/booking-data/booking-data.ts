import fs from "fs";
import Papa from "papaparse";
import path from "path";
import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import {
  autoDetectCleanupParams,
  cleanupFoldersOnError,
} from "../../common/folder-cleanup.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeManager } from "../../common/time-manager.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { PaymentInfo } from "../../models/job-item.model.js";
import { JobService } from "../../services/job.service.js";
import { automateNeedHelpWithCleanup } from "../need-help/need-help.js";

// Initialize job service
const jobService = new JobService();

// Interface for CSV export record
interface ExportCsvRecord {
  Portfolio: string;
  "Property Id": string;
  "Property Name": string;
  "Booking ID": string;
  StayDateFrom: string;
  StayDateTo: string;
  Customer_Name: string;
  Currency: string;
  "Remaining Amount": number;
}

// Interface for CSV record mapping
interface CsvRecord {
  BookingIDExternal_reference_ID: string;
  Status: string;
  StayDateFrom: string;
  StayDateTo: string;
  BookedDate: string;
  Customer_Name: string;
  RoomType: string;
  CancellationPolicyDescription?: string;
  [key: string]: any; // For other CSV fields
}

// Import the CreateJobItemData from job service to ensure type compatibility
import { CreateJobItemData } from "../../services/job.service.js";

/**
 * Parses date from various formats to JavaScript Date object
 * Handles both YYYY-MM-DD and MM/DD/YYYY formats
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

  const parsed = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  );
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Calculates the amount to charge or refund using the specified formula
 * Formula: (StayDateTo - StayDateFrom) * 19.35 * Math.random() + 5.23
 */
function calculateAmountToChargeOrRefund(
  checkInDate: Date,
  checkOutDate: Date
): number {
  const timeDifferenceInMs = checkOutDate.getTime() - checkInDate.getTime();
  const numberOfNights = Math.max(
    1,
    Math.ceil(timeDifferenceInMs / (1000 * 60 * 60 * 24))
  );

  const amount = numberOfNights * 19.35 * Math.random() + 5.23;
  return Math.round(amount * 100) / 100; // Round to 2 decimal places
}

/**
 * Maps CSV record to JobItem creation data
 */
function mapCsvToJobItem(
  csvRecord: CsvRecord,
  jobId: string,
  propertyId: string
): CreateJobItemData {
  // Validate required fields
  if (
    !csvRecord.BookingIDExternal_reference_ID ||
    csvRecord.BookingIDExternal_reference_ID.trim() === ""
  ) {
    throw new Error(
      "BookingIDExternal_reference_ID is required but missing or empty"
    );
  }

  const checkInDate = parseCsvDate(csvRecord.StayDateFrom);
  const checkOutDate = parseCsvDate(csvRecord.StayDateTo);
  const bookedDate = parseCsvDate(csvRecord.BookedDate);
  const amountToChargeOrRefund = calculateAmountToChargeOrRefund(
    checkInDate,
    checkOutDate
  );

  const paymentInfo: PaymentInfo = {
    // total_guest_payment: 0,
    // cancellation_fee: 0,
    // total_payout: 0,
    amount_to_charge_or_refund: amountToChargeOrRefund,
  };

  return {
    job_id: jobId,
    property_id: propertyId,
    guest_name: csvRecord.Customer_Name || "Unknown Guest",
    reservation_id: csvRecord.BookingIDExternal_reference_ID.trim(), // Use the validated, trimmed booking ID
    confirmation_number: "", // Not available in CSV, set to empty string
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    room_type: csvRecord.RoomType || "Unknown Room Type",
    booking_amount: 0, // Not available in CSV, set to 0
    booked_date: bookedDate,
    has_card_info: false, // No card info from CSV
    card_info: undefined,
    has_payment_info: true, // We're creating payment info
    payment_info: paymentInfo,
    reservation_status: csvRecord.Status || "Unknown",
    additional_text: csvRecord.CancellationPolicyDescription || undefined,
  };
}

/**
 * Saves mapped CSV records to database as JobItems
 */
async function saveCsvRecordsToDatabase(
  csvRecords: CsvRecord[],
  jobId: string,
  propertyId: string
): Promise<{ saved: number; errors: number }> {
  let savedCount = 0;
  let errorCount = 0;

  await dualLogInfo(
    `Starting to save ${csvRecords.length} CSV records to database`
  );

  for (let i = 0; i < csvRecords.length; i++) {
    const csvRecord = csvRecords[i];

    try {
      // Additional validation for the record
      if (
        !csvRecord.BookingIDExternal_reference_ID ||
        csvRecord.BookingIDExternal_reference_ID.trim() === ""
      ) {
        await dualLogError(
          `❌ Skipping record ${i + 1}/${
            csvRecords.length
          }: Missing or empty BookingIDExternal_reference_ID`,
          "Invalid CSV record",
          { jobId }
        );
        errorCount++;
        continue;
      }

      const jobItemData = mapCsvToJobItem(csvRecord, jobId, propertyId);
      const savedItem = await jobService.createJobItem(jobItemData);

      if (savedItem) {
        savedCount++;
        await dualLogInfo(
          `✅ Saved record ${i + 1}/${csvRecords.length}: ${
            csvRecord.BookingIDExternal_reference_ID
          }`,
          { jobId }
        );
      } else {
        errorCount++;
        await dualLogError(
          `❌ Failed to save record ${i + 1}/${csvRecords.length}: ${
            csvRecord.BookingIDExternal_reference_ID
          }`,
          "JobService returned null",
          { jobId }
        );
      }
    } catch (error: any) {
      errorCount++;
      await dualLogError(
        `❌ Error saving record ${i + 1}/${csvRecords.length}: ${
          csvRecord.BookingIDExternal_reference_ID || "undefined"
        }`,
        error.message,
        { jobId }
      );
    }

    // Update progress periodically
    if (jobId && (i + 1) % 10 === 0) {
      const progressPercentage =
        Math.round(((i + 1) / csvRecords.length) * 30) + 70; // 70-100% range
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        progressPercentage,
        `saving_csv_records_${i + 1}_of_${csvRecords.length}`,
        undefined
      );
    }
  }

  await dualLogInfo(
    `Database save completed: ${savedCount} saved, ${errorCount} errors`,
    { jobId, savedCount, errorCount }
  );

  return { saved: savedCount, errors: errorCount };
}

/**
 * Fetches job items from database for a specific property and formats them for CSV export
 */
async function fetchJobItemsForExport(
  jobId: string,
  propertyId: string
): Promise<ExportCsvRecord[]> {
  try {
    // Get job items for this job
    const jobItems = await jobService.getJobItems(jobId);

    // Get job details to get portfolio information
    const job = await jobService.getJobById(jobId);
    if (!job) {
      await dualLogError(`Job not found: ${jobId}`);
      return [];
    }

    // Get the actual agoda_id from the property
    const agodaIdResult = await jobService.getAgodaIdFromJob(jobId);
    const actualAgodaId = agodaIdResult?.agodaId || propertyId; // Fallback to propertyId if agoda_id not found

    await dualLogInfo(`Using Agoda ID for CSV export: ${actualAgodaId}`, {
      jobId,
      propertyId,
      actualAgodaId,
    });

    // Format job items for CSV export
    const exportRecords: ExportCsvRecord[] = jobItems.map((item) => {
      // Format dates as YYYY-MM-DD
      const stayDateFrom = item.check_in_date.toISOString().split("T")[0];
      const stayDateTo = item.check_out_date.toISOString().split("T")[0];

      // Get remaining amount from payment info
      const remainingAmount =
        item.payment_info?.amount_to_charge_or_refund || 0;

      return {
        Portfolio: job.portfolio_name || "Unknown Portfolio",
        "Property Id": actualAgodaId, // Use actual agoda_id instead of MongoDB _id
        "Property Name": job.property_name || "Unknown Property",
        "Booking ID": item.reservation_id || "",
        StayDateFrom: stayDateFrom,
        StayDateTo: stayDateTo,
        Customer_Name: item.guest_name || "",
        Currency: "USD", // Default currency, could be made configurable
        "Remaining Amount": remainingAmount,
      };
    });

    await dualLogInfo(
      `Fetched ${exportRecords.length} records for CSV export`,
      { jobId, propertyId }
    );

    return exportRecords;
  } catch (error: any) {
    await dualLogError(`Error fetching job items for export:`, error.message, {
      jobId,
      propertyId,
    });
    return [];
  }
}

/**
 * Creates CSV content from export records
 */
function createCsvContent(records: ExportCsvRecord[]): string {
  if (records.length === 0) {
    return 'Portfolio,"Property Id","Property Name","Booking ID",StayDateFrom,StayDateTo,Customer_Name,Currency,"Remaining Amount"\n';
  }

  // Create CSV with Papa Parse for proper formatting
  return Papa.unparse(records, {
    header: true,
    quotes: true,
  });
}

/**
 * Sanitizes property name for use in filename
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^\w\s-]/g, "") // Remove special characters except spaces and hyphens
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .toLowerCase(); // Convert to lowercase
}

// Old interactWithSupportChat function removed - now using modularized need-help.ts

/**
 * Exports booking data to CSV file in the import folder
 */
async function exportBookingDataToCsv(
  jobId: string,
  propertyId: string,
  propertyName: string
): Promise<void> {
  try {
    await dualLogInfo(`Starting CSV export for property: ${propertyName}`, {
      jobId,
      propertyId,
    });

    // Fetch data from database
    const exportRecords = await fetchJobItemsForExport(jobId, propertyId);

    if (exportRecords.length === 0) {
      await dualLogInfo(`No records to export for property: ${propertyName}`, {
        jobId,
        propertyId,
      });
      return;
    }

    // Create CSV content
    const csvContent = createCsvContent(exportRecords);

    // Get the actual agoda_id for filename (same as used in CSV content)
    const agodaIdResult = await jobService.getAgodaIdFromJob(jobId);
    const actualAgodaId = agodaIdResult?.agodaId;

    // Create filename: property-name-agoda-id.csv
    const sanitizedPropertyName = sanitizeFilename(propertyName);
    const filename = `${sanitizedPropertyName}-${actualAgodaId}.csv`;

    // Ensure import directory exists
    const importDir = path.resolve(process.cwd(), "import");
    if (!fs.existsSync(importDir)) {
      fs.mkdirSync(importDir, { recursive: true });
    }

    // Write CSV file
    const filePath = path.join(importDir, filename);
    fs.writeFileSync(filePath, csvContent, "utf8");

    await dualLogInfo(
      `✅ CSV export completed: ${filename} (${exportRecords.length} records)`,
      { jobId, propertyId, filePath, recordCount: exportRecords.length }
    );

    // Log file details
    const fileStats = fs.statSync(filePath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    await dualLogInfo(`📁 Exported file: ${filename}, Size: ${fileSizeKB} KB`, {
      jobId,
      propertyId,
    });
  } catch (error: any) {
    await dualLogError(
      `Error during CSV export for property: ${propertyName}`,
      error.message,
      { jobId, propertyId }
    );
    throw error;
  }
}

/**
 * Converts date from YYYY-MM-DD format to DD-MM-YYYY format
 * @param dateString - Date in YYYY-MM-DD format (e.g., "2024-01-31")
 * @returns Date in DD-MM-YYYY format (e.g., "31-01-2024")
 */
function convertDateFormat(dateString: string): string {
  // Handle both YYYY-MM-DD and MM/DD/YYYY formats for backward compatibility
  let year: string, month: string, day: string;

  if (dateString.includes("/")) {
    // MM/DD/YYYY format
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0");
    day = parts[1].padStart(2, "0");
    year = parts[2];
  } else if (dateString.includes("-")) {
    // YYYY-MM-DD format
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1].padStart(2, "0");
    day = parts[2].padStart(2, "0");
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }

  return `${day}-${month}-${year}`;
}

export async function getAgodaBookingData(
  browser: Browser,
  page: Page,
  agodaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<any[]> {
  let newPage: Page | undefined;
  let client: any;
  let isHeadless = false;

  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during booking data retrieval");
      throw new Error("Scraping was stopped during booking data retrieval");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        10,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Convert dates to DD-MM-YYYY format required by Agoda API
    const formattedStartDate = convertDateFormat(startDate);
    const formattedEndDate = convertDateFormat(endDate);

    // Set up download path early so it's available for retry
    const downloadPath = path.resolve(process.cwd(), "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    console.log(
      "\x1b[34m%s\x1b[0m",
      `Start Date: ${formattedStartDate}, End Date: ${formattedEndDate}`
    );

    // Construct the booking URL with agoda_id and date range using converted dates
    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`);

    await delay(5000);

    // Navigate to the booking data page
    newPage = await browser.newPage();
    await newPage.goto(bookingUrl, {
      waitUntil: "networkidle2",
      timeout: loadingTimeout,
    });

    await newPage.waitForSelector("body", { timeout: loadingTimeout });

    await dualLogInfo("Successfully navigated to booking data page");

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        30,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Wait for the page to load completely with enhanced server environment handling
    await dualLogInfo("Waiting for page to load completely...");
    await delay(5000);

    // Check pause state before proceeding
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during booking data retrieval");
    //   throw new Error("Scraping was stopped during booking data retrieval");
    // }

    // Enhanced page debugging for server environment
    await dualLogInfo(
      "Starting enhanced page analysis for server environment..."
    );

    // Check current URL and page state
    const currentUrl = newPage.url();
    await dualLogInfo(`Current page URL: ${currentUrl}`);

    // Check if we're on the right page
    if (
      !currentUrl.includes("ycs.agoda.com") ||
      !currentUrl.includes("booking")
    ) {
      await dualLogError(
        `Unexpected page URL. Expected booking page, got: ${currentUrl}`
      );

      // Take a screenshot for debugging
      try {
        const screenshot = await newPage.screenshot({ encoding: "base64" });
        await dualLogInfo(
          `Page screenshot taken (${screenshot.length} chars)`,
          { jobId }
        );
      } catch (screenshotError) {
        await dualLogError("Failed to take screenshot:", screenshotError);
      }

      throw new Error(
        `Not on expected booking page. Current URL: ${currentUrl}`
      );
    }

    // Check page content and authentication state
    const pageAnalysis = await newPage.evaluate(() => {
      const body = document.body;
      const title = document.title;
      const hasLoginForm =
        !!document.querySelector('form[action*="login"]') ||
        !!document.querySelector('input[type="password"]');
      const hasErrorMessage = !!document.querySelector(
        '.error, .alert, [class*="error"], [class*="alert"]'
      );
      const bodyText = body ? body.innerText.substring(0, 500) : "";
      const allButtons = Array.from(document.querySelectorAll("button")).map(
        (btn) => ({
          text: btn.textContent?.trim() || "",
          className: btn.className,
          dataElement: btn.getAttribute("data-element-name"),
          id: btn.id,
          visible: (btn as HTMLElement).offsetParent !== null,
        })
      );

      return {
        title,
        hasLoginForm,
        hasErrorMessage,
        bodyTextPreview: bodyText,
        buttonCount: allButtons.length,
        buttons: allButtons.slice(0, 10), // First 10 buttons for analysis
        pageHeight: body ? body.scrollHeight : 0,
        pageWidth: body ? body.scrollWidth : 0,
      };
    });

    await dualLogInfo("Page analysis results:", {
      jobId,
      pageAnalysis: {
        ...pageAnalysis,
        bodyTextPreview: pageAnalysis.bodyTextPreview.substring(0, 200) + "...",
      },
    });

    // Check for authentication issues
    if (pageAnalysis.hasLoginForm) {
      await dualLogError("Login form detected - user may not be authenticated");
      throw new Error(
        "Authentication required - login form detected on booking page"
      );
    }

    if (pageAnalysis.hasErrorMessage) {
      await dualLogError("Error message detected on page");
    }

    // Wait for page to be fully interactive with multiple strategies
    await dualLogInfo("Waiting for page to be fully interactive...");

    // Strategy 1: Wait for network to be idle
    try {
      await newPage.waitForNavigation({
        waitUntil: "networkidle0",
        timeout: 10000,
      });
    } catch (networkError) {
      await dualLogInfo("Network idle wait failed, continuing...");
      await delay(3000);
    }

    // Strategy 2: Wait for common page elements to be present
    const commonSelectors = [
      "body",
      "main",
      '[role="main"]',
      ".content",
      "#content",
      ".page-content",
    ];

    for (const selector of commonSelectors) {
      try {
        await newPage.waitForSelector(selector, { timeout: 5000 });
        await dualLogInfo(`Found common element: ${selector}`);
        break;
      } catch (error) {
        continue;
      }
    }

    // Strategy 3: Wait for any button to be present (indicates page is loaded)
    try {
      await newPage.waitForSelector("button", { timeout: 10000 });
      await dualLogInfo("At least one button found on page");
    } catch (error) {
      await dualLogError(
        "No buttons found on page - page may not be loaded properly"
      );
    }

    // Additional wait for server environment
    await dualLogInfo("Additional wait for server environment stability...");
    await delay(8000);

    // First check if there are any bookings on the page
    await dualLogInfo("Checking if page has booking data...");

    const pageContentAnalysis = await newPage.evaluate(() => {
      // Look for indicators that there are bookings
      const bookingIndicators = [
        "booking",
        "reservation",
        "guest",
        "check-in",
        "check-out",
        "total",
        "amount",
      ];

      const pageText = document.body?.innerText?.toLowerCase() || "";
      const foundIndicators = bookingIndicators.filter((indicator) =>
        pageText.includes(indicator)
      );

      // Look for specific booking-related elements
      const bookingElements = [
        "table",
        '[data-element-name*="booking"]',
        '[class*="booking"]',
        '[class*="reservation"]',
        ".booking-list",
        ".reservation-list",
      ];

      const foundElements = bookingElements.map((selector) => {
        try {
          const elements = document.querySelectorAll(selector);
          return {
            selector,
            count: elements.length,
            hasContent: elements.length > 0,
          };
        } catch (error) {
          return {
            selector,
            count: 0,
            hasContent: false,
          };
        }
      });

      // Check for "no data" or "empty" messages
      const noDataIndicators = [
        "no bookings",
        "no reservations",
        "no data",
        "no results",
        "empty",
        "no records found",
      ];

      const foundNoDataIndicators = noDataIndicators.filter((indicator) =>
        pageText.includes(indicator)
      );

      return {
        pageTextLength: pageText.length,
        foundBookingIndicators: foundIndicators,
        foundElements: foundElements,
        foundNoDataIndicators: foundNoDataIndicators,
        hasBookingTable: !!document.querySelector("table"),
        pageTextSample: pageText.substring(0, 500),
      };
    });

    await dualLogInfo("Page content analysis:", pageContentAnalysis);

    // If we detect "no data" indicators, return empty result early
    if (pageContentAnalysis.foundNoDataIndicators.length > 0) {
      await dualLogInfo(
        "Detected 'no data' indicators on page - no bookings available for this date range"
      );

      // Update progress to indicate completion with no data
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          100,
          "agoda_booking_data_no_data_available",
          undefined
        );
      }

      return []; // Return empty array for no data scenarios
    }

    // If booking data is found, wait for the download button to appear
    // The download button may take time to load after the booking data appears
    if (
      pageContentAnalysis.foundBookingIndicators.length > 0 ||
      pageContentAnalysis.hasBookingTable
    ) {
      await dualLogInfo(
        "Booking data detected - waiting for download button to appear..."
      );

      // Try clicking the search button to ensure booking data is fully loaded
      try {
        await dualLogInfo(
          "Attempting to click search button to ensure data is loaded..."
        );

        const searchButton = await newPage.$(
          'button[data-element-name="ycs-booking-search-button-apply"]'
        );
        if (searchButton) {
          await searchButton.click();
          await dualLogInfo(
            "Search button clicked - waiting for results to load..."
          );
          await delay(5000);
        } else {
          await dualLogInfo(
            "Search button not found - continuing without search click"
          );
        }
      } catch (searchError) {
        await dualLogInfo("Error clicking search button:", searchError);
        // Continue anyway
      }

      // Wait longer for the download button to appear after booking data loads
      await delay(10000); // Additional 10 seconds wait

      // Check if the page text now contains download button text
      const downloadButtonCheck = await newPage.evaluate(() => {
        const pageText = document.body?.innerText?.toLowerCase() || "";
        const hasDownloadText =
          pageText.includes("download") && pageText.includes("csv");
        const downloadButtons = Array.from(
          document.querySelectorAll("button")
        ).filter((btn) => {
          const text = btn.textContent?.toLowerCase() || "";
          return text.includes("download") || text.includes("csv");
        });

        return {
          hasDownloadText,
          downloadButtonCount: downloadButtons.length,
          downloadButtonTexts: downloadButtons
            .map((btn) => btn.textContent?.trim())
            .slice(0, 5),
          totalButtons: document.querySelectorAll("button").length,
          pageTextSample: pageText.substring(pageText.length - 200), // Last 200 chars
        };
      });

      await dualLogInfo(
        "Download button check after waiting:",
        downloadButtonCheck
      );

      // If still no download button, try scrolling to make sure all content is loaded
      if (downloadButtonCheck.downloadButtonCount === 0) {
        await dualLogInfo(
          "No download button found - trying to scroll to load more content..."
        );

        // Scroll to bottom to trigger any lazy loading
        await newPage.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });

        await delay(3000);

        // Scroll back to top
        await newPage.evaluate(() => {
          window.scrollTo(0, 0);
        });

        await delay(3000);

        // Check again after scrolling
        const postScrollCheck = await newPage.evaluate(() => {
          const pageText = document.body?.innerText?.toLowerCase() || "";
          const downloadButtons = Array.from(
            document.querySelectorAll("button")
          ).filter((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            return text.includes("download") || text.includes("csv");
          });

          return {
            downloadButtonCount: downloadButtons.length,
            downloadButtonTexts: downloadButtons
              .map((btn) => btn.textContent?.trim())
              .slice(0, 5),
            totalButtons: document.querySelectorAll("button").length,
          };
        });

        await dualLogInfo(
          "Download button check after scrolling:",
          postScrollCheck
        );
      }
    }

    // Wait for the download button container to be visible with enhanced detection
    await dualLogInfo(
      "Looking for CSV download button with enhanced detection..."
    );

    // Multiple selector strategies for the download button
    const downloadButtonSelectors = [
      'button[data-element-name="ycs-booking-list-download"]',
      'button[leadingicon="fill.arrow.download"]',
      'button:has-text("Download")',
      'button:has-text("CSV")',
      'button:has-text(".csv")',
      'button[class*="download"]',
      '[data-element-name*="download"]',
      'button:contains("Download")',
      'button span:contains("Download")',
    ];

    let downloadButtonFound = false;
    let foundSelector = "";

    // Try each selector with individual timeouts
    for (let i = 0; i < downloadButtonSelectors.length; i++) {
      const selector = downloadButtonSelectors[i];

      try {
        await dualLogInfo(
          `Trying selector ${i + 1}/${
            downloadButtonSelectors.length
          }: ${selector}`
        );

        await newPage.waitForSelector(selector, {
          visible: true,
          timeout: 8000, // 8 seconds per selector
        });

        foundSelector = selector;
        downloadButtonFound = true;
        await dualLogInfo(
          `✅ CSV download button found with selector: ${selector}`
        );
        break;
      } catch (selectorError) {
        await dualLogInfo(`❌ Selector failed: ${selector}`);

        // If this is the primary selector, wait a bit longer and try again
        if (i === 0) {
          await dualLogInfo(
            "Primary selector failed, waiting longer and retrying..."
          );
          await delay(5000);

          try {
            await newPage.waitForSelector(selector, {
              visible: true,
              timeout: 15000, // Longer timeout for primary selector retry
            });

            foundSelector = selector;
            downloadButtonFound = true;
            await dualLogInfo(
              `✅ CSV download button found on retry with primary selector: ${selector}`
            );
            break;
          } catch (retryError) {
            await dualLogInfo(
              "Primary selector retry also failed, continuing with other selectors..."
            );
          }
        }

        continue;
      }
    }

    if (!downloadButtonFound) {
      // Before giving up, try reopening the page once more
      await dualLogError(
        "CSV download button not found with any selector. Attempting page reload and retry..."
      );

      try {
        await dualLogInfo("Closing current page and reopening booking URL...");

        // Close the current page
        await newPage.close();

        // Wait a moment before reopening
        await delay(3000);

        // Create a new page and navigate again
        newPage = await browser.newPage();

        // Construct the booking URL again
        const retryBookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
        await dualLogInfo(
          `Retry - Navigating to booking data URL: ${retryBookingUrl}`
        );

        await newPage.goto(retryBookingUrl, {
          waitUntil: "networkidle2",
          timeout: loadingTimeout,
        });

        await newPage.waitForSelector("body", { timeout: loadingTimeout });
        await dualLogInfo(
          "Retry - Successfully navigated to booking data page"
        );

        // Wait for page to load completely
        await delay(8000);

        // Check if running in headless mode again
        isHeadless = await newPage.evaluate(() => {
          return navigator.webdriver === true || window.outerHeight === 0;
        });

        await dualLogInfo(
          `Retry - Browser mode detected: ${
            isHeadless ? "headless" : "headed"
          }`,
          { jobId }
        );

        // Try to find the download button again with a shorter timeout
        await dualLogInfo("Retry - Looking for CSV download button...");

        let retryButtonFound = false;
        let retryFoundSelector = "";

        for (let i = 0; i < downloadButtonSelectors.length; i++) {
          const selector = downloadButtonSelectors[i];

          try {
            await dualLogInfo(
              `Retry - Trying selector ${i + 1}/${
                downloadButtonSelectors.length
              }: ${selector}`
            );

            await newPage.waitForSelector(selector, {
              visible: true,
              timeout: 10000, // Shorter timeout for retry
            });

            retryFoundSelector = selector;
            retryButtonFound = true;
            await dualLogInfo(
              `✅ Retry - CSV download button found with selector: ${selector}`
            );
            break;
          } catch (selectorError) {
            await dualLogInfo(`❌ Retry - Selector failed: ${selector}`);
            continue;
          }
        }

        if (retryButtonFound) {
          // Update the found selector and continue with the download process
          foundSelector = retryFoundSelector;
          downloadButtonFound = true;
          await dualLogInfo(
            "✅ Retry successful - Download button found after page reload!"
          );

          // Set up CDP session and download configuration again for the new page
          try {
            await dualLogInfo(
              "Setting up download configuration for retry page..."
            );

            // Create CDP session for the new page
            client = await newPage.createCDPSession();

            // Enable downloads with headless-compatible settings
            await client.send("Page.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: downloadPath,
              eventsEnabled: true,
            });

            // Set additional permissions for headless mode
            if (isHeadless) {
              await dualLogInfo(
                "Applying headless-specific download settings for retry..."
              );

              // Enable file system access for headless mode
              try {
                await client.send("Browser.grantPermissions", {
                  permissions: ["downloads", "downloadsOpen"],
                  origin: "https://ycs.agoda.com",
                });
              } catch (error) {
                await dualLogInfo(
                  "Browser.grantPermissions not supported, trying alternative..."
                );
              }

              // Set download behavior with additional headless flags
              try {
                await client.send("Page.setDownloadBehavior", {
                  behavior: "allowAndName",
                  downloadPath: downloadPath,
                  eventsEnabled: true,
                });
              } catch (error) {
                await dualLogInfo(
                  "allowAndName not supported, using allow behavior"
                );
              }
            }

            // Platform-specific settings (keeping existing macOS logic)
            if (process.platform === "darwin") {
              await dualLogInfo(
                "Applying macOS-specific download settings for retry..."
              );

              // Set permissions for downloads
              await client
                .send("Browser.setPermission", {
                  permission: { name: "downloads" },
                  setting: "granted",
                  origin: "https://ycs.agoda.com",
                })
                .catch(() => {
                  // Ignore if this fails - not all browser versions support this
                  dualLogInfo(
                    "Browser.setPermission not supported, continuing..."
                  );
                });
            }

            await dualLogInfo(
              "Download configuration completed for retry page"
            );
          } catch (setupError: any) {
            await dualLogError(
              "Error setting up download configuration for retry:",
              setupError.message
            );
            // Continue anyway - the download might still work
          }

          // Continue to the download process (we'll break out of this error handling)
        } else {
          await dualLogError(
            "Retry failed - Download button still not found after page reload"
          );
        }
      } catch (retryError: any) {
        await dualLogError(
          "Error during page reload retry:",
          retryError.message
        );
      }
    }

    // If still not found after retry, perform final analysis
    if (!downloadButtonFound) {
      // Final debugging before failing
      await dualLogError(
        "CSV download button not found even after retry. Performing final analysis..."
      );

      const finalAnalysis = await newPage.evaluate(() => {
        // Helper function to safely get className as string
        const getClassNameString = (el: Element): string => {
          try {
            if (typeof el.className === "string") {
              return el.className.toLowerCase();
            } else if (
              el.className &&
              typeof (el.className as any).toString === "function"
            ) {
              return (el.className as any).toString().toLowerCase();
            } else if (el.getAttribute) {
              return (el.getAttribute("class") || "").toLowerCase();
            }
            return "";
          } catch (error) {
            return "";
          }
        };

        // Helper function to safely get text content
        const getTextContent = (el: Element): string => {
          try {
            return (el.textContent || "").toLowerCase();
          } catch (error) {
            return "";
          }
        };

        // Helper function to safely get id
        const getId = (el: Element): string => {
          try {
            return (el.id || "").toLowerCase();
          } catch (error) {
            return "";
          }
        };

        const allElements = Array.from(document.querySelectorAll("*"))
          .filter((el) => {
            try {
              const text = getTextContent(el);
              const className = getClassNameString(el);
              const id = getId(el);

              return (
                text.includes("download") ||
                text.includes("csv") ||
                className.includes("download") ||
                id.includes("download") ||
                el.hasAttribute("data-element-name")
              );
            } catch (error) {
              return false;
            }
          })
          .map((el) => {
            try {
              return {
                tagName: el.tagName || "UNKNOWN",
                textContent: (el.textContent || "").trim().substring(0, 50),
                className: getClassNameString(el),
                id: el.id || "",
                dataElementName: el.getAttribute("data-element-name") || null,
                visible: !!(el as HTMLElement).offsetParent,
              };
            } catch (error) {
              return {
                tagName: "ERROR",
                textContent: "Error reading element",
                className: "",
                id: "",
                dataElementName: null,
                visible: false,
              };
            }
          });

        // Also check for "no data" or "empty" messages
        const noDataMessages = Array.from(document.querySelectorAll("*"))
          .filter((el) => {
            try {
              const text = getTextContent(el);
              return (
                text.includes("no data") ||
                text.includes("no bookings") ||
                text.includes("no results") ||
                text.includes("empty") ||
                text.includes("no records")
              );
            } catch (error) {
              return false;
            }
          })
          .map((el) => {
            try {
              return {
                tagName: el.tagName || "UNKNOWN",
                textContent: (el.textContent || "").trim().substring(0, 100),
                visible: !!(el as HTMLElement).offsetParent,
              };
            } catch (error) {
              return {
                tagName: "ERROR",
                textContent: "Error reading element",
                visible: false,
              };
            }
          });

        // Safely get body className
        let bodyClasses = "";
        try {
          if (document.body) {
            bodyClasses = getClassNameString(document.body);
          }
        } catch (error) {
          bodyClasses = "error-reading-body-classes";
        }

        // Safely get body text sample
        let bodyTextSample = "";
        try {
          if (document.body && document.body.innerText) {
            bodyTextSample = document.body.innerText.substring(0, 1000);
          }
        } catch (error) {
          bodyTextSample = "error-reading-body-text";
        }

        return {
          elementsWithDownload: allElements.slice(0, 20),
          totalElements: allElements.length,
          noDataMessages: noDataMessages.slice(0, 5),
          pageTitle: document.title || "Unknown Title",
          bodyClasses: bodyClasses,
          url: window.location.href || "Unknown URL",
          bodyTextSample: bodyTextSample,
        };
      });

      await dualLogError(
        "Final page analysis - elements that might be download buttons:",
        finalAnalysis
      );

      // Check if this might be a "no data" scenario
      if (finalAnalysis.noDataMessages.length > 0) {
        await dualLogInfo(
          "Detected possible 'no data' scenario:",
          finalAnalysis.noDataMessages
        );

        // Return empty array instead of throwing error for no data scenarios
        await dualLogInfo(
          "No booking data available for the specified date range - returning empty result"
        );

        // Update progress to indicate completion with no data
        if (jobId) {
          await progressManager.updateJobProgress(
            jobId,
            undefined,
            100,
            "agoda_booking_data_no_data_available",
            undefined
          );
        }

        return []; // Return empty array for no data scenarios
      }

      // Take a screenshot for debugging
      try {
        const screenshot = await newPage.screenshot({ encoding: "base64" });
        await dualLogInfo(
          `Debug screenshot taken (${screenshot.length} chars)`,
          { jobId }
        );
      } catch (screenshotError) {
        await dualLogError("Failed to take debug screenshot:", screenshotError);
      }

      throw new Error(
        "CSV download button not found on the page after comprehensive search"
      );
    }

    // Update progress - download button found
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        50,
        "agoda_download_button_found",
        undefined
      );
    }

    // Log time session info before download
    await dualLogInfo("Time session info before CSV download", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

    // Download path already set up earlier

    await dualLogInfo(
      `Download configuration - Platform: ${process.platform}, Path: ${downloadPath}`,
      { jobId, platform: process.platform, downloadPath }
    );

    // Configure download behavior using CDP session with headless-compatible settings
    client = await newPage.createCDPSession();

    // Check if running in headless mode
    isHeadless = await newPage.evaluate(() => {
      return navigator.webdriver === true || window.outerHeight === 0;
    });

    await dualLogInfo(
      `Browser mode detected: ${isHeadless ? "headless" : "headed"}`,
      { jobId }
    );

    // Enable downloads with headless-compatible settings
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
      eventsEnabled: true,
    });

    // Set additional permissions for headless mode
    if (isHeadless) {
      await dualLogInfo("Applying headless-specific download settings...");

      // Enable file system access for headless mode
      try {
        await client.send("Browser.grantPermissions", {
          permissions: ["downloads", "downloadsOpen"],
          origin: "https://ycs.agoda.com",
        });
      } catch (error) {
        await dualLogInfo(
          "Browser.grantPermissions not supported, trying alternative..."
        );
      }

      // Set download behavior with additional headless flags
      try {
        await client.send("Page.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: downloadPath,
          eventsEnabled: true,
        });
      } catch (error) {
        await dualLogInfo("allowAndName not supported, using allow behavior");
      }
    }

    // Additional macOS-specific browser settings
    if (process.platform === "darwin") {
      await dualLogInfo("Applying macOS-specific download settings...");

      // Set permissions for downloads
      await client
        .send("Browser.setPermission", {
          permission: { name: "downloads" },
          setting: "granted",
          origin: "https://ycs.agoda.com",
        })
        .catch(() => {
          // Ignore if this fails - not all browser versions support this
          dualLogInfo("Browser.setPermission not supported, continuing...");
        });
    }

    await dualLogInfo("Download path configured, initiating CSV download...");

    // Use the found selector from the enhanced detection above
    const usedSelector = foundSelector;

    // Try multiple click approaches for better macOS compatibility
    try {
      await dualLogInfo("Attempting download button click...");

      // First check if button is actually present and enabled
      const buttonInfo = await newPage.evaluate((selector) => {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (!button) return { exists: false };

        // Get computed styles for better visibility detection
        const computedStyle = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();

        return {
          exists: true,
          visible: button.offsetParent !== null,
          disabled: button.disabled,
          textContent: button.textContent?.trim(),
          className: button.className,
          style: button.getAttribute("style"),
          computedDisplay: computedStyle.display,
          computedVisibility: computedStyle.visibility,
          computedOpacity: computedStyle.opacity,
          boundingRect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          leadingIcon: button.getAttribute("leadingicon"),
          buttonType: button.getAttribute("type"),
        };
      }, usedSelector);

      await dualLogInfo("Download button status:", buttonInfo);

      if (!buttonInfo.exists) {
        throw new Error("Download button not found in DOM");
      }

      if (buttonInfo.disabled) {
        throw new Error("Download button is disabled");
      }

      // Check if button is actually visible and clickable
      if (
        buttonInfo.boundingRect &&
        (buttonInfo.boundingRect.width === 0 ||
          buttonInfo.boundingRect.height === 0)
      ) {
        throw new Error("Download button has zero dimensions (may be hidden)");
      }

      if (
        buttonInfo.computedOpacity === "0" ||
        buttonInfo.computedVisibility === "hidden"
      ) {
        throw new Error("Download button is hidden via CSS");
      }

      // Set up network request interception for headless download fallback
      let downloadUrl: string | null = null;
      const requestHandler = (request: any) => {
        const url = request.url();
        // Look for CSV download requests
        if (
          url.includes("csv") ||
          url.includes("download") ||
          request.headers()["content-disposition"]
        ) {
          downloadUrl = url;
          dualLogInfo(`Intercepted potential download URL: ${url}`);
        }
      };

      // Enable request interception for headless mode
      if (isHeadless) {
        await newPage.setRequestInterception(true);
        newPage.on("request", (request) => {
          requestHandler(request);
          request.continue();
        });
      }

      // Method 1: Scroll to button and ensure it's in view
      await newPage.evaluate((selector) => {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (button) {
          button.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, usedSelector);

      await delay(1000); // Wait for scroll to complete

      // Method 2: Regular Puppeteer click
      await dualLogInfo(
        `Executing Puppeteer click with selector: ${usedSelector}`
      );
      await newPage.click(usedSelector);

      await delay(2000); // Give time for click to register

      // Method 3: Enhanced JavaScript click with comprehensive event simulation
      await dualLogInfo("Executing enhanced JavaScript click...");
      await newPage.evaluate((selector) => {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (button) {
          // Focus the button first
          button.focus();

          // Comprehensive mouse event simulation
          const events = [
            new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
            new MouseEvent("mouseenter", { bubbles: true, cancelable: true }),
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
            new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          ];

          events.forEach((event) => {
            button.dispatchEvent(event);
          });

          // Also try direct click
          button.click();

          // Try clicking on child elements (span with text)
          const span = button.querySelector("span");
          if (span) {
            span.click();
          }

          // For headless mode, also trigger any onclick handlers directly
          if (button.onclick) {
            button.onclick(new MouseEvent("click"));
          }
        }
      }, usedSelector);

      await dualLogInfo("Multiple click methods executed");

      console.log("👆 Clicked the download CSV button");
      await dualLogInfo("CSV download button clicked successfully");
    } catch (error: any) {
      await dualLogError("Error clicking CSV download button:", error);
      throw new Error("Failed to click CSV download button");
    }

    // Update progress - CSV download initiated
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        70,
        "agoda_csv_download_initiated",
        undefined
      );
    }

    // Set up download event listeners for better detection
    let downloadStarted = false;
    let downloadCompleted = false;

    client.on("Page.downloadWillBegin", (params: any) => {
      downloadStarted = true;
      dualLogInfo(`📥 Download started: ${params.suggestedFilename}`, {
        jobId,
        url: params.url,
        filename: params.suggestedFilename,
      });
    });

    client.on("Page.downloadProgress", (params: any) => {
      if (params.state === "completed") {
        downloadCompleted = true;
        dualLogInfo(`✅ Download completed: ${params.guid}`, { jobId });
      }
    });

    // Wait for download to complete with enhanced detection for headless mode
    await dualLogInfo("Waiting for CSV download to complete...");

    // Enhanced download detection for headless mode
    let downloadDetectionAttempts = 0;
    const maxDetectionAttempts = 15; // 30 seconds total

    while (
      downloadDetectionAttempts < maxDetectionAttempts &&
      !downloadStarted
    ) {
      await delay(2000);
      downloadDetectionAttempts++;

      // Check for files in download directory
      try {
        const files = fs.readdirSync(downloadPath);
        const csvFiles = files.filter(
          (f) =>
            f.endsWith(".csv") &&
            !f.includes(".crdownload") &&
            !f.includes(".download")
        );

        if (csvFiles.length > 0) {
          await dualLogInfo(`Found CSV file during detection: ${csvFiles[0]}`);
          downloadStarted = true;
          break;
        }
      } catch (error) {
        // Continue checking
      }

      await dualLogInfo(
        `Download detection attempt ${downloadDetectionAttempts}/${maxDetectionAttempts}`
      );
    }

    // Check if download started
    if (!downloadStarted) {
      await dualLogError("Download did not start within detection period", {
        jobId,
        platform: process.platform,
        isHeadless,
      });

      // In headless mode, try alternative download method
      if (isHeadless) {
        await dualLogInfo(
          "Attempting alternative download method for headless mode..."
        );

        try {
          // Try to get the download URL by inspecting network requests
          const downloadUrlFromNetwork = await newPage.evaluate(() => {
            // Look for any recent network requests that might be the CSV download
            const performanceEntries = performance.getEntriesByType("resource");
            const recentEntries = performanceEntries.filter(
              (entry) =>
                entry.name.includes("csv") ||
                entry.name.includes("download") ||
                entry.name.includes("booking")
            );
            return recentEntries.length > 0
              ? recentEntries[recentEntries.length - 1].name
              : null;
          });

          if (downloadUrlFromNetwork) {
            await dualLogInfo(
              `Found potential download URL: ${downloadUrlFromNetwork}`
            );

            // Download the file directly using fetch
            const response = await newPage.evaluate(async (url) => {
              const response = await fetch(url);
              if (response.ok) {
                const blob = await response.blob();
                return await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.readAsText(blob);
                });
              }
              return null;
            }, downloadUrlFromNetwork);

            if (response) {
              // Save the file directly
              const timestamp = Date.now();
              const fallbackFilename = `agoda_booking_data_${timestamp}.csv`;
              const fallbackPath = path.join(downloadPath, fallbackFilename);
              fs.writeFileSync(fallbackPath, response as string);

              await dualLogInfo(
                `Successfully downloaded CSV using fallback method: ${fallbackFilename}`
              );
              downloadStarted = true;
              downloadCompleted = true;
            }
          }
        } catch (fallbackError) {
          await dualLogError("Fallback download method failed:", fallbackError);
        }
      }
    } else {
      await dualLogInfo("Download detected, waiting for completion...");

      // Wait longer for completion if download started
      await delay(7000);
    }

    // Check pause state during download
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during CSV download");
      throw new Error("Scraping was stopped during CSV download");
    }

    // Log time session info during download wait
    await dualLogInfo("Time session info during CSV download wait", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

    // Find the downloaded CSV file with cross-platform support
    let csvFilePath: string | null = null;
    const maxWaitTime = 60000; // Increased to 60 seconds for slower connections
    const startTime = Date.now();

    await dualLogInfo("Scanning for downloaded CSV file...", { downloadPath });

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const files = fs.readdirSync(downloadPath);
        await dualLogInfo(
          `Found ${files.length} files in download directory: ${files.join(
            ", "
          )}`
        );

        // Platform-specific temporary file extensions to exclude
        const tempExtensions = [
          ".crdownload", // Chrome on Windows/Linux
          ".download", // Safari on macOS
          ".partial", // Firefox on Windows
          ".tmp", // General temporary files
          ".temp", // General temporary files
        ];

        // Check each file synchronously since we can't use await in find()
        let csvFile: string | undefined;

        for (const file of files) {
          // Must end with .csv
          if (!file.endsWith(".csv")) continue;

          // Must not have any temporary extension patterns
          const hasTemporaryExtension = tempExtensions.some(
            (ext) => file.includes(ext) || file.endsWith(ext)
          );

          if (hasTemporaryExtension) {
            await dualLogInfo(`Skipping temporary file: ${file}`);
            continue;
          }

          // Check if file exists and has content (avoid 0-byte files)
          const fullPath = path.join(downloadPath, file);
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size === 0) {
              await dualLogInfo(`Skipping empty file: ${file}`);
              continue;
            }
            await dualLogInfo(
              `Found valid CSV candidate: ${file} (${stats.size} bytes)`
            );
            csvFile = file;
            break; // Found a valid file
          } catch (statError) {
            await dualLogInfo(
              `Error checking file stats for ${file}: ${statError}`
            );
            continue;
          }
        }

        if (csvFile) {
          csvFilePath = path.join(downloadPath, csvFile);
          await dualLogInfo(`✅ CSV file confirmed: ${csvFile}`);
          break;
        }
      } catch (readDirError: any) {
        await dualLogError(
          `Error reading download directory: ${readDirError.message}`
        );
      }

      await delay(2000); // Increased delay for better stability
    }

    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
      // Enhanced error reporting for debugging
      const finalFiles = fs.readdirSync(downloadPath);
      await dualLogError(
        `❌ CSV download failed after ${maxWaitTime / 1000}s timeout`,
        `Platform: ${process.platform}, Files in directory: [${finalFiles.join(
          ", "
        )}]`,
        {
          jobId,
          downloadPath,
          platform: process.platform,
          filesFound: finalFiles,
          timeout: maxWaitTime,
        }
      );
      throw new Error(
        `CSV file not found after download. Platform: ${
          process.platform
        }, Files found: [${finalFiles.join(", ")}]`
      );
    }

    // Get file size for logging
    const fileStats = fs.statSync(csvFilePath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    await dualLogInfo(`CSV file size: ${fileSizeKB} KB`);

    // Update progress - CSV file downloaded and ready for processing
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        90,
        "agoda_csv_file_downloaded",
        undefined
      );
    }

    // Log time session info before CSV processing
    await dualLogInfo("Time session info before CSV processing", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

    // Read and parse the CSV file
    await dualLogInfo("Reading and parsing CSV file...");

    // Read the CSV file content as text first
    const csvContent = fs.readFileSync(csvFilePath, "utf8");

    // Parse CSV with PapaParse which handles multi-line fields properly
    const parseResult = Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      transform: (value) => value.trim(), // Trim whitespace from values
      transformHeader: (header) => header.trim(), // Trim whitespace from headers
    });

    if (parseResult.errors.length > 0) {
      await dualLogError("CSV parsing errors:", parseResult.errors);
    }

    // Filter out records that don't have a valid BookingIDExternal_reference_ID
    const formattedRecords = (parseResult.data as any[]).filter(
      (record: any) => {
        const hasValidBookingId =
          record.BookingIDExternal_reference_ID &&
          record.BookingIDExternal_reference_ID.trim() !== "";

        if (!hasValidBookingId) {
          console.log(
            "Skipping invalid record:",
            JSON.stringify(record, null, 2)
          );
        }

        return hasValidBookingId;
      }
    );

    await dualLogInfo(
      `Successfully parsed CSV file with ${formattedRecords.length} records`
    );

    // Console log the data for debugging
    console.log("=== AGODA BOOKING DATA ===");
    console.log(`📊 Total records: ${formattedRecords.length}`);
    console.log(`📁 CSV file path: ${csvFilePath}`);
    console.log(`💾 File size: ${fileSizeKB} KB`);

    if (formattedRecords.length > 0) {
      const headers = Object.keys(formattedRecords[0] as Record<string, any>);
      console.log(`📄 Headers count: ${headers.length}`);
      console.log("📋 CSV Columns:", headers);
      console.log("📝 First few records:");
      console.log(JSON.stringify(formattedRecords.slice(0, 3), null, 2));

      // Log sample of different types of data
      const sampleRecord = formattedRecords[0] as Record<string, any>;
      console.log("🔍 Sample record structure:");
      Object.entries(sampleRecord).forEach(([key, value]) => {
        console.log(`  ${key}: ${typeof value} = "${value}"`);
      });
    } else {
      console.log("⚠️ No records found in CSV file");
    }
    console.log("=== END AGODA BOOKING DATA ===");

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        100,
        "agoda_booking_data_retrieval_completed",
        undefined
      );
    }

    // // Clean up the downloaded file
    // try {
    //   fs.unlinkSync(csvFilePath);
    //   await dualLogInfo("Downloaded CSV file cleaned up");
    // } catch (cleanupError) {
    //   await dualLogError("Error cleaning up CSV file:", cleanupError);
    // }

    await dualLogInfo(
      `Successfully retrieved and processed ${formattedRecords.length} booking records`
    );

    // Save CSV records to database if we have jobId
    if (jobId && formattedRecords.length > 0) {
      try {
        // Get property_id from job for database storage
        const job = await jobService.getJobById(jobId);
        if (job && job.property_id) {
          const propertyIdForDb = job.property_id.toString();
          await dualLogInfo(
            `Starting database save with property_id: ${propertyIdForDb}`,
            { jobId, propertyIdForDb }
          );

          const saveResult = await saveCsvRecordsToDatabase(
            formattedRecords as CsvRecord[],
            jobId,
            propertyIdForDb
          );

          await dualLogInfo(
            `Database save completed: ${saveResult.saved} saved, ${saveResult.errors} errors`,
            { jobId, saveResult }
          );

          // Export to CSV after successful database save
          if (saveResult.saved > 0) {
            try {
              await dualLogInfo(
                `Starting CSV export after successful database save`,
                { jobId, propertyIdForDb }
              );

              await exportBookingDataToCsv(
                jobId,
                propertyIdForDb,
                job.property_name
              );

              await dualLogInfo(`CSV export completed successfully`, {
                jobId,
                propertyIdForDb,
              });

              // Interact with support chat after successful CSV export
              try {
                await dualLogInfo(
                  `Starting Need Help automation with cleanup after CSV export`,
                  { jobId, propertyIdForDb }
                );

                await automateNeedHelpWithCleanup(newPage, {
                  jobId,
                  cleanupAfter: true,
                  agodaId: agodaId,
                  propertyName: job.property_name,
                });

                await dualLogInfo(
                  `Need Help automation with cleanup completed`,
                  {
                    jobId,
                    propertyIdForDb,
                  }
                );
              } catch (chatError: any) {
                await dualLogError(
                  `Error during Need Help automation (continuing with job completion):`,
                  chatError.message,
                  { jobId, propertyIdForDb }
                );
                // Don't throw error - automation failure shouldn't fail the main job
              }
            } catch (csvExportError: any) {
              await dualLogError(
                `Error during CSV export (continuing with job completion):`,
                csvExportError.message,
                { jobId, propertyIdForDb }
              );
              // Don't throw error - CSV export failure shouldn't fail the main job
            }
          } else {
            await dualLogInfo(
              `Skipping CSV export - no records were saved to database`,
              { jobId, propertyIdForDb }
            );
          }

          // Update final progress
          await progressManager.updateJobProgress(
            jobId,
            undefined,
            100,
            `agoda_booking_data_saved_${saveResult.saved}_records`,
            undefined
          );
        } else {
          await dualLogError(
            `Could not get property_id from job ${jobId}, skipping database save`,
            { jobId }
          );
        }
      } catch (dbSaveError: any) {
        await dualLogError(
          `Error during database save for job ${jobId}:`,
          dbSaveError.message,
          { jobId }
        );
        // Don't throw error, just log it - we still want to return the CSV data
      }
    } else if (jobId) {
      await dualLogInfo(`No records to save to database for job ${jobId}`, {
        jobId,
      });
    }

    // Clean up CDP session and close the page
    try {
      await client.detach();
      await newPage.close();
    } catch (cleanupError) {
      await dualLogError("Error during cleanup:", cleanupError);
    }

    return formattedRecords;
  } catch (error: any) {
    await dualLogError(`Error retrieving Agoda booking data:`, error);

    // Log error details with time session info
    await dualLogInfo("Error occurred during Agoda booking data retrieval", {
      jobId,
      error: error.message,
      timeSession: timeManager.getSessionInfo(),
    });

    // Clean up resources in error case
    try {
      if (client) {
        await client.detach();
      }
      if (newPage) {
        await delay(10000);
        await newPage.close();
      }
    } catch (cleanupError) {
      await dualLogError("Error during error cleanup:", cleanupError);
    }

    // Cleanup folders on booking data error
    try {
      await dualLogInfo("Starting folder cleanup due to booking data error", {
        jobId,
        agodaId,
        timeSession: timeManager.getSessionInfo(),
      });

      // Try to auto-detect cleanup parameters if not provided
      const cleanupParams = await autoDetectCleanupParams(jobId);
      const finalAgodaId = agodaId || cleanupParams.agodaId;
      const finalPropertyName = cleanupParams.propertyName;

      const cleanupResult = await cleanupFoldersOnError(
        finalAgodaId,
        finalPropertyName,
        jobId
      );

      await dualLogInfo("Folder cleanup completed after booking data error", {
        jobId,
        downloadsCleanedCount: cleanupResult.downloadsCleanedCount,
        importCleanedCount: cleanupResult.importCleanedCount,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
        timeSession: timeManager.getSessionInfo(),
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during folder cleanup (continuing with error handling):",
        cleanupError.message,
        { jobId }
      );
      // Don't throw cleanup error - continue with original error handling
    }

    // Update progress with error for non-restart errors
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        0,
        "agoda_booking_data_error",
        undefined
      );
    }

    throw error;
  }
}
