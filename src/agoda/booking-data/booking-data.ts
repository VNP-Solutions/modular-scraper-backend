import fs from "fs";
import Papa from "papaparse";
import path from "path";
import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "../../common/screenshot-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { PaymentInfo } from "../../models/job-item.model.js";
import { JobStatus } from "../../models/job.model.js";
import { JobService } from "../../services/job.service.js";
import {
  CsvRecord,
  fetchBookingDataFromAPI,
  mapApiResponseToCsvRecords,
} from "../api/booking-api.js";
import { automateNeedHelpWithCleanup } from "../need-help/need-help.js";
import {
  checkAndDeleteExistingFile,
  ensureDirectoryExists,
  getStandardFilePaths,
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

// CsvRecord interface is imported from api/booking-api.ts

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
  // Use provided amount if available, otherwise calculate it
  let amountToChargeOrRefund: number;
  if (csvRecord.amount_to_charge_or_refund !== undefined) {
    amountToChargeOrRefund = csvRecord.amount_to_charge_or_refund;
  } else {
    amountToChargeOrRefund = calculateAmountToChargeOrRefund(
        checkInDate,
        checkOutDate
    );
  }

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
    // MM/DD/YYYY format (User input) -> DD-MM-YYYY (Agoda API)
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0"); // First part is Month
    day = parts[1].padStart(2, "0");   // Second part is Day
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

/**
 * Parses an input date string (YYYY-MM-DD or MM/DD/YYYY) into a Date object.
 */
function parseInputDate(dateString: string): Date {
  if (dateString.includes("/")) {
    const [m, d, y] = dateString.split("/");
    return new Date(
      parseInt(y, 10),
      parseInt(m, 10) - 1,
      parseInt(d, 10)
    );
  } else if (dateString.includes("-")) {
    const [y, m, d] = dateString.split("-");
    return new Date(
      parseInt(y, 10),
      parseInt(m, 10) - 1,
      parseInt(d, 10)
    );
  }
  throw new Error(`Unsupported date format: ${dateString}`);
}

/**
 * Formats a Date object back to YYYY-MM-DD (the canonical internal format).
 */
function formatDateToYYYYMMDD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Caps the booking-data date range. Agoda's reporting page can't reliably load
 * very large windows, so if the requested range exceeds MAX_RANGE_DAYS we shift
 * the start date to (endDate - CAPPED_RANGE_DAYS) and keep the original end date.
 */
const MAX_RANGE_DAYS = 360;
const CAPPED_RANGE_DAYS = 350;

function capDateRangeIfNeeded(
  startDate: string,
  endDate: string
): { startDate: string; endDate: string; wasCapped: boolean; diffDays: number } {
  const start = parseInputDate(startDate);
  const end = parseInputDate(endDate);
  const diffDays = Math.floor(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays > MAX_RANGE_DAYS) {
    const newStart = new Date(end);
    newStart.setDate(newStart.getDate() - CAPPED_RANGE_DAYS);
    return {
      startDate: formatDateToYYYYMMDD(newStart),
      endDate: formatDateToYYYYMMDD(end),
      wasCapped: true,
      diffDays,
    };
  }

  return { startDate, endDate, wasCapped: false, diffDays };
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

    // If the requested window is bigger than 1 year (365 days), cap it so we
    // only fetch the last 250 days ending at the requested end date.
    const {
      startDate: effectiveStartDate,
      endDate: effectiveEndDate,
      wasCapped,
      diffDays,
    } = capDateRangeIfNeeded(startDate, endDate);

    if (wasCapped) {
      await dualLogInfo(
        `Requested date range is ${diffDays} days (> ${MAX_RANGE_DAYS}). ` +
          `Capping start date to the last ${CAPPED_RANGE_DAYS} days. ` +
          `Original: ${startDate} -> ${endDate}, ` +
          `Adjusted: ${effectiveStartDate} -> ${effectiveEndDate}`
      );
    }

    // Convert dates to DD-MM-YYYY format required by Agoda API
    const formattedStartDate = convertDateFormat(effectiveStartDate);
    const formattedEndDate = convertDateFormat(effectiveEndDate);

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
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during booking data retrieval");
      throw new Error("Scraping was stopped during booking data retrieval");
    }

    // Wait for booking table to load before calling API
    let formattedRecords: CsvRecord[] = [];

    // Wait for booking table to load per user requirement
    await dualLogInfo("Waiting for booking table to load...");
    try {
      await newPage.waitForSelector('div[data-testid="booking-list-box"]', { visible: true, timeout: 15000 });
      await dualLogInfo("✅ Booking table loaded (verified via data-testid='booking-list-box')");
    } catch (e) {
      await dualLogInfo("⚠️ Booking table container not immediately found, proceeding...");
    }

    // OLD METHOD (COMMENTED OUT): CSV Download via UI Button Click
    // This method is no longer used - we now directly call the API instead
    /*
    let downloadSuccess = false;

    try {
      await dualLogInfo("Attempting to download CSV file via UI button...");
      
      const downloadButtonSelectors = [
        'button[data-element-name="ycs-booking-list-download"]',
        'button:has-text("Download (.csv)")',
        'div[data-testid="excel-box"] button'
      ];

      let downloadButton = null;
      for (const selector of downloadButtonSelectors) {
         try {
           downloadButton = await newPage.waitForSelector(selector, { visible: true, timeout: 5000 });
           if (downloadButton) {
             await dualLogInfo(`Found download button with selector: ${selector}`);
             break;
           }
         } catch(e) { continue; }
      }

      if (downloadButton) {
        // Set up download listener
        const downloadPath = path.resolve(process.cwd(), 'downloads', jobId || 'temp');
        if (fs.existsSync(downloadPath)) {
            fs.rmSync(downloadPath, { recursive: true, force: true });
        }
        fs.mkdirSync(downloadPath, { recursive: true });

        const client = await newPage.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadPath,
        });

        await downloadButton.click();
        await dualLogInfo("Clicked download button, waiting for file...");

        // Wait for download
        let downloadedFile = null;
        let attempts = 0;
        while (attempts < 30 && !downloadedFile) { // Wait up to 30 seconds
            await delay(1000);
            const files = fs.readdirSync(downloadPath);
            downloadedFile = files.find(f => f.endsWith('.csv'));
            attempts++;
        }

        if (downloadedFile) {
             const originalPath = path.join(downloadPath, downloadedFile);
             
             // Rename file to {jobId}.csv for easier tracking
             let finalFilePath = originalPath;
             if (jobId) {
                 const newFileName = `${jobId}.csv`;
                 const newPath = path.join(downloadPath, newFileName);
                 try {
                     fs.renameSync(originalPath, newPath);
                     finalFilePath = newPath;
                     await dualLogInfo(`Renamed downloaded file to: ${newFileName}`);
                 } catch (renameError) {
                     await dualLogError(`Failed to rename file, using original: ${downloadedFile}`);
                 }
             }

             await dualLogInfo(`Processing downloaded file: ${finalFilePath}`);
             
             // Validate file
             const fileStats = fs.statSync(finalFilePath);
             if (fileStats.size > 0) {
                 // Read and Parse CSV
                 const fileContent = fs.readFileSync(finalFilePath, 'utf-8');
                 // Standardize CSV: Remove Byte Order Mark (BOM) if present (common in Agoda exports)
                 const cleanContent = fileContent.replace(/^\uFEFF/, '');
                 
                 const parsed = Papa.parse(cleanContent, { header: true, skipEmptyLines: true });
                 
                 if (parsed.data && parsed.data.length > 0) {
                     // Map CSV data to CsvRecord format
                     formattedRecords = parsed.data.map((row: any) => ({
                         BookingIDExternal_reference_ID: row['BookingIDExternal_reference_ID'] || row['Booking ID'] || row['Booking ID (External reference ID)'] || '',
                         Status: row['Status'] || '',
                         StayDateFrom: row['StayDateFrom'] || row['Stay Date From'] || row['Check-in date'] || '',
                         StayDateTo: row['StayDateTo'] || row['Stay Date To'] || row['Check-out date'] || '',
                         BookedDate: row['BookedDate'] || row['Booked Date'] || '',
                         Customer_Name: row['Customer_Name'] || row['Customer Name'] || '',
                         RoomType: row['RoomType'] || row['Room Type'] || '',
                         CancellationPolicyDescription: row['CancellationPolicyDescription'] || row['Cancellation Policy'] || ''
                     })).filter((r: any) => r.BookingIDExternal_reference_ID !== ''); // Basic filter
                     
                     if (formattedRecords.length > 0) {
                        downloadSuccess = true;
                        await dualLogInfo(`Successfully loaded ${formattedRecords.length} records from CSV`);
                        
                         // Update progress - Download completed
                        if (jobId) {
                            await progressManager.updateJobProgress(
                            jobId,
                            undefined,
                            90,
                            "agoda_csv_download_completed",
                            undefined
                            );
                        }
                     }
                 }
             }
        } else {
            await dualLogInfo("Download timed out or file verification failed.");
        }
      } else {
         await dualLogInfo("Download button not found in UI.");
      }

    } catch (downloadError: any) {
         await dualLogError("Error during UI download flow (falling back to API):", downloadError.message, { jobId });
         downloadSuccess = false;
    }
    */

    // PRIMARY METHOD: Direct API Fetch (after table loads)
    await dualLogInfo("Fetching booking data directly from API...");

    // Update progress - API call initiated
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        50,
        "agoda_api_call_initiated",
        undefined
      );
    }

    // Fetch booking data from API
    let apiResponse: any;

    try {
      apiResponse = await fetchBookingDataFromAPI(
        newPage,
        agodaId,
        startDate,
        endDate,
        jobId
      );

      // Map API response to CsvRecord format (fetches additional details for each booking)
      // Pass formatted dates (DD-MM-YYYY) for Referer header in API calls
      formattedRecords = await mapApiResponseToCsvRecords(
        apiResponse,
        newPage,
        agodaId,
        formattedStartDate, // DD-MM-YYYY format for Referer header
        formattedEndDate, // DD-MM-YYYY format for Referer header
        jobId
      );

      // Filter out records that don't have a valid BookingIDExternal_reference_ID
      formattedRecords = formattedRecords.filter((record) => {
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
      });

      await dualLogInfo(
        `Successfully fetched ${formattedRecords.length} booking records from API`
      );

      // Update progress - API call completed
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          90,
          "agoda_api_call_completed",
          undefined
        );
      }

      // Take screenshot after API call
      if (jobId) {
        await takeSuccessScreenshot(newPage, jobId, "api_call_completed");
      }
    } catch (apiError: any) {
      await dualLogError(
        "Error fetching booking data from API:",
        apiError.message,
        {
          jobId,
        }
      );

      // Take error screenshot
      if (jobId) {
        await takeErrorScreenshot(newPage, jobId, "api_call_failed");
      }

      throw apiError;
    }

    // Log the data for debugging
    console.log("=== AGODA BOOKING DATA (FROM API) ===");
    console.log(`📊 Total records: ${formattedRecords.length}`);

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
      console.log("⚠️ No records found in API response");
      if (jobId) {
        const failedReason =
          "Agoda API returned 0 reservations (both list request methods tried)";
        await jobService.updateJobStatusWithReason(
          jobId,
          JobStatus.Failed,
          failedReason
        );
        await dualLogError("Job marked as Failed: 0 reservations from API", {
          jobId,
          failedReason,
        });
        throw new Error(failedReason);
      }
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

    await dualLogInfo(
      `Successfully retrieved and processed ${formattedRecords.length} booking records from API`
    );

    // OLD CSV DOWNLOAD CODE REMOVED - Now using API instead
    // The following code was removed:
    // - Download button detection and clicking
    // - File download waiting and standardization
    // - CSV file reading and parsing
    // All replaced with API call above

    // Save API records to database if we have jobId
    if (jobId && formattedRecords.length > 0) {
      try {
        const job = await jobService.getJobById(jobId);
        if (job && job.property_id) {
          const propertyIdForDb = job.property_id.toString();

          await dualLogInfo(
            `Starting database save with property_id: ${propertyIdForDb}`,
            { jobId, propertyIdForDb }
          );

          const saveResult = await saveCsvRecordsToDatabase(
            formattedRecords,
            jobId,
            propertyIdForDb
          );

          await dualLogInfo(
            `Database save completed: ${saveResult.saved} saved, ${saveResult.errors} errors`,
            { jobId, saveResult }
          );

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
                  { jobId }
                );
              }
            } catch (csvExportError: any) {
              await dualLogError(
                `Error during CSV export (continuing with job completion):`,
                csvExportError.message,
                { jobId }
              );
            }
          } else {
            await dualLogInfo(
              `Skipping CSV export - no records were saved to database`,
              { jobId }
            );
          }
        }
      } catch (dbError: any) {
        await dualLogError(
          `Error saving API records to database:`,
          dbError.message,
          { jobId }
        );
        // Don't throw error, just log it - we still want to return the API data
      }
    }

    return formattedRecords;
  } catch (error: any) {
    await dualLogError("Error in getAgodaBookingData:", error.message, {
      jobId,
    });
    throw error;
  } finally {
    // Clean up: close the new page if it was created
    if (newPage) {
      try {
        await newPage.close();
        await dualLogInfo("Closed booking data page", { jobId });
      } catch (closeError) {
        await dualLogError("Error closing page:", closeError, { jobId });
      }
    }
  }
}
