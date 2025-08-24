import fs from "fs";
import path from "path";
import { Page } from "puppeteer";
import {
  autoDetectCleanupParams,
  cleanupFoldersOnError,
} from "../../common/folder-cleanup.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { timeManager } from "../../common/time-manager.js";
import { JobService } from "../../services/job.service.js";

// Initialize job service
const jobService = new JobService();

/**
 * Options for the Need Help automation process
 */
export interface NeedHelpOptions {
  csvFilePath?: string; // Path to CSV file to upload
  csvFileName?: string; // Name of CSV file (if path not provided, searches import folder)
  phoneNumber?: string; // Phone number to fill (default: 6478600408)
  messageFilePath?: string; // Custom message file path (default: uses message.txt)
  customMessage?: string; // Custom message text (overrides file)
  jobId?: string; // Optional job ID for logging
  skipFileUpload?: boolean; // Skip file upload step
  issueType?: string; // Issue type selection (default: "Other")
  cleanupAfter?: boolean; // Auto cleanup CSV files after process (default: false)
  agodaId?: string; // Agoda ID for cleanup (auto-detected if not provided)
  propertyName?: string; // Property name for cleanup (auto-detected if not provided)
}

/**
 * Delay helper function
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find CSV file in import folder
 */
async function findCsvFileInImport(): Promise<string | null> {
  try {
    const importDir = path.resolve(process.cwd(), "import");

    if (!fs.existsSync(importDir)) {
      await dualLogError("Import directory not found");
      return null;
    }

    const files = fs.readdirSync(importDir);
    const csvFile = files.find(
      (file) =>
        file.endsWith(".csv") &&
        !file.includes(".gitkeep") &&
        file.includes("-") // Should contain property name and agoda id
    );

    if (csvFile) {
      return path.join(importDir, csvFile);
    }

    return null;
  } catch (error) {
    await dualLogError("Error finding CSV file in import folder:", error);
    return null;
  }
}

/**
 * Load message content from file
 */
async function loadMessageContent(messageFilePath?: string): Promise<string> {
  try {
    const defaultMessagePath = path.join(
      process.cwd(),
      "src",
      "agoda",
      "need-help",
      "message.txt"
    );
    const filePath = messageFilePath || defaultMessagePath;

    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    } else {
      // Fallback message if file not found
      return `Dear Agoda Team,

Thank you in advance for your continued support and cooperation.

We are currently reviewing the Agoda transactions for the attached property. In accordance with the new guidelines provided by Agoda, we have followed all the required steps. During this process, we identified certain reservations where the full booking amount has not yet been collected.

We have attempted to charge the remaining amounts as per our Accounts Receivable report; however, the VCCs are being declined. We kindly request that you reissue the VCCs for the outstanding amounts reflected in our report so we can reconcile these balances accordingly.

We would greatly appreciate your assistance in providing the remaining amounts.

Best regards,
Revenue Control Team`;
    }
  } catch (error: any) {
    await dualLogError(
      "Error loading message content:",
      error.message || error
    );
    await dualLogInfo(
      `Attempted to load message from: ${
        messageFilePath ||
        path.join(process.cwd(), "src", "agoda", "need-help", "message.txt")
      }`
    );
    // Return fallback message
    return `Dear Agoda Team,

Thank you in advance for your continued support and cooperation.

We are currently reviewing the Agoda transactions for the attached property. In accordance with the new guidelines provided by Agoda, we have followed all the required steps. During this process, we identified certain reservations where the full booking amount has not yet been collected.

We have attempted to charge the remaining amounts as per our Accounts Receivable report; however, the VCCs are being declined. We kindly request that you reissue the VCCs for the outstanding amounts reflected in our report so we can reconcile these balances accordingly.

We would greatly appreciate your assistance in providing the remaining amounts.

Best regards,
Revenue Control Team`;
  }
}

/**
 * Main function: Automate the complete Need Help process
 */
