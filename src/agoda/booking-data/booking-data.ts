import { Browser, Page } from "puppeteer";
import fs from "fs";
import path from "path";
import Papa from "papaparse";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { JobService } from "../../services/job.service.js";
import { IJobItem, PaymentInfo } from "../../models/job-item.model.js";
import { Types } from "mongoose";

// Initialize job service
const jobService = new JobService();

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
    // Only include amount_to_charge_or_refund as it's the only required field
    // Other fields are optional and will be undefined if not provided from CSV
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

    // Log original and converted dates in blue color text
    console.log(
      "\x1b[34m%s\x1b[0m",
      `Original dates - startDate: ${startDate}, endDate: ${endDate}`
    );
    console.log(
      "\x1b[34m%s\x1b[0m",
      `Converted dates - startDate: ${formattedStartDate}, endDate: ${formattedEndDate}`
    );

    // Construct the booking URL with agoda_id and date range using converted dates
    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`);

    // Navigate to the booking data page
    const newPage = await browser.newPage();
    await newPage.goto(bookingUrl, {
      waitUntil: "networkidle2",
      timeout: loadingTimeout,
    });

    await newPage.waitForSelector("body", { timeout: loadingTimeout });

    await dualLogInfo("Successfully navigated to booking data page");

    // Update progress
    // if (jobId) {
    //   await progressManager.updateJobProgress(
    //     jobId,
    //     undefined,
    //     30,
    //     "agoda_booking_data_retrieval",
    //     undefined
    //   );
    // }

    // Wait for the page to load completely
    await delay(5000);

    // Check pause state before proceeding
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during booking data retrieval");
    //   throw new Error("Scraping was stopped during booking data retrieval");
    // }

    // Wait for the download button container to be visible
    await dualLogInfo("Looking for CSV download button...");

    try {
      // Wait for the download button using the specific selector from the HTML structure
      await newPage.waitForSelector(
        'button[data-element-name="ycs-booking-list-download"]',
        {
          visible: true,
          timeout: selectorTimeout,
        }
      );

      await dualLogInfo("CSV download button found");
    } catch (error: any) {
      await dualLogError("Error waiting for CSV download button:", error);
      throw new Error("CSV download button not found on the page");
    }

    // Update progress
    // if (jobId) {
    //   await progressManager.updateJobProgress(
    //     jobId,
    //     undefined,
    //     50,
    //     "agoda_booking_data_retrieval",
    //     undefined
    //   );
    // }

    // Set up download path
    const downloadPath = path.resolve(process.cwd(), "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    // Configure download behavior using CDP session
    client = await newPage.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    await dualLogInfo("Download path configured, initiating CSV download...");

    // Click the download button
    try {
      await newPage.click(
        'button[data-element-name="ycs-booking-list-download"]'
      );
      console.log("👆 Clicked the download CSV button");
      await dualLogInfo("CSV download button clicked successfully");
    } catch (error: any) {
      await dualLogError("Error clicking CSV download button:", error);
      throw new Error("Failed to click CSV download button");
    }

    // Update progress
    // if (jobId) {
    //   await progressManager.updateJobProgress(
    //     jobId,
    //     undefined,
    //     70,
    //     "agoda_booking_data_retrieval",
    //     undefined
    //   );
    // }

    // Wait for download to complete
    await dualLogInfo("Waiting for CSV download to complete...");
    await delay(5000);

    // Check pause state during download
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during CSV download");
    //   throw new Error("Scraping was stopped during CSV download");
    // }

    // Find the downloaded CSV file
    let csvFilePath: string | null = null;
    const maxWaitTime = 30000; // 30 seconds max wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const files = fs.readdirSync(downloadPath);
      const csvFile = files.find(
        (file) => file.endsWith(".csv") && !file.endsWith(".crdownload")
      );

      if (csvFile) {
        csvFilePath = path.join(downloadPath, csvFile);
        await dualLogInfo(`CSV file found: ${csvFile}`);
        break;
      }

      await delay(1000);
    }

    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
      throw new Error("CSV file not found after download");
    }

    // Get file size for logging
    const fileStats = fs.statSync(csvFilePath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    await dualLogInfo(`CSV file size: ${fileSizeKB} KB`);

    // Update progress
    // if (jobId) {
    //   await progressManager.updateJobProgress(
    //     jobId,
    //     undefined,
    //     90,
    //     "agoda_booking_data_retrieval",
    //     undefined
    //   );
    // }

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

    // Update progress with error
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
