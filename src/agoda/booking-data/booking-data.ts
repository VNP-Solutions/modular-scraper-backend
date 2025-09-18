import fs from "fs";
import Papa from "papaparse";
import path from "path";
import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { cleanupOnError } from "../utils/error-cleanup.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeSuccessScreenshot,
  takeErrorScreenshot,
} from "../../common/screenshot-helper.js";
import { timeManager } from "../../common/time-manager.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { PaymentInfo } from "../../models/job-item.model.js";
import { JobService } from "../../services/job.service.js";
import { automateNeedHelpWithCleanup } from "../need-help/need-help.js";
import {
  getStandardFilePaths,
  checkAndDeleteExistingFile,
  ensureDirectoryExists,
  standardizeDownloadedFile,
  validateFileForProcessing,
} from "../utils/file-naming.js";

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

    // Use standardized file naming (jobId only)
    const standardPaths = getStandardFilePaths(jobId);
    const { exportFilePath, exportDir } = standardPaths;

    // Ensure directory exists
    ensureDirectoryExists(exportDir);
    await dualLogInfo(`Ensured export directory exists: ${exportDir}`, {
      jobId,
    });

    // Check and delete existing file if it exists
    await checkAndDeleteExistingFile(exportFilePath, jobId);

    const filePath = exportFilePath;
    const filename = path.basename(filePath);
    fs.writeFileSync(filePath, csvContent, "utf8");

    // Validate the exported file
    await validateFileForProcessing(filePath, jobId, "CSV export verification");

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

    console.log(
      "\x1b[34m%s\x1b[0m",
      `Start Date: ${formattedStartDate}, End Date: ${formattedEndDate}`
    );

    // Construct the booking URL with agoda_id and date range using converted dates
    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`);

    await delay(5000);

    // Navigate to the booking data page
    const newPage = await browser.newPage();

    let navigationAttempts = 0;
    const maxNavigationAttempts = 3;
    let reservationsFound = false;

    while (navigationAttempts < maxNavigationAttempts && !reservationsFound) {
      navigationAttempts++;

      await dualLogInfo(
        `Navigation attempt ${navigationAttempts}/${maxNavigationAttempts} to booking data URL: ${bookingUrl}`
      );

      await newPage.goto(bookingUrl, {
        waitUntil: "networkidle2",
        timeout: loadingTimeout,
      });

      await newPage.waitForSelector("body", { timeout: loadingTimeout });

      // Wait for the page to load completely
      await delay(5000);

      // Check for "Reservations" text on the page
      try {
        await dualLogInfo("Checking for 'Reservations' text on the page...");

        // Look for the Reservations heading using multiple selectors
        const reservationsSelectors = [
          'h2:has-text("Reservations")',
          "h2.sc-iMTnTL.sc-krNlru.ioCOri.jnyliE",
          'h2:contains("Reservations")',
          '[class*="Reservations"]',
        ];

        let reservationsElement = null;

        // Try to find the reservations element using different approaches
        for (const selector of reservationsSelectors) {
          try {
            // First try with Puppeteer's built-in selector
            if (
              selector.includes(":has-text") ||
              selector.includes(":contains")
            ) {
              // Use evaluate for text-based selectors
              reservationsElement = await newPage.evaluate(() => {
                const headings = Array.from(document.querySelectorAll("h2"));
                return (
                  headings.find(
                    (h) => h.textContent?.trim() === "Reservations"
                  ) || null
                );
              });
            } else {
              // Use regular selector
              reservationsElement = await newPage.$(selector);
            }

            if (reservationsElement) {
              await dualLogInfo(
                `Found Reservations element with selector: ${selector}`
              );
              break;
            }
          } catch (selectorError) {
            // Continue to next selector
            continue;
          }
        }

        // Alternative approach: search for "Reservations" text in the page content
        if (!reservationsElement) {
          const pageText = await newPage.evaluate(
            () => document.body.textContent || ""
          );
          if (pageText.includes("Reservations")) {
            await dualLogInfo("Found 'Reservations' text in page content");
            reservationsElement = true; // Mark as found
          }
        }

        if (reservationsElement) {
          reservationsFound = true;
          console.log(
            "\x1b[32m%s\x1b[0m",
            "✅ Reservations text found - page loaded successfully!"
          );
          await dualLogInfo(
            "✅ Reservations text found - page loaded successfully!"
          );
          break;
        } else {
          await dualLogInfo(
            `❌ Reservations text not found on attempt ${navigationAttempts}`
          );

          if (navigationAttempts < maxNavigationAttempts) {
            await dualLogInfo(`Retrying navigation in 3 seconds...`);
            await delay(3000);
          }
        }
      } catch (checkError: any) {
        await dualLogError(
          `Error checking for Reservations text on attempt ${navigationAttempts}:`,
          checkError.message
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await dualLogInfo(`Retrying navigation due to check error...`);
          await delay(3000);
        }
      }
    }

    // Final validation
    if (!reservationsFound) {
      const errorMessage = `Failed to find 'Reservations' text after ${maxNavigationAttempts} navigation attempts`;
      await dualLogError(errorMessage);
      throw new Error(errorMessage);
    }

    await dualLogInfo(
      "Successfully navigated to booking data page and confirmed Reservations section"
    );

    // Take screenshot after successful navigation to booking data page
    if (jobId) {
      await takeSuccessScreenshot(newPage, jobId, "booking_page_loaded");
    }

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

    // Check pause state before proceeding
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during booking data retrieval");
    //   throw new Error("Scraping was stopped during booking data retrieval");
    // }

    // Wait for the download button container to be visible
    await dualLogInfo("Looking for CSV download button...");

    // Add debugging information about the page state
    try {
      await dualLogInfo(
        "Debugging page state for download button detection..."
      );

      // Set viewport to ensure consistent rendering
      await newPage.setViewport({ width: 1920, height: 1080 });
      await delay(2000);

      // Get page info for debugging
      const pageInfo = await newPage.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          bodyText: document.body.textContent?.substring(0, 500) || "",
          allButtons: Array.from(document.querySelectorAll("button"))
            .map((btn) => ({
              text: btn.textContent?.trim() || "",
              className: btn.className || "",
              dataElementName: btn.getAttribute("data-element-name") || "",
              leadingIcon: btn.getAttribute("leadingicon") || "",
              visible: btn.offsetParent !== null,
              disabled: btn.disabled,
            }))
            .slice(0, 10), // First 10 buttons for debugging
          hasDownloadButton: !!document.querySelector(
            'button[data-element-name="ycs-booking-list-download"]'
          ),
          hasAnyDownloadText:
            document.body.textContent?.toLowerCase().includes("download") ||
            false,
        };
      });

      await dualLogInfo("Page debugging info:", pageInfo);

      // Scroll to ensure all content is loaded
      await newPage.evaluate(() => {
        window.scrollTo(0, 0);
        window.scrollTo(0, document.body.scrollHeight);
        window.scrollTo(0, 0);
      });

      await delay(3000);

      // Try to wait for the download button using the specific selector with longer timeout
      await newPage.waitForSelector(
        'button[data-element-name="ycs-booking-list-download"]',
        {
          visible: true,
          timeout: selectorTimeout,
        }
      );

      await dualLogInfo("CSV download button found");

      // Take screenshot after download button is found
      if (jobId) {
        await takeSuccessScreenshot(newPage, jobId, "download_button_found");
      }
    } catch (error: any) {
      await dualLogError("Error waiting for CSV download button:", error);

      // Take error screenshot when download button is not found
      if (jobId) {
        await takeErrorScreenshot(newPage, jobId, "download_button_not_found");
      }

      // Additional debugging when button is not found
      try {
        await dualLogInfo(
          "Performing additional debugging for missing download button..."
        );

        const additionalDebug = await newPage.evaluate(() => {
          // Look for any elements that might be the download button
          const possibleButtons = Array.from(
            document.querySelectorAll("button")
          ).filter((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            const className = btn.className.toLowerCase();
            const dataName = btn.getAttribute("data-element-name") || "";

            return (
              text.includes("download") ||
              text.includes("csv") ||
              className.includes("download") ||
              dataName.includes("download")
            );
          });

          return {
            possibleDownloadButtons: possibleButtons.map((btn) => ({
              text: btn.textContent?.trim(),
              className: btn.className,
              dataElementName: btn.getAttribute("data-element-name"),
              leadingIcon: btn.getAttribute("leadingicon"),
              id: btn.id,
              visible: btn.offsetParent !== null,
              disabled: btn.disabled,
              outerHTML: btn.outerHTML.substring(0, 200),
            })),
            pageHasData:
              document.body.textContent?.includes("Booking ID") || false,
            pageHasTable: !!document.querySelector("table"),
            pageHasList: !!document.querySelector('[data-testid*="booking"]'),
            fullPageText: document.body.textContent?.substring(0, 1000) || "",
          };
        });

        await dualLogInfo("Additional debugging info:", additionalDebug);

        // Check if there might be no data to download
        if (!additionalDebug.pageHasData && !additionalDebug.pageHasTable) {
          await dualLogInfo(
            "Page might not have booking data to download - this could be expected if no reservations exist for the date range"
          );
        }
      } catch (debugError) {
        await dualLogError("Error during additional debugging:", debugError);
      }

      throw new Error("CSV download button not found on the page");
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

    // Use standardized file paths for download
    if (!jobId) {
      throw new Error("JobId is required for standardized file naming");
    }

    const standardPaths = getStandardFilePaths(jobId);
    const { downloadFilePath, downloadDir } = standardPaths;
    const downloadPath = downloadDir;

    // Ensure download directory exists
    ensureDirectoryExists(downloadPath);
    await dualLogInfo(`Ensured download directory exists: ${downloadPath}`, {
      jobId,
    });

    // Check and delete existing download file if it exists
    await checkAndDeleteExistingFile(downloadFilePath, jobId);

    await dualLogInfo(
      `Download configuration - Platform: ${process.platform}, Path: ${downloadPath}`,
      {
        jobId,
        platform: process.platform,
        downloadPath,
        isJobSpecific: !!jobId,
      }
    );

    // Configure download behavior using CDP session with macOS-specific settings
    client = await newPage.createCDPSession();

    // Enable downloads with more permissive settings for macOS
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
      eventsEnabled: true, // Enable download events
    });

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

    // Wait for the button to be fully interactive with multiple selectors
    await dualLogInfo(
      "Attempting to find download button with multiple selectors..."
    );

    const downloadButtonSelectors = [
      'button[data-element-name="ycs-booking-list-download"]',
      'button[leadingicon="fill.arrow.download"]',
      'button:has-text("Download (.csv)")',
      'button:has([role="img"]) span:has-text("Download")',
    ];

    let buttonFound = false;
    let usedSelector = "";

    // First try the standard selectors
    for (const selector of downloadButtonSelectors) {
      try {
        await newPage.waitForSelector(selector, {
          visible: true,
          timeout: 10000,
        });
        usedSelector = selector;
        buttonFound = true;
        await dualLogInfo(`Download button found with selector: ${selector}`);
        break;
      } catch (error) {
        await dualLogInfo(`Selector failed: ${selector}`);
        continue;
      }
    }

    // If standard selectors fail, try alternative detection methods
    if (!buttonFound) {
      await dualLogInfo(
        "Standard selectors failed, trying alternative detection methods..."
      );

      try {
        // Method 1: Look for any button containing "Download" text
        const downloadButtonByText = await newPage.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          return buttons.find((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            return (
              text.includes("download") &&
              (text.includes("csv") || text.includes(".csv"))
            );
          });
        });

        if (downloadButtonByText) {
          // Create a selector for this button
          usedSelector = "button"; // We'll use evaluate to click it
          buttonFound = true;
          await dualLogInfo("Download button found by text content");
        }
      } catch (textSearchError) {
        await dualLogInfo("Text-based button search failed");
      }

      // Method 2: Look for buttons with download-related attributes
      if (!buttonFound) {
        try {
          const downloadButtonByAttr = await newPage.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            return buttons.find((btn) => {
              const dataName = btn.getAttribute("data-element-name") || "";
              const className = btn.className.toLowerCase();
              const leadingIcon = btn.getAttribute("leadingicon") || "";

              return (
                dataName.includes("download") ||
                className.includes("download") ||
                leadingIcon.includes("download") ||
                leadingIcon.includes("arrow")
              );
            });
          });

          if (downloadButtonByAttr) {
            usedSelector =
              'button[data-element-name*="download"], button[class*="download"], button[leadingicon*="download"], button[leadingicon*="arrow"]';
            buttonFound = true;
            await dualLogInfo("Download button found by attributes");
          }
        } catch (attrSearchError) {
          await dualLogInfo("Attribute-based button search failed");
        }
      }

      // Method 3: Check if page has no data (empty state)
      if (!buttonFound) {
        const pageState = await newPage.evaluate(() => {
          const bodyText = document.body.textContent?.toLowerCase() || "";
          return {
            hasNoDataMessage:
              bodyText.includes("no data") ||
              bodyText.includes("no results") ||
              bodyText.includes("no reservations") ||
              bodyText.includes("no bookings"),
            hasEmptyState:
              bodyText.includes("empty") ||
              bodyText.includes("nothing to show"),
            totalButtons: document.querySelectorAll("button").length,
            hasTableData: !!document.querySelector(
              "table tbody tr:not(:empty)"
            ),
            hasListData: !!document.querySelector(
              '[data-testid*="booking"], [data-testid*="reservation"]'
            ),
          };
        });

        await dualLogInfo("Page state analysis:", pageState);

        if (
          pageState.hasNoDataMessage ||
          pageState.hasEmptyState ||
          (!pageState.hasTableData && !pageState.hasListData)
        ) {
          await dualLogInfo(
            "Page appears to have no booking data - this might be expected for the selected date range"
          );
          // In this case, we should handle it gracefully rather than throwing an error
          // Return empty data instead of failing
          return [];
        }
      }
    }

    if (!buttonFound) {
      throw new Error("Download button not found with any detection method");
    }

    // Try multiple click approaches for better compatibility
    try {
      await dualLogInfo("Attempting download button click...");

      // Handle different selector types
      let buttonInfo;

      if (usedSelector === "button") {
        // For text-based detection, find the specific button
        buttonInfo = await newPage.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const downloadButton = buttons.find((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            return (
              text.includes("download") &&
              (text.includes("csv") || text.includes(".csv"))
            );
          });

          if (!downloadButton) return { exists: false };

          const computedStyle = window.getComputedStyle(downloadButton);
          const rect = downloadButton.getBoundingClientRect();

          return {
            exists: true,
            visible: downloadButton.offsetParent !== null,
            disabled: downloadButton.disabled,
            textContent: downloadButton.textContent?.trim(),
            className: downloadButton.className,
            style: downloadButton.getAttribute("style"),
            computedDisplay: computedStyle.display,
            computedVisibility: computedStyle.visibility,
            computedOpacity: computedStyle.opacity,
            boundingRect: {
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
            },
            leadingIcon: downloadButton.getAttribute("leadingicon"),
            buttonType: downloadButton.getAttribute("type"),
            dataElementName: downloadButton.getAttribute("data-element-name"),
          };
        });
      } else {
        // For standard selectors
        buttonInfo = await newPage.evaluate((selector) => {
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
            dataElementName: button.getAttribute("data-element-name"),
          };
        }, usedSelector);
      }

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

      // Method 1: Scroll to button and ensure it's in view
      if (usedSelector === "button") {
        // For text-based detection
        await newPage.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const downloadButton = buttons.find((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            return (
              text.includes("download") &&
              (text.includes("csv") || text.includes(".csv"))
            );
          });
          if (downloadButton) {
            downloadButton.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }
        });
      } else {
        // For standard selectors
        await newPage.evaluate((selector) => {
          const button = document.querySelector(selector) as HTMLButtonElement;
          if (button) {
            button.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, usedSelector);
      }

      await delay(1000); // Wait for scroll to complete

      // Method 2: Regular Puppeteer click (only for standard selectors)
      if (usedSelector !== "button") {
        await dualLogInfo(
          `Executing Puppeteer click with selector: ${usedSelector}`
        );
        try {
          await newPage.click(usedSelector);
          await delay(2000); // Give time for click to register
        } catch (clickError) {
          await dualLogInfo("Puppeteer click failed, trying JavaScript click");
        }
      }

      // Method 3: Enhanced JavaScript click with comprehensive event simulation
      await dualLogInfo("Executing enhanced JavaScript click...");
      if (usedSelector === "button") {
        // For text-based detection
        await newPage.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const downloadButton = buttons.find((btn) => {
            const text = btn.textContent?.toLowerCase() || "";
            return (
              text.includes("download") &&
              (text.includes("csv") || text.includes(".csv"))
            );
          }) as HTMLButtonElement;

          if (downloadButton) {
            // Focus the button first
            downloadButton.focus();

            // Comprehensive mouse event simulation
            const events = [
              new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
              new MouseEvent("mouseenter", { bubbles: true, cancelable: true }),
              new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
              new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            ];

            events.forEach((event) => {
              downloadButton.dispatchEvent(event);
            });

            // Also try direct click
            downloadButton.click();

            // Try clicking on child elements (span with text)
            const span = downloadButton.querySelector("span");
            if (span) {
              span.click();
            }
          }
        });
      } else {
        // For standard selectors
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
          }
        }, usedSelector);
      }

      await dualLogInfo("Multiple click methods executed");

      console.log("👆 Clicked the download CSV button");
      await dualLogInfo("CSV download button clicked successfully");

      // Take screenshot after successfully clicking download button
      if (jobId) {
        await takeSuccessScreenshot(newPage, jobId, "download_button_clicked");
      }
    } catch (error: any) {
      await dualLogError("Error clicking CSV download button:", error);

      // Take error screenshot when button click fails
      if (jobId) {
        await takeErrorScreenshot(
          newPage,
          jobId,
          "download_button_click_failed"
        );
      }

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

    // Wait for download to complete with event-based detection
    await dualLogInfo("Waiting for CSV download to complete...");

    // Initial wait to let download start
    await delay(3000);

    // Check if download started
    if (!downloadStarted) {
      await dualLogError("Download did not start within 3 seconds", {
        jobId,
        platform: process.platform,
      });
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

    // Wait for download completion and standardize file naming
    const maxWaitTime = 60000; // 60 seconds timeout
    const startTime = Date.now();
    let csvFilePath: string | null = null;

    await dualLogInfo(
      "Waiting for CSV download completion and standardization...",
      { downloadPath }
    );

    // Wait for download to complete and then standardize the filename
    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Use standardizeDownloadedFile to find and rename the downloaded file
        const standardFileName = path.basename(downloadFilePath);
        const standardizedPath = await standardizeDownloadedFile(
          downloadPath,
          jobId,
          standardFileName
        );

        if (standardizedPath && fs.existsSync(standardizedPath)) {
          csvFilePath = standardizedPath;
          await dualLogInfo(
            `✅ Downloaded file standardized to: ${path.basename(csvFilePath)}`,
            { jobId, filePath: csvFilePath }
          );
          break;
        }
      } catch (standardizeError: any) {
        await dualLogError(
          `Error during file standardization: ${standardizeError.message}`,
          { jobId }
        );
      }

      await delay(2000);
    }

    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
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

    // Take screenshot after CSV file is successfully downloaded
    if (jobId) {
      await takeSuccessScreenshot(newPage, jobId, "csv_download_completed");
    }

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

    // Validate file before processing
    await validateFileForProcessing(csvFilePath, jobId, "CSV processing");

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

          // Take screenshot after data is successfully saved
          if (jobId) {
            await takeSuccessScreenshot(
              newPage,
              jobId,
              "data_processing_completed"
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

    // Take error screenshot when booking data retrieval fails
    if (jobId && newPage) {
      try {
        await takeErrorScreenshot(
          newPage,
          jobId,
          "booking_data_retrieval_error"
        );
      } catch (screenshotError) {
        await dualLogError(
          "Failed to take booking data retrieval error screenshot:",
          screenshotError
        );
      }
    }

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

    // Standardized cleanup on booking data error
    try {
      await dualLogInfo(
        "Starting standardized cleanup due to booking data error",
        {
          jobId,
          agodaId,
          timeSession: timeManager.getSessionInfo(),
        }
      );

      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        operation: "agoda_booking_data_error",
      });

      await dualLogInfo(
        "Standardized cleanup completed after booking data error",
        {
          jobId,
          downloadFilesCleanedCount: cleanupResult.downloadFilesCleanedCount,
          exportFilesCleanedCount: cleanupResult.exportFilesCleanedCount,
          foldersRemovedCount: cleanupResult.foldersRemovedCount,
          totalFilesProcessed: cleanupResult.totalFilesProcessed,
          errors: cleanupResult.errors.length,
          timeSession: timeManager.getSessionInfo(),
        }
      );
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup (continuing with error handling):",
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