export async function automateNeedHelpProcess(
  page: Page,
  options: NeedHelpOptions = {}
): Promise<void> {
  const {
    csvFilePath,
    csvFileName,
    phoneNumber = "6478600408",
    messageFilePath,
    customMessage,
    jobId,
    skipFileUpload = false,
    issueType = "Other",
    cleanupAfter = false,
    agodaId,
    propertyName,
  } = options;

  try {
    await dualLogInfo("🚀 Starting Need Help automation process...", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Update progress - Need Help process started
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        95,
        "agoda_need_help_process_started",
        undefined
      );
    }

    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during Need Help automation");
      throw new Error("Scraping was stopped during Need Help automation");
    }

    // Step 1: Click "Need Help" button
    await dualLogInfo("Looking for 'Need Help' button...", { jobId });
    const needHelpSelectors = [
      'button[data-testid="partner-support-suggestion-get-help-button"]',
      'button:has-text("Need Help")',
      'button[data-element-name*="get-help"]',
    ];

    for (const selector of needHelpSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 10000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Need Help' button with selector: ${selector}`,
          { jobId }
        );

        // Update progress - Need Help button clicked
        if (jobId) {
          await progressManager.updateJobProgress(
            jobId,
            undefined,
            96,
            "agoda_need_help_button_clicked",
            undefined
          );
        }
        break;
      } catch (error) {
        continue;
      }
    }

    // Step 2: Wait for sidebar to load and handle chat input
    await delay(3000);
    await dualLogInfo("Waiting for chat sidebar to load...", { jobId });

    try {
      // Wait for the chat input field to be available
      const chatInputSelectors = [
        'fieldset[data-testid="ChatWidgetInputFieldset"]',
        'div[class*="IRISCwMessenger__Bottomm"] fieldset',
        'fieldset[class*="a9c57-border"]',
      ];

      let chatInputFound = false;
      for (const selector of chatInputSelectors) {
        try {
          await page.waitForSelector(selector, {
            visible: true,
            timeout: 15000,
          });
          await dualLogInfo(
            `✅ Chat input field found with selector: ${selector}`,
            { jobId }
          );
          chatInputFound = true;
          break;
        } catch (error) {
          continue;
        }
      }

      if (chatInputFound) {
        // Wait a bit more for the input to be fully interactive
        await delay(2000);

        // Type "contact agoda" in the input field
        await dualLogInfo("Typing 'contact agoda' in chat input...", { jobId });

        const inputFieldSelectors = [
          'fieldset[data-testid="ChatWidgetInputFieldset"]',
          'div[class*="IRISCwMessenger__Bottomm"] fieldset',
        ];

        for (const selector of inputFieldSelectors) {
          try {
            await page.click(selector);
            await page.type(selector, "contact agoda");
            await dualLogInfo(
              `✅ Typed 'contact agoda' with selector: ${selector}`,
              { jobId }
            );
            break;
          } catch (error) {
            continue;
          }
        }

        // Wait a moment for the send button to become enabled
        await delay(1000);

        // Click the send button (right side button)
        await dualLogInfo("Looking for send button...", { jobId });
        const sendButtonSelectors = [
          'button[leadingicon="fill.symbol.send"]',
          'button[class*="a9c57-bg-generic-base-transparent"]:has(svg[role="img"])',
          'div[class*="IRISCwMessenger__Bottomm"] button:last-child',
        ];

        for (const selector of sendButtonSelectors) {
          try {
            await page.waitForSelector(selector, {
              visible: true,
              timeout: 10000,
            });
            await page.click(selector);
            await dualLogInfo(
              `✅ Clicked send button with selector: ${selector}`,
              { jobId }
            );

            // Update progress - Chat message sent
            if (jobId) {
              await progressManager.updateJobProgress(
                jobId,
                undefined,
                96.5,
                "agoda_chat_message_sent",
                undefined
              );
            }
            break;
          } catch (error) {
            continue;
          }
        }

        // Wait for the chat response to load
        await delay(3000);
      } else {
        await dualLogError(
          "Chat input field not found after clicking Need Help",
          { jobId }
        );
      }
    } catch (error: any) {
      await dualLogError("Error handling chat input:", error.message, {
        jobId,
      });
    }

    // Step 4: Click "Submit request" button
    await delay(3000);
    await dualLogInfo("Looking for 'Submit request' button...", { jobId });
    const submitRequestSelectors = [
      'button[data-element-value="Submit request"]',
      'button[data-testid="suggestion-text-button"][data-element-value="Submit request"]',
      'button:has-text("Submit request")',
    ];

    for (const selector of submitRequestSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 10000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Submit request' button with selector: ${selector}`,
          { jobId }
        );

        // Update progress - Submit request button clicked
        if (jobId) {
          await progressManager.updateJobProgress(
            jobId,
            undefined,
            97,
            "agoda_submit_request_clicked",
            undefined
          );
        }
        break;
      } catch (error) {
        continue;
      }
    }

    // Step 5: Wait for form to load and select "Other" from issue type dropdown
    await delay(5000);

    // Check if scraping is paused before form handling
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during form handling");
      throw new Error("Scraping was stopped during form handling");
    }

    await dualLogInfo("Looking for issue type dropdown...", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

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

          // Select "Other" option with robust selectors
          const otherSelectors = [
            "li:last-child label", // "Other" is the last item in the list
            'span:has-text("Other")',
            'label:has-text("Other")',
            'li:has(span:has-text("Other")) label',
            'div:has(span:has-text("Other"))',
            '[role="option"]:has(span:has-text("Other"))',
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
            } catch (error: any) {
              await dualLogError(
                "Failed to select 'Other' option with any method",
                error.message,
                { jobId }
              );
            }
          }
        }

        // Close dropdown by clicking the same selector that opened it
        for (const selector of dropdownSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              await page.click(selector);
              await dualLogInfo(
                `✅ Closed dropdown with selector: ${selector}`,
                {
                  jobId,
                }
              );
              break;
            }
          } catch (error) {
            continue;
          }
        }
        await delay(1000);
      }
    } catch (error: any) {
      await dualLogError("Error handling issue type dropdown:", error.message, {
        jobId,
      });
    }

    // Step 6: Fill issue details with message content
    await dualLogInfo("Filling issue details...", { jobId });
    try {
      let messageContent = customMessage;
      if (!messageContent) {
        messageContent = await loadMessageContent(messageFilePath);
      }

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

          // Update progress - Issue details filled
          if (jobId) {
            await progressManager.updateJobProgress(
              jobId,
              undefined,
              98,
              "agoda_issue_details_filled",
              undefined
            );
          }
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
    if (!skipFileUpload) {
      // Check if scraping is paused before file upload
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during file upload");
        throw new Error("Scraping was stopped during file upload");
      }

      await dualLogInfo("Uploading CSV file attachment...", {
        jobId,
        timeSession: timeManager.getSessionInfo(),
      });
      try {
        const csvFilePathToUpload =
          csvFilePath || (await findCsvFileInImport());
        if (csvFilePathToUpload) {
          const fileInputSelectors = [
            'input[data-testid="attachments-field"]',
            'input[type="file"]',
            'input[multiple][accept*="image"]',
          ];

          for (const selector of fileInputSelectors) {
            try {
              await page.waitForSelector(selector, { timeout: 10000 });
              const fileInput = (await page.$(selector)) as any;
              if (fileInput) {
                await fileInput.uploadFile(csvFilePathToUpload);
                await dualLogInfo(
                  `✅ Uploaded CSV file: ${csvFilePathToUpload} with selector: ${selector}`,
                  { jobId }
                );

                // Update progress - CSV file uploaded
                if (jobId) {
                  await progressManager.updateJobProgress(
                    jobId,
                    undefined,
                    99,
                    "agoda_csv_file_uploaded",
                    undefined
                  );
                }
                await delay(3000); // Wait for upload to process
                break;
              }
            } catch (error) {
              continue;
            }
          }
        } else {
          await dualLogError("No CSV file found to upload", { jobId });
        }
      } catch (error: any) {
        await dualLogError("Error uploading CSV file:", error.message, {
          jobId,
        });
      }
    }

    // Step 8: Fill phone number
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
          await page.type(selector, phoneNumber);
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

    // Step 9: Click final submit button
    // await dualLogInfo("Clicking final submit button...", { jobId });
    // try {
    //   const finalSubmitSelectors = [
    //     'button[data-testid="submit-button"]',
    //     'button[type="submit"]',
    //     'button:has-text("Submit")',
    //   ];

    //   for (const selector of finalSubmitSelectors) {
    //     try {
    //       await page.waitForSelector(selector, {
    //         visible: true,
    //         timeout: 10000,
    //       });
    //       await page.click(selector);
    //       await dualLogInfo(
    //         `✅ Clicked final submit button with selector: ${selector}`,
    //         { jobId }
    //       );
    //       break;
    //     } catch (error) {
    //       continue;
    //     }
    //   }
    // } catch (error: any) {
    //   await dualLogError("Error clicking final submit button:", error.message, {
    //     jobId,
    //   });
    // }

    await delay(2000); // Give time for form submission to process

    // Update progress - Need Help process completed
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        100,
        "agoda_need_help_process_completed",
        undefined
      );
    }

    await dualLogInfo(
      "✅ Need Help automation process completed successfully",
      {
        jobId,
        timeSession: timeManager.getSessionInfo(),
      }
    );

    // Cleanup CSV files if requested
    if (cleanupAfter) {
      const cleanupInfo = await extractCleanupInfo(csvFilePath, jobId);
      const finalAgodaId = agodaId || cleanupInfo.agodaId;
      const finalPropertyName = propertyName || cleanupInfo.propertyName;

      await cleanupCsvFiles(finalAgodaId, finalPropertyName, jobId);
    }
  } catch (error: any) {
    await dualLogError(
      "❌ Need Help automation process failed:",
      error.message,
      {
        jobId,
        timeSession: timeManager.getSessionInfo(),
      }
    );

    // Cleanup folders on Need Help error
    try {
      await dualLogInfo("Starting folder cleanup due to Need Help error", {
        jobId,
        agodaId,
        propertyName,
        timeSession: timeManager.getSessionInfo(),
      });

      // Try to auto-detect cleanup parameters if not provided
      const cleanupParams = await autoDetectCleanupParams(jobId);
      const finalAgodaId = agodaId || cleanupParams.agodaId;
      const finalPropertyName = propertyName || cleanupParams.propertyName;

      const cleanupResult = await cleanupFoldersOnError(
        finalAgodaId,
        finalPropertyName,
        jobId
      );

      await dualLogInfo("Folder cleanup completed after Need Help error", {
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

    // Update progress with error for Need Help process
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        undefined,
        "agoda_need_help_process_error",
        undefined
      );
    }

    throw error;
  }
}

