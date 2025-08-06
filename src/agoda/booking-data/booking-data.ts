import { Browser, Page } from "puppeteer";
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeoutManager } from "../../common/timeout-manager.js";

export async function getAgodaBookingData(
  browser: Browser,
  page: Page,
  agodaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<any[]> {
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

    // Construct the booking URL with agoda_id and date range
    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${startDate}&endDate=${endDate}`;
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`);

    // Navigate to the booking data page
    await page.goto(bookingUrl, {
      waitUntil: "networkidle2",
      timeout: loadingTimeout,
    });

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

    // Wait for the page to load completely
    await delay(3000);

    // Check pause state before proceeding
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during booking data retrieval");
      throw new Error("Scraping was stopped during booking data retrieval");
    }

    // Wait for the download button container to be visible
    await dualLogInfo("Looking for CSV download button...");

    try {
      // Wait for the download button using the specific selector from the HTML structure
      await page.waitForSelector(
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
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        50,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Set up download path
    const downloadPath = path.resolve(process.cwd(), "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    // Configure download behavior
    await (page as any)._client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    await dualLogInfo("Download path configured, initiating CSV download...");

    // Click the download button
    try {
      await page.click('button[data-element-name="ycs-booking-list-download"]');
      await dualLogInfo("CSV download button clicked successfully");
    } catch (error: any) {
      await dualLogError("Error clicking CSV download button:", error);
      throw new Error("Failed to click CSV download button");
    }

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        70,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Wait for download to complete
    await dualLogInfo("Waiting for CSV download to complete...");
    await delay(5000);

    // Check pause state during download
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during CSV download");
      throw new Error("Scraping was stopped during CSV download");
    }

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

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        90,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

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
    console.log(`Total records: ${formattedRecords.length}`);
    console.log("First few records:");
    console.log(JSON.stringify(formattedRecords.slice(0, 3), null, 2));

    if (formattedRecords.length > 0) {
      console.log("CSV Columns:", Object.keys(formattedRecords[0]));
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

    // Clean up the downloaded file
    try {
      fs.unlinkSync(csvFilePath);
      await dualLogInfo("Downloaded CSV file cleaned up");
    } catch (cleanupError) {
      await dualLogError("Error cleaning up CSV file:", cleanupError);
    }

    await dualLogInfo(
      `Successfully retrieved and processed ${formattedRecords.length} booking records`
    );
    return formattedRecords;
  } catch (error: any) {
    await dualLogError(`Error retrieving Agoda booking data:`, error);

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
