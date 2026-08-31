import fs from "fs";
import path from "path";
import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "../../common/screenshot-helper.js";
import { timeManager } from "../../common/time-manager.js";
import { JobStatus } from "../../models/job.model.js";
import { JobService } from "../../services/job.service.js";
import { cleanupOnError } from "../utils/error-cleanup.js";
import {
  getStandardFilePaths,
  validateFileForProcessing,
} from "../utils/file-naming.js";
import { submitFinalCsv } from "./submit-final-csv.js";

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
  /**
   * Mark the job as Failed in the database when this process fails (default: true).
   * The reopen flow turns this off — it reports through `case_status` and must not
   * rewrite the job_status of the run that came before it.
   */
  updateJobStatusOnFailure?: boolean;
}

/**
 * Delay helper function
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Click a chat suggestion button by its data-element-value label.
 */
async function clickSuggestionButton(
  page: Page,
  label: string,
  jobId?: string,
  timeoutMs = 10000,
): Promise<boolean> {
  const selectors = [
    `button[data-element-value="${label}"]`,
    `button[data-testid="suggestion-text-button"][data-element-value="${label}"]`,
    `button[data-testid="suggestion-text-button"]:has-text("${label}")`,
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
      await page.click(selector);
      await dualLogInfo(
        `✅ Clicked '${label}' suggestion with selector: ${selector}`,
        { jobId },
      );
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Find CSV file using standardized naming (jobId only)
 */
async function findCsvFileInImport(jobId?: string): Promise<string | null> {
  try {
    if (!jobId) {
      await dualLogError("JobId is required for standardized file naming");
      return null;
    }

    // Use standardized file paths
    const standardPaths = getStandardFilePaths(jobId);
    const { exportFilePath } = standardPaths;

    // Check if standardized file exists
    if (fs.existsSync(exportFilePath)) {
      await dualLogInfo(`Found standardized CSV file: ${exportFilePath}`, {
        jobId,
      });

      // Validate the file before returning
      await validateFileForProcessing(
        exportFilePath,
        jobId,
        "Need Help file upload",
      );

      return exportFilePath;
    }

    await dualLogError(`Standardized CSV file not found: ${exportFilePath}`, {
      jobId,
      expectedPath: exportFilePath,
    });
    return null;
  } catch (error) {
    await dualLogError(
      "Error finding CSV file with standardized naming:",
      error,
      { jobId },
    );
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
      "message.txt",
    );
    const filePath = messageFilePath || defaultMessagePath;

    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    } else {
      // Fallback message if file not found
      return `Dear Agoda Support Team,

We are reviewing Agoda transactions for our property and have followed all required guidelines. Some reservations still have outstanding balances, and attempts to charge the remaining amounts via VCCs were declined. Could you please provide the latest Open Payment Report, including Matched, Match-over, and Match-under bookings, to help us reconcile our records. 

Thank you for your support and assistance.

Best regards,
Revenue Control Team`;
    }
  } catch (error: any) {
    await dualLogError(
      "Error loading message content:",
      error.message || error,
    );
    await dualLogInfo(
      `Attempted to load message from: ${
        messageFilePath ||
        path.join(process.cwd(), "src", "agoda", "need-help", "message.txt")
      }`,
    );
    // Return fallback message
    return `Dear Agoda Support Team,

We are reviewing Agoda transactions for our property and have followed all required guidelines. Some reservations still have outstanding balances, and attempts to charge the remaining amounts via VCCs were declined. Could you please provide the latest Open Payment Report, including Matched, Match-over, and Match-under bookings, to help us reconcile our records. 

Thank you for your support and assistance.

Best regards,
Revenue Control Team`;
  }
}

/**
 * Main function: Automate the complete Need Help process
 */