/**
 * Clean up CSV files after Need Help process
 */
async function cleanupCsvFiles(
  agodaId?: string,
  propertyName?: string,
  jobId?: string
): Promise<void> {
  try {
    await dualLogInfo("🧹 Starting CSV cleanup process...", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Clean up downloads folder - look for agodaId_*.csv pattern
    if (agodaId) {
      const downloadsDir = path.resolve(process.cwd(), "downloads");
      if (fs.existsSync(downloadsDir)) {
        const downloadFiles = fs.readdirSync(downloadsDir);
        const downloadCsvPattern = new RegExp(`^${agodaId}_.*\\.csv$`, "i");

        for (const file of downloadFiles) {
          if (downloadCsvPattern.test(file)) {
            const filePath = path.join(downloadsDir, file);
            try {
              fs.unlinkSync(filePath);
              await dualLogInfo(`✅ Deleted download file: ${file}`, { jobId });
            } catch (error) {
              await dualLogError(
                `Failed to delete download file: ${file}`,
                error,
                { jobId }
              );
            }
          }
        }
      }
    }

    // Clean up import folder - look for property-name-agoda-id.csv pattern
    const importDir = path.resolve(process.cwd(), "import");
    if (fs.existsSync(importDir)) {
      const importFiles = fs.readdirSync(importDir);

      for (const file of importFiles) {
        if (file.endsWith(".csv") && !file.includes(".gitkeep")) {
          // Check if it's a property-agoda-id.csv format
          if (agodaId && file.includes(agodaId)) {
            const filePath = path.join(importDir, file);
            try {
              fs.unlinkSync(filePath);
              await dualLogInfo(`✅ Deleted import file: ${file}`, { jobId });
            } catch (error) {
              await dualLogError(
                `Failed to delete import file: ${file}`,
                error,
                { jobId }
              );
            }
          }
        }
      }
    }

    await dualLogInfo("✅ CSV cleanup process completed", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });
  } catch (error) {
    await dualLogError("Error during CSV cleanup:", error, { jobId });
  }
}

