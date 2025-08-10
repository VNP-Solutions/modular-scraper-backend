import fs from "fs";
import Papa from "papaparse";
import path from "path";
import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { PaymentInfo } from "../../models/job-item.model.js";
import { JobService } from "../../services/job.service.js";

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

/**
 * Interacts with Agoda support chat widget after CSV export
 */
async function interactWithSupportChat(
  page: Page,
  jobId: string
): Promise<void> {
  try {
    await dualLogInfo("Starting support chat interaction...", { jobId });

    // Step 1: Click "Need Help" button
    await dualLogInfo("Looking for 'Need Help' button...", { jobId });

    const needHelpSelectors = [
      'button[data-testid="partner-support-suggestion-get-help-button"]',
      'button:has-text("Need Help")',
      'div[id="partner-support-suggestion-card"] button',
    ];

    let needHelpFound = false;
    for (const selector of needHelpSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 10000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Need Help' button with selector: ${selector}`,
          { jobId }
        );
        needHelpFound = true;
        break;
      } catch (error) {
        await dualLogInfo(`Selector failed for Need Help: ${selector}`, {
          jobId,
        });
        continue;
      }
    }

    if (!needHelpFound) {
      await dualLogError("Need Help button not found", { jobId });
      return;
    }

    // Wait for chat widget to appear
    await delay(3000);

    // Step 2: Click "Payments/Fees" button
    await dualLogInfo("Looking for 'Payments/Fees' button...", { jobId });

    const paymentsFeesSelectors = [
      'button[data-element-value="Payments/Fees"]',
      'button[data-element-name="chat-widget-suggestion-item"][data-element-value="Payments/Fees"]',
      'button:has-text("Payments/Fees")',
    ];

    let paymentsFeesFound = false;
    for (const selector of paymentsFeesSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Payments/Fees' button with selector: ${selector}`,
          { jobId }
        );
        paymentsFeesFound = true;
        break;
      } catch (error) {
        await dualLogInfo(`Selector failed for Payments/Fees: ${selector}`, {
          jobId,
        });
        continue;
      }
    }

    if (!paymentsFeesFound) {
      await dualLogError("Payments/Fees button not found", { jobId });
      return;
    }

    // Wait for sub-options to appear
    await delay(3000);

    // Step 3: Click "Change payment method" button
    await dualLogInfo("Looking for 'Change payment method' button...", {
      jobId,
    });

    const changePaymentSelectors = [
      'button[data-element-value="Change payment method"]',
      'button[data-element-name="chat-widget-suggestion-item"][data-element-value="Change payment method"]',
      'button:has-text("Change payment method")',
    ];

    let changePaymentFound = false;
    for (const selector of changePaymentSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Change payment method' button with selector: ${selector}`,
          { jobId }
        );
        changePaymentFound = true;
        break;
      } catch (error) {
        await dualLogInfo(
          `Selector failed for Change payment method: ${selector}`,
          { jobId }
        );
        continue;
      }
    }

    if (!changePaymentFound) {
      await dualLogError("Change payment method button not found", { jobId });
      return;
    }

    // Step 4: Click "Submit request" button
    await delay(3000); // Wait for options to appear
    await dualLogInfo("Looking for 'Submit request' button...", { jobId });

    const submitRequestSelectors = [
      'button[data-element-value="Submit request"]',
      'button[data-element-name="chat-widget-suggestion-item"][data-element-value="Submit request"]',
      'button:has-text("Submit request")',
    ];

    let submitRequestFound = false;
    for (const selector of submitRequestSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 15000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Submit request' button with selector: ${selector}`,
          { jobId }
        );
        submitRequestFound = true;
        break;
      } catch (error) {
        await dualLogInfo(`Selector failed for Submit request: ${selector}`, {
          jobId,
        });
        continue;
      }
    }

    if (!submitRequestFound) {
      await dualLogError("Submit request button not found", { jobId });
      return;
    }

    // Wait for form to appear
    await delay(5000);

    // Step 5: Select "Other" from issue type dropdown
    await dualLogInfo("Looking for issue type dropdown...", { jobId });

    try {
      // Click on the dropdown to open it
      const dropdownSelectors = [
        'button[data-element-name="dropdown"]',
        'button[aria-haspopup="listbox"]',
      ];

      let dropdownClicked = false;
      for (const selector of dropdownSelectors) {
        try {
          await page.waitForSelector(selector, {
            visible: true,
            timeout: 10000,
          });
          await page.click(selector);
          await dualLogInfo(`✅ Clicked dropdown with selector: ${selector}`, {
            jobId,
          });
          dropdownClicked = true;
          break;
        } catch (error) {
          continue;
        }
      }

      if (dropdownClicked) {
        await delay(2000); // Wait for dropdown options to appear

        // Log available options for debugging
        await page.evaluate(() => {
          const options = document.querySelectorAll("li span");
          console.log("Available dropdown options:");
          options.forEach((option, index) => {
            console.log(`${index + 1}: ${option.textContent}`);
          });
        });

        // First check if "Other" is already selected
        const isOtherAlreadySelected = await page.evaluate(() => {
          // Look for radio button with "Other" text that is checked
          const radios = document.querySelectorAll('input[type="radio"]');
          for (const radio of radios) {
            const label = radio.closest("label") || radio.closest("li");
            if (
              label &&
              label.textContent?.includes("Other") &&
              (radio as HTMLInputElement).checked
            ) {
              return true;
            }
          }
          return false;
        });

        if (isOtherAlreadySelected) {
          await dualLogInfo("✅ 'Other' option is already selected", { jobId });
        } else {
          await dualLogInfo("Selecting 'Other' option...", { jobId });

          // Select "Other" option with more robust selectors
          const otherSelectors = [
            // Most specific: target the exact structure from your HTML
            "li:last-child label", // "Other" is the last item in the list
            'span:has-text("Other")',
            'label:has-text("Other")',
            // Target the radio input directly
            'input[type="radio"][aria-selected="false"] + div + div + div span:has-text("Other")',
            // Try clicking the entire label container
            'li:has(span:has-text("Other")) label',
            'div:has(span:has-text("Other"))',
            // Fallback patterns
            '[role="option"]:has(span:has-text("Other"))',
            'li:contains("Other") label',
          ];

          let otherSelected = false;
          for (const selector of otherSelectors) {
            try {
              await page.waitForSelector(selector, {
                visible: true,
                timeout: 5000,
              });
              await page.click(selector);
              await dualLogInfo(
                `✅ Selected 'Other' option with selector: ${selector}`,
                { jobId }
              );
              otherSelected = true;
              break;
            } catch (error) {
              await dualLogInfo(`Failed with selector: ${selector}`, { jobId });
              continue;
            }
          }

          if (!otherSelected) {
            // Final fallback: try to select the last radio option
            await dualLogInfo(
              "Trying fallback: selecting last radio option...",
              { jobId }
            );
            try {
              await page.evaluate(() => {
                const radios = document.querySelectorAll('input[type="radio"]');
                const lastRadio = radios[radios.length - 1] as HTMLInputElement;
                if (lastRadio) {
                  lastRadio.click();
                  return true;
                }
                return false;
              });
              await dualLogInfo(
                "✅ Selected last radio option (should be 'Other')",
                { jobId }
              );
            } catch (error) {
              await dualLogError(
                "Failed to select 'Other' option with any method",
                { jobId }
              );
            }
          }
        }

        // Click outside to close dropdown
        await page.click("body");
        await delay(1000);
      }
    } catch (error: any) {
      await dualLogError("Error handling issue type dropdown:", error.message, {
        jobId,
      });
    }

    // Step 6: Fill in the issue details textarea with message content
    await dualLogInfo("Filling issue details...", { jobId });

    const messageContent = `Dear Agoda Team,

Thank you in advance for your continued support and cooperation.

We are currently reviewing the Agoda transactions for the attached property. In accordance with the new guidelines provided by Agoda, we have followed all the required steps. During this process, we identified certain reservations where the full booking amount has not yet been collected.

We have attempted to charge the remaining amounts as per our Accounts Receivable report; however, the VCCs are being declined. We kindly request that you reissue the VCCs for the outstanding amounts reflected in our report so we can reconcile these balances accordingly.

We would greatly appreciate your assistance in providing the remaining amounts.

Best regards,
Revenue Control Team`;

    try {
      const issueDetailsSelectors = [
        'textarea[data-testid="issueDetails-field"]',
        'textarea[name="issueDetails"]',
      ];

      for (const selector of issueDetailsSelectors) {
        try {
          await page.waitForSelector(selector, {
            visible: true,
            timeout: 10000,
          });
          await page.focus(selector);
          await page.evaluate((sel) => {
            const textarea = document.querySelector(sel) as HTMLTextAreaElement;
            if (textarea) textarea.value = "";
          }, selector);
          await page.type(selector, messageContent);
          await dualLogInfo(
            `✅ Filled issue details with selector: ${selector}`,
            { jobId }
          );
          break;
        } catch (error) {
          continue;
        }
      }
    } catch (error: any) {
      await dualLogError("Error filling issue details:", error.message, {
        jobId,
      });
    }

    // Step 7: Upload CSV file from import folder
    await dualLogInfo("Uploading CSV file attachment...", { jobId });

    try {
      // Get the CSV file path from import folder
      const importDir = path.resolve(process.cwd(), "import");
      const files = fs.readdirSync(importDir);

      // Find the CSV file that matches the pattern: property-name-agoda-id.csv
      const csvFile = files.find(
        (file) =>
          file.endsWith(".csv") &&
          !file.includes(".gitkeep") &&
          file.includes("-") // Should contain property name and agoda id separated by dash
      );

      if (csvFile) {
        const csvFilePath = path.join(importDir, csvFile);
        await dualLogInfo(`Found CSV file to upload: ${csvFile}`, { jobId });

        // Find the file input element and upload the file
        const fileInputSelectors = [
          'input[data-testid="attachments-field"]',
          'input[type="file"]',
          'input[multiple][accept*="image"]',
        ];

        for (const selector of fileInputSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 10000 });

            // Upload the file
            const fileInput = (await page.$(selector)) as any;
            if (fileInput) {
              await fileInput.uploadFile(csvFilePath);
              await dualLogInfo(
                `✅ Uploaded CSV file: ${csvFile} with selector: ${selector}`,
                { jobId }
              );

              // Wait for upload to process
              await delay(3000);
              break;
            }
          } catch (error) {
            continue;
          }
        }
      } else {
        await dualLogError("No CSV file found in import folder to upload", {
          jobId,
        });
      }
    } catch (error: any) {
      await dualLogError("Error uploading CSV file:", error.message, {
        jobId,
      });
    }

    // Step 8: Fill in the phone number
    await dualLogInfo("Filling phone number...", { jobId });

    try {
      const phoneSelectors = [
        'input[data-testid="phone-field"]',
        'input[name="phone"]',
      ];

      for (const selector of phoneSelectors) {
        try {
          await page.waitForSelector(selector, {
            visible: true,
            timeout: 10000,
          });
          await page.focus(selector);
          await page.evaluate((sel) => {
            const input = document.querySelector(sel) as HTMLInputElement;
            if (input) input.value = "";
          }, selector);
          await page.type(selector, "6478600408");
          await dualLogInfo(
            `✅ Filled phone number with selector: ${selector}`,
            { jobId }
          );
          break;
        } catch (error) {
          continue;
        }
      }
    } catch (error: any) {
      await dualLogError("Error filling phone number:", error.message, {
        jobId,
      });
    }

    await dualLogInfo("✅ Support chat form completed successfully", {
      jobId,
    });

    // Give some time for all form inputs to be processed
    await delay(2000);
  } catch (error: any) {
    await dualLogError(
      "Error during support chat interaction:",
      error.message,
      { jobId }
    );
    // Don't throw error - this shouldn't fail the main process
  }
}

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

    // Set up download path with platform-specific considerations
    const downloadPath = path.resolve(process.cwd(), "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    await dualLogInfo(
      `Download configuration - Platform: ${process.platform}, Path: ${downloadPath}`,
      { jobId, platform: process.platform, downloadPath }
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
    const downloadButtonSelectors = [
      'button[data-element-name="ycs-booking-list-download"]',
      'button[leadingicon="fill.arrow.download"]',
      'button:has-text("Download (.csv)")',
      'button:has([role="img"]) span:has-text("Download")',
    ];

    let buttonFound = false;
    let usedSelector = "";

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

    if (!buttonFound) {
      throw new Error("Download button not found with any selector");
    }

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
        }
      }, usedSelector);

      await dualLogInfo("Multiple click methods executed");

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
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during CSV download");
    //   throw new Error("Scraping was stopped during CSV download");
    // }

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
                  `Starting support chat interaction after CSV export`,
                  { jobId, propertyIdForDb }
                );

                await interactWithSupportChat(newPage, jobId);

                await dualLogInfo(`Support chat interaction completed`, {
                  jobId,
                  propertyIdForDb,
                });
              } catch (chatError: any) {
                await dualLogError(
                  `Error during support chat interaction (continuing with job completion):`,
                  chatError.message,
                  { jobId, propertyIdForDb }
                );
                // Don't throw error - chat interaction failure shouldn't fail the main job
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