export async function automateNeedHelpProcess(
  page: Page,
  options: NeedHelpOptions = {},
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
    updateJobStatusOnFailure = true,
  } = options;

  /** Track which steps actually succeeded so we don't report success when something failed */
  const stepResults = {
    needHelpClicked: false,
    contactAgodaSent: false,
    submitRequestPhraseSent: false,
    submitRequestButtonClicked: false,
    issueTypeSelected: false,
    issueDetailsFilled: false,
    csvUploaded: false,
    phoneFilled: false,
    finalSubmitClicked: false,
  };

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
        undefined,
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

    let needHelpClicked = false;

    // Try standard Need Help buttons first
    for (const selector of needHelpSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked 'Need Help' button with selector: ${selector}`,
          { jobId },
        );
        needHelpClicked = true;
        break;
      } catch (error) {
        continue;
      }
    }

    // Fallback: If Need Help not found, try Inbox -> Need Help
    if (!needHelpClicked) {
      await dualLogInfo(
        "Standard 'Need Help' button not found, trying fallback via Inbox...",
        { jobId },
      );

      try {
        const inboxSelector = 'a[data-testid="ycs-inbox-icon"]';
        // Wait for inbox icon
        await page.waitForSelector(inboxSelector, {
          visible: true,
          timeout: 10000,
        });
        await page.click(inboxSelector);

        await dualLogInfo("✅ Clicked Inbox icon, waiting for sidebar...", {
          jobId,
        });
        await delay(3000);

        const secondaryNeedHelpSelectors = [
          'div[data-testid="widget-with-vivr-old"]',
          'div[data-element-name="ycs-private-layout-need-help-button"]',
          'div:has-text("Need Help")',
        ];

        for (const selector of secondaryNeedHelpSelectors) {
          try {
            await page.waitForSelector(selector, {
              visible: true,
              timeout: 10000,
            });
            await page.click(selector);
            await dualLogInfo(
              `✅ Clicked Secondary 'Need Help' button with selector: ${selector}`,
              { jobId },
            );
            needHelpClicked = true;
            break;
          } catch (error) {
            continue;
          }
        }
      } catch (fallbackError: any) {
        await dualLogError(
          "Error in fallback Need Help flow:",
          fallbackError.message,
          { jobId },
        );
      }
    }

    stepResults.needHelpClicked = needHelpClicked;
    if (needHelpClicked && jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        96,
        "agoda_need_help_button_clicked",
        undefined,
      );
      await takeSuccessScreenshot(page, jobId, "need_help_button_clicked");
    } else if (!needHelpClicked) {
      await dualLogError(
        "Failed to click 'Need Help' button (standard and fallback)",
        { jobId },
      );
    }
    // Step 2: Wait for sidebar to load and handle chat input
    await delay(10000); // Increased delay
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
            { jobId },
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
              { jobId },
            );
            break;
          } catch (error) {
            continue;
          }
        }
      }

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
            { jobId },
          );

          stepResults.contactAgodaSent = true;
          // Update progress - Chat message sent
          if (jobId) {
            await progressManager.updateJobProgress(
              jobId,
              undefined,
              96.5,
              "agoda_chat_message_sent",
              undefined,
            );
            await takeSuccessScreenshot(page, jobId, "chat_contact_agoda_sent");
          }
          break;
        } catch (error) {
          continue;
        }
      }
    } catch (err: any) {
      await dualLogInfo(
        `❌ Error during chat sidebar handling: ${err.message}`,
        {
          jobId,
        },
      );
    }

    await delay(10000);
    // step 3: type "support a submit request" in the input field
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
            { jobId },
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
        await dualLogInfo(
          "Typing 'support a submit request' in chat input...",
          { jobId },
        );

        const inputFieldSelectors = [
          'fieldset[data-testid="ChatWidgetInputFieldset"]',
          'div[class*="IRISCwMessenger__Bottomm"] fieldset',
        ];

        for (const selector of inputFieldSelectors) {
          try {
            await page.click(selector);
            await page.type(selector, "support a submit request");
            await dualLogInfo(
              `✅ Typed 'support a submit request' with selector: ${selector}`,
              { jobId },
            );
            break;
          } catch (error) {
            continue;
          }
        }
      }

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
            { jobId },
          );

          stepResults.submitRequestPhraseSent = true;
          // Update progress - Chat message sent
          if (jobId) {
            await progressManager.updateJobProgress(
              jobId,
              undefined,
              96.5,
              "agoda_chat_message_sent",
              undefined,
            );
            await takeSuccessScreenshot(
              page,
              jobId,
              "chat_submit_request_sent",
            );
          }
          break;
        } catch (error) {
          continue;
        }
      }
    } catch (err: any) {
      await dualLogInfo(
        `❌ Error during chat sidebar handling: ${err.message}`,
        {
          jobId,
        },
      );
    }

    // step 4: Click "Submit request" button
    // Primary path: button appears directly after chat messages.
    // Fallback path (some properties): "Send an email" → then "Submit request".
    await delay(10000);
    await dualLogInfo("Looking for 'Submit request' button...", { jobId });

    let submitRequestClicked = await clickSuggestionButton(
      page,
      "Submit request",
      jobId,
      10000,
    );

    if (!submitRequestClicked) {
      await dualLogInfo(
        "'Submit request' not found directly — trying 'Send an email' first...",
        { jobId },
      );

      const sendEmailClicked = await clickSuggestionButton(
        page,
        "Send an email",
        jobId,
        10000,
      );

      if (sendEmailClicked) {
        if (jobId) {
          await takeSuccessScreenshot(page, jobId, "send_an_email_clicked");
        }
        await delay(5000);
        submitRequestClicked = await clickSuggestionButton(
          page,
          "Submit request",
          jobId,
          15000,
        );
      }
    }

    stepResults.submitRequestButtonClicked = submitRequestClicked;

    if (submitRequestClicked && jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        97,
        "agoda_submit_request_clicked",
        undefined,
      );
      await takeSuccessScreenshot(
        page,
        jobId,
        "submit_request_button_clicked",
      );
    } else if (!submitRequestClicked) {
      await dualLogError(
        "Failed to click 'Submit request' button (direct and Send an email fallback)",
        { jobId },
      );
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
          stepResults.issueTypeSelected = true;
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
                { jobId },
              );
              otherSelected = true;
              stepResults.issueTypeSelected = true;
              break;
            } catch (error) {
              continue;
            }
          }

          if (!otherSelected) {
            // Final fallback: try to select the last radio option
            await dualLogInfo(
              "Trying fallback: selecting last radio option...",
              { jobId },
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
              stepResults.issueTypeSelected = true;
              await dualLogInfo(
                "✅ Selected last radio option (should be 'Other')",
                { jobId },
              );
            } catch (error: any) {
              await dualLogError(
                "Failed to select 'Other' option with any method",
                error.message,
                { jobId },
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
                },
              );
              break;
            }
          } catch (error) {
            continue;
          }
        }
        await delay(1000);
        if (jobId) {
          await takeSuccessScreenshot(page, jobId, "issue_type_selected");
        }
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
            { jobId },
          );
          stepResults.issueDetailsFilled = true;

          // Update progress - Issue details filled
          if (jobId) {
            await progressManager.updateJobProgress(
              jobId,
              undefined,
              98,
              "agoda_issue_details_filled",
              undefined,
            );
            await takeSuccessScreenshot(page, jobId, "issue_details_filled");
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
          csvFilePath || (await findCsvFileInImport(jobId));
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
                  { jobId },
                );
                stepResults.csvUploaded = true;

                // Update progress - CSV file uploaded
                if (jobId) {
                  await progressManager.updateJobProgress(
                    jobId,
                    undefined,
                    99,
                    "agoda_csv_file_uploaded",
                    undefined,
                  );
                  await takeSuccessScreenshot(page, jobId, "csv_file_uploaded");
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
            { jobId },
          );
          stepResults.phoneFilled = true;
          if (jobId) {
            await takeSuccessScreenshot(page, jobId, "phone_number_filled");
          }
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

    // Step 9: Click final submit button (production only); track success for completion/failure
    if (process.env.AGODA_SUBMISSION === "true") {
      stepResults.finalSubmitClicked = await submitFinalCsv(page, jobId);
    } else {
      stepResults.finalSubmitClicked = true; // not submitting in this env, skip check
    }

    // Fail if critical steps did not succeed instead of reporting success
    const criticalSteps = [
      { key: "needHelpClicked" as const, label: "Need Help button clicked" },
      {
        key: "contactAgodaSent" as const,
        label: "'contact agoda' message sent",
      },
      {
        key: "submitRequestButtonClicked" as const,
        label: "Submit request button clicked",
      },
      {
        key: "issueTypeSelected" as const,
        label: "Issue type (Other) selected",
      },
      { key: "issueDetailsFilled" as const, label: "Issue details filled" },
      {
        key: "finalSubmitClicked" as const,
        label: "Final submit button clicked",
      },
    ];
    const failedSteps = criticalSteps.filter((s) => !stepResults[s.key]);
    if (failedSteps.length > 0) {
      // Short message for DB failed_reason (minimalistic)
      const shortMessage = `Need Help incomplete: ${failedSteps.map((s) => s.label).join("; ")}`;
      await dualLogError(shortMessage, { jobId, stepResults });
      throw new Error(shortMessage);
    }

    if (jobId) {
      // Update progress - Need Help process completed
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        100,
        "agoda_need_help_process_completed",
        undefined,
      );
    }

    await dualLogInfo(
      "✅ Need Help automation process completed successfully",
      {
        jobId,
        timeSession: timeManager.getSessionInfo(),
        stepResults,
      },
    );
    if (jobId) {
      await takeSuccessScreenshot(page, jobId, "need_help_process_completed");
    }

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
      },
    );
    if (jobId) {
      await takeErrorScreenshot(page, jobId, "need_help_process_failed");
    }

    // Standardized cleanup on Need Help error
    try {
      await dualLogInfo(
        "Starting standardized cleanup due to Need Help error",
        {
          jobId,
          agodaId,
          propertyName,
          timeSession: timeManager.getSessionInfo(),
        },
      );

      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        propertyName,
        operation: "agoda_need_help_error",
      });

      await dualLogInfo(
        "Standardized cleanup completed after Need Help error",
        {
          jobId,
          downloadFilesCleanedCount: cleanupResult.downloadFilesCleanedCount,
          exportFilesCleanedCount: cleanupResult.exportFilesCleanedCount,
          foldersRemovedCount: cleanupResult.foldersRemovedCount,
          totalFilesProcessed: cleanupResult.totalFilesProcessed,
          errors: cleanupResult.errors.length,
          timeSession: timeManager.getSessionInfo(),
        },
      );
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup (continuing with error handling):",
        cleanupError.message,
        { jobId },
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
        undefined,
      );

      // Explicitly fail the job in the database with failed_reason
      if (updateJobStatusOnFailure) {
        try {
          const failedReason =
            error?.message ?? "Need Help process failed (unknown reason)";
          await jobService.updateJobStatusWithReason(
            jobId,
            JobStatus.Failed,
            failedReason,
          );
          await dualLogInfo(
            "❌ Job marked as Failed in database with failed_reason",
            {
              jobId,
              failedReason,
            },
          );
        } catch (failError: any) {
          await dualLogError(
            "Failed to update job status to Failed:",
            failError.message,
            { jobId },
          );
        }
      } else {
        await dualLogInfo(
          "Skipping job_status update — the caller tracks this failure itself",
          { jobId },
        );
      }
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
  jobId?: string,
): Promise<void> {
  try {
    await dualLogInfo("🧹 Starting CSV cleanup process...", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Clean up job-specific downloads folder (safe for concurrent jobs)
    if (jobId) {
      const baseDownloadsDir = path.resolve(process.cwd(), "downloads");
      const jobDownloadsDir = path.join(baseDownloadsDir, jobId);

      if (fs.existsSync(jobDownloadsDir)) {
        try {
          // Remove the entire job-specific folder
          fs.rmSync(jobDownloadsDir, { recursive: true, force: true });
          await dualLogInfo(
            `✅ Removed job downloads folder: ${jobDownloadsDir}`,
            { jobId },
          );
        } catch (error) {
          await dualLogError(
            `Failed to remove job downloads folder: ${jobDownloadsDir}`,
            error,
            { jobId },
          );
        }
      } else {
        await dualLogInfo(
          `Job downloads folder does not exist: ${jobDownloadsDir}`,
          { jobId },
        );
      }
    } else if (agodaId) {
      // Fallback to legacy cleanup if no jobId but agodaId is available
      const downloadsDir = path.resolve(process.cwd(), "downloads");
      if (fs.existsSync(downloadsDir)) {
        const downloadFiles = fs.readdirSync(downloadsDir);
        // Support both patterns:
        // 1. Old pattern: {agodaId}_*.csv (e.g., "2456448_Agoda_Performance_...")
        // 2. New pattern: {propertyName}-{agodaId}.csv (e.g., "ac-hotel-arlington-national-landing-2456448.csv")
        const oldDownloadCsvPattern = new RegExp(`^${agodaId}_.*\\.csv$`, "i");
        const newDownloadCsvPattern = new RegExp(`.*-${agodaId}\\.csv$`, "i");

        for (const file of downloadFiles) {
          if (
            oldDownloadCsvPattern.test(file) ||
            newDownloadCsvPattern.test(file)
          ) {
            const filePath = path.join(downloadsDir, file);
            try {
              fs.unlinkSync(filePath);
              await dualLogInfo(`✅ Deleted download file: ${file}`, { jobId });
            } catch (error) {
              await dualLogError(
                `Failed to delete download file: ${file}`,
                error,
                { jobId },
              );
            }
          }
        }
      }
    }

    // Clean up import folder - remove entire job-specific folder for better isolation
    if (jobId) {
      const baseImportDir = path.resolve(process.cwd(), "import");
      const jobImportDir = path.join(baseImportDir, jobId);

      if (fs.existsSync(jobImportDir)) {
        try {
          // Remove entire job-specific import folder
          fs.rmSync(jobImportDir, { recursive: true, force: true });
          await dualLogInfo(
            `✅ Deleted job-specific import folder: ${jobImportDir}`,
            { jobId },
          );
        } catch (error) {
          await dualLogError(
            `Failed to delete job-specific import folder: ${jobImportDir}`,
            error,
            { jobId },
          );
        }
      }
    } else {
      // Fallback to legacy cleanup for jobs without jobId
      const importDir = path.resolve(process.cwd(), "import");
      if (fs.existsSync(importDir)) {
        const importFiles = fs.readdirSync(importDir);

        for (const file of importFiles) {
          if (file.endsWith(".csv") && !file.includes(".gitkeep")) {
            // Only delete files that match EXACT pattern: {propertyName}-{agodaId}.csv
            // This prevents deleting other concurrent jobs' files
            if (agodaId && propertyName) {
              const expectedFileName = `${propertyName
                .toLowerCase()
                .replace(/[^\w\s-]/g, "")
                .replace(/\s+/g, "-")}-${agodaId}.csv`;
              if (file.toLowerCase() === expectedFileName.toLowerCase()) {
                const filePath = path.join(importDir, file);
                try {
                  fs.unlinkSync(filePath);
                  await dualLogInfo(`✅ Deleted import file: ${file}`, {
                    jobId,
                  });
                } catch (error) {
                  await dualLogError(
                    `Failed to delete import file: ${file}`,
                    error,
                    { jobId },
                  );
                }
              }
            } else if (agodaId && !propertyName) {
              // Fallback: only if file contains agodaId AND ends with it (more specific)
              const agodaPattern = new RegExp(`.*-${agodaId}\\.csv$`, "i");
              if (agodaPattern.test(file)) {
                const filePath = path.join(importDir, file);
                try {
                  fs.unlinkSync(filePath);
                  await dualLogInfo(`✅ Deleted import file: ${file}`, {
                    jobId,
                  });
                } catch (error) {
                  await dualLogError(
                    `Failed to delete import file: ${file}`,
                    error,
                    { jobId },
                  );
                }
              }
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
 * Get Agoda ID and Property Name from job service (for standardized naming)
 * With standardized naming using jobId only, we get this info from the database
 */
async function extractCleanupInfo(
  csvFilePath?: string,
  jobId?: string,
): Promise<{ agodaId?: string; propertyName?: string }> {
  try {
    if (jobId) {
      // Get agoda ID from job service
      const agodaIdResult = await jobService.getAgodaIdFromJob(jobId);
      const agodaId = agodaIdResult?.agodaId;

      if (agodaId) {
        await dualLogInfo(`Retrieved agodaId from job service: ${agodaId}`, {
          jobId,
        });
        return { agodaId };
      }
    }

    // Legacy fallback: try to extract from old file format if no jobId
    if (csvFilePath) {
      const fileName = path.basename(csvFilePath, ".csv");

      // Check if it's the new standardized format (just jobId)
      if (fileName === jobId) {
        await dualLogInfo(`File uses standardized naming format: ${fileName}`, {
          jobId,
        });
        return await extractCleanupInfo(undefined, jobId);
      }

      // Try to extract from old import file format: property-name-agoda-id.csv
      const parts = fileName.split("-");
      if (parts.length >= 2) {
        const agodaId = parts[parts.length - 1];
        const propertyName = parts.slice(0, -1).join("-");
        return { agodaId, propertyName };
      }
    }

    await dualLogInfo(
      "No cleanup info could be extracted, this may be expected for new standardized naming",
      { jobId, csvFilePath },
    );
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
  jobId?: string,
): Promise<void> {
  return automateNeedHelpProcess(page, { jobId, cleanupAfter: true });
}

/**
 * Complete Need Help automation with cleanup
 */
export async function automateNeedHelpWithCleanup(
  page: Page,
  options: NeedHelpOptions = {},
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
          true,
        );

        await dualLogInfo(
          `✅ Updated case_open to true for job ${
            updateResult?._id || options.jobId
          }`,
          {
            jobId: options.jobId,
            timeSession: timeManager.getSessionInfo(),
          },
        );
      } catch (caseOpenError: any) {
        await dualLogError(
          "❌ Error updating case_open field (continuing with cleanup):",
          caseOpenError.message,
          { jobId: options.jobId },
        );
        // Don't throw error - continue with cleanup even if case_open update fails
      }
    } else {
      await dualLogInfo(
        "⚠️ No jobId provided - skipping case_open field update",
        { timeSession: timeManager.getSessionInfo() },
      );
    }

    // Extract cleanup information
    const { agodaId, propertyName } = await extractCleanupInfo(
      options.csvFilePath,
      options.jobId,
    );

    // Clean up CSV files
    await cleanupCsvFiles(agodaId, propertyName, options.jobId);
  } catch (error: any) {
    await dualLogError(
      "❌ Need Help automation with cleanup failed:",
      error.message,
      { jobId: options.jobId },
    );

    // Emergency cleanup on complete failure
    try {
      await dualLogInfo(
        "Starting emergency folder cleanup due to complete failure",
        {
          jobId: options.jobId,
          timeSession: timeManager.getSessionInfo(),
        },
      );

      // Use standardized emergency cleanup
      const cleanupResult = await cleanupOnError(options.jobId, {
        agodaId: options.agodaId,
        propertyName: options.propertyName,
        operation: "agoda_need_help_emergency_cleanup",
      });

      await dualLogInfo("Emergency standardized cleanup completed", {
        jobId: options.jobId,
        downloadFilesCleanedCount: cleanupResult.downloadFilesCleanedCount,
        exportFilesCleanedCount: cleanupResult.exportFilesCleanedCount,
        foldersRemovedCount: cleanupResult.foldersRemovedCount,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
        timeSession: timeManager.getSessionInfo(),
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during emergency folder cleanup:",
        cleanupError.message,
        { jobId: options.jobId },
      );
      // Don't throw cleanup error - continue with original error handling
    }

    throw error;
  }
}