/**
 * Get Agoda ID and Property Name from various sources
 */
async function extractCleanupInfo(
  csvFilePath?: string,
  jobId?: string
): Promise<{ agodaId?: string; propertyName?: string }> {
  try {
    if (csvFilePath) {
      const fileName = path.basename(csvFilePath, ".csv");

      // Try to extract from import file format: property-name-agoda-id.csv
      const parts = fileName.split("-");
      if (parts.length >= 2) {
        const agodaId = parts[parts.length - 1]; // Last part should be agoda ID
        const propertyName = parts.slice(0, -1).join("-"); // Everything before last part

        return { agodaId, propertyName };
      }
    }

    // Alternative: try to find any CSV in import folder and extract info
    const importDir = path.resolve(process.cwd(), "import");
    if (fs.existsSync(importDir)) {
      const files = fs.readdirSync(importDir);
      const csvFile = files.find(
        (file) =>
          file.endsWith(".csv") &&
          !file.includes(".gitkeep") &&
          file.includes("-")
      );

      if (csvFile) {
        const fileName = path.basename(csvFile, ".csv");
        const parts = fileName.split("-");
        if (parts.length >= 2) {
          const agodaId = parts[parts.length - 1];
          const propertyName = parts.slice(0, -1).join("-");

          return { agodaId, propertyName };
        }
      }
    }

    return {};
  } catch (error) {
    await dualLogError("Error extracting cleanup info:", error, { jobId });
    return {};
  }
}

