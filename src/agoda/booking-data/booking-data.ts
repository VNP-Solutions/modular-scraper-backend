import { Browser, Page } from "puppeteer";
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeoutManager } from "../../common/timeout-manager.js";

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
    await delay(loadingTimeout);

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

    // Read the file as a workbook using XLSX
    const workbook = XLSX.readFile(csvFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON with header row as keys
    const records = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
    });

    // Convert array of arrays to array of objects with proper headers
    const headers = records[0] as string[];
    const dataRows = records.slice(1) as any[][];

    const formattedRecords = dataRows
      .map((row) => {
        const obj: any = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] || "";
        });
        return obj;
      })
      .filter((record) => Object.values(record).some((value) => value !== ""));

    await dualLogInfo(
      `Successfully parsed CSV file with ${formattedRecords.length} records`
    );

    // Console log the data for debugging
    console.log("=== AGODA BOOKING DATA ===");
    console.log(`📊 Total records: ${formattedRecords.length}`);
    console.log(`📁 CSV file path: ${csvFilePath}`);
    console.log(`💾 File size: ${fileSizeKB} KB`);
    console.log(`📄 Raw headers count: ${headers.length}`);

    if (formattedRecords.length > 0) {
      console.log("📋 CSV Columns:", Object.keys(formattedRecords[0]));
      console.log("📝 First few records:");
      console.log(JSON.stringify(formattedRecords.slice(0, 3), null, 2));

      // Log sample of different types of data
      const sampleRecord = formattedRecords[0];
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