/**
 * Quick helper: Automate Need Help with CSV from import folder
 */
export async function quickNeedHelp(page: Page, jobId?: string): Promise<void> {
  return automateNeedHelpProcess(page, { jobId });
}

/**
 * Quick helper: Automate Need Help with cleanup enabled
 */
export async function quickNeedHelpWithCleanup(
  page: Page,
  jobId?: string
): Promise<void> {
  return automateNeedHelpProcess(page, { jobId, cleanupAfter: true });
}

/**
 * Complete Need Help automation with cleanup
 */
export async function automateNeedHelpWithCleanup(
  page: Page,
  options: NeedHelpOptions = {}
): Promise<void> {
  try {
    // Run the Need Help process
    await automateNeedHelpProcess(page, options);

    // Update case_open field for the job (not job items) before cleanup
    if (options.jobId) {
      try {
        await dualLogInfo("🔄 Updating case_open field for job...", {
          jobId: options.jobId,
          timeSession: timeManager.getSessionInfo(),
        });

        const updateResult = await jobService.updateJobCaseOpen(
          options.jobId,
          true
        );

        await dualLogInfo(
          `✅ Updated case_open to true for job ${
            updateResult?._id || options.jobId
          }`,
          {
            jobId: options.jobId,
            timeSession: timeManager.getSessionInfo(),
          }
        );
      } catch (caseOpenError: any) {
        await dualLogError(
          "❌ Error updating case_open field (continuing with cleanup):",
          caseOpenError.message,
          { jobId: options.jobId }
        );
        // Don't throw error - continue with cleanup even if case_open update fails
      }
    } else {
      await dualLogInfo(
        "⚠️ No jobId provided - skipping case_open field update",
        { timeSession: timeManager.getSessionInfo() }
      );
    }

    // Extract cleanup information
    const { agodaId, propertyName } = await extractCleanupInfo(
      options.csvFilePath,
      options.jobId
    );

    // Clean up CSV files
    await cleanupCsvFiles(agodaId, propertyName, options.jobId);
  } catch (error: any) {
    await dualLogError(
      "❌ Need Help automation with cleanup failed:",
      error.message,
      { jobId: options.jobId }
    );

    // Emergency cleanup on complete failure
    try {
      await dualLogInfo(
        "Starting emergency folder cleanup due to complete failure",
        {
          jobId: options.jobId,
          timeSession: timeManager.getSessionInfo(),
        }
      );

      // Try to auto-detect cleanup parameters if not provided
      const cleanupParams = await autoDetectCleanupParams(options.jobId);
      const finalAgodaId = options.agodaId || cleanupParams.agodaId;
      const finalPropertyName =
        options.propertyName || cleanupParams.propertyName;

      const cleanupResult = await cleanupFoldersOnError(
        finalAgodaId,
        finalPropertyName,
        options.jobId
      );

      await dualLogInfo("Emergency folder cleanup completed", {
        jobId: options.jobId,
        downloadsCleanedCount: cleanupResult.downloadsCleanedCount,
        importCleanedCount: cleanupResult.importCleanedCount,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
        timeSession: timeManager.getSessionInfo(),
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during emergency folder cleanup:",
        cleanupError.message,
        { jobId: options.jobId }
      );
      // Don't throw cleanup error - continue with original error handling
    }

    throw error;
  }
}
