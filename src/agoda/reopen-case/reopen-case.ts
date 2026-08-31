/**
 * Agoda "reopen case" run.
 *
 * Mirrors the property run (browser setup → login → property page → Need Help)
 * but skips the date-range booking lookup entirely: the booking IDs already came
 * from the Partner Support report, so all this run has to do is get back into the
 * portal and file a new Need Help request for them.
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Browser, Page } from "puppeteer";
import { browserSetupLocal } from "../../browser-setup/browser-local.js";
import { browserSetupProduction } from "../../browser-setup/browser-prod.js";
import { delay } from "../../common/delay.js";
import { emailNotifier } from "../../common/email-notifier.js";
import {
  FAILED_REASON,
  setFailedReasonCode,
} from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "../../common/log-helper.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "../../common/screenshot-helper.js";
import { timeManager } from "../../common/time-manager.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { jobService } from "../../services/job.service.js";
import agodaLogin from "../login-system/login.js";
import { automateNeedHelpWithCleanup } from "../need-help/need-help.js";
import { cleanupOnError } from "../utils/error-cleanup.js";

dotenv.config();

/** Same reporting page the property run uses, minus the date-range parameters. */
const PROPERTY_PAGE_BASE =
  "https://portal.agoda.com/mldc/en-us/app/reporting/booking";

const MAX_NAVIGATION_ATTEMPTS = 3;

const REOPEN_MESSAGE_PATH = path.join(
  process.cwd(),
  "src",
  "agoda",
  "need-help",
  "reopen-message.txt"
);

export interface ReopenCaseParams {
  agodaId: string;
  jobId: string;
  agodaUsername: string;
  agodaPassword: string;
  /** Bookings the reopen rules flagged as still owed with no usable amount. */
  reopenBookingIds: string[];
  /** Case ID from the Partner Support reply, quoted back in the new request. */
  caseId?: string | null;
  brightDataSessionId?: string;
  windowSize?: { width: number; height: number };
  timezone?: string;
  acceptLanguage?: string;
}

export interface ReopenCaseResult {
  jobId: string;
  agodaId: string;
  caseId: string | null;
  reopenBookingIds: string[];
}

/**
 * Builds the Need Help message from `reopen-message.txt`, swapping
 * `{{BOOKING_IDS}}` for the booking list and `{{CASE_ID}}` for the case number.
 */
async function buildReopenMessage(
  bookingIds: string[],
  caseId: string | null | undefined,
  jobId: string
): Promise<string> {
  const bookingList = bookingIds.join(", ");

  let template: string;
  try {
    template = fs.readFileSync(REOPEN_MESSAGE_PATH, "utf-8");
  } catch (error: any) {
    await dualLogWarn(
      `⚠️ Could not read ${REOPEN_MESSAGE_PATH}, using the built-in reopen message`,
      { jobId, error: error?.message }
    );
    template =
      "Dear Agoda Support Team,\n\n" +
      "We are reviewing Agoda transactions for our property and have followed all required guidelines. " +
      "Some reservations still have outstanding balances, and attempts to charge the remaining amounts via VCCs were declined. " +
      "The reservations are {{BOOKING_IDS}}. " +
      "Could you please provide the latest Open Payment Report, including Matched, Match-over, and Match-under bookings, to help us reconcile our records.\n\n" +
      "Thank you for your support and assistance.\n\n" +
      "Best regards,\nRevenue Control Team";
  }

  return template
    .replace(/\{\{BOOKING_IDS\}\}/g, bookingList)
    .replace(/\{\{CASE_ID\}\}/g, caseId ?? "");
}

/**
 * Opens the property's portal page and waits until the portal shell is really
 * there. The booking table itself is irrelevant here — Need Help only needs the
 * portal chrome — so either the Reservations heading or the inbox icon counts.
 */
async function openPropertyPage(
  browser: Browser,
  agodaId: string,
  jobId: string
): Promise<Page> {
  const url = `${PROPERTY_PAGE_BASE}/${agodaId}`;
  const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

  const page = await browser.newPage();
  let portalReady = false;

  for (
    let attempt = 1;
    attempt <= MAX_NAVIGATION_ATTEMPTS && !portalReady;
    attempt++
  ) {
    await dualLogInfo(
      `Navigation attempt ${attempt}/${MAX_NAVIGATION_ATTEMPTS} to property page: ${url}`,
      { jobId, agodaId }
    );

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: loadingTimeout,
      });
      await page.waitForSelector("body", { timeout: loadingTimeout });
      await delay(5000);

      portalReady = await page.evaluate(() => {
        const hasReservations = (document.body.textContent || "").includes(
          "Reservations"
        );
        const hasInbox = Boolean(
          document.querySelector('a[data-testid="ycs-inbox-icon"]')
        );
        return hasReservations || hasInbox;
      });

      if (portalReady) {
        await dualLogInfo("✅ Property page loaded and portal shell is ready", {
          jobId,
          agodaId,
        });
        break;
      }

      await dualLogInfo(
        `❌ Portal shell not detected on attempt ${attempt}`,
        { jobId, agodaId }
      );
    } catch (navigationError: any) {
      await dualLogError(
        `Error loading property page on attempt ${attempt}:`,
        navigationError.message,
        { jobId, agodaId }
      );
    }

    if (!portalReady && attempt < MAX_NAVIGATION_ATTEMPTS) {
      await delay(3000);
    }
  }

  if (!portalReady) {
    await takeErrorScreenshot(page, jobId, "reopen_property_page_failed");
    await page.close();
    const error = new Error(
      `Failed to load the Agoda property page for ${agodaId} after ${MAX_NAVIGATION_ATTEMPTS} attempts`
    );
    setFailedReasonCode(error, FAILED_REASON.AGODA_PAGE_LOAD_FAILED);
    throw error;
  }

  await takeSuccessScreenshot(page, jobId, "reopen_property_page_loaded");
  return page;
}

/**
 * Logs in, opens the property page and files a Need Help request asking Agoda to
 * reopen the case for the given bookings.
 */
export async function runAgodaReopenCase(
  params: ReopenCaseParams
): Promise<ReopenCaseResult> {
  const {
    agodaId,
    jobId,
    agodaUsername,
    agodaPassword,
    reopenBookingIds,
    caseId,
    brightDataSessionId,
    windowSize,
    timezone,
    acceptLanguage,
  } = params;

  let browser: Browser | null = null;
  let propertyPage: Page | null = null;

  await timeManager.startSession(jobId);

  try {
    await dualLogInfo("Starting Agoda reopen-case process", {
      jobId,
      agodaId,
      caseId,
      bookingCount: reopenBookingIds.length,
      timeSession: timeManager.getSessionInfo(),
    });

    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId) {
      throw new Error("agodaId is a required parameter");
    }

    if (reopenBookingIds.length === 0) {
      throw new Error(
        "reopenBookingIds is empty — there is nothing to ask Agoda to reopen"
      );
    }

    // The reopen run has no date range, so progress is tracked as a single
    // stage keyed on today's date purely to keep the progress file valid.
    const today = new Date().toISOString().split("T")[0];
    await progressManager.initializeJobProgress(jobId, today, today, 1);

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const stoppedErr = new Error(
        "Scraping was stopped during Agoda reopen-case startup"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      5,
      "agoda_reopen_case_initialized",
      undefined
    );

    const environment = process.env.ENVIRONMENT || "production";
    await dualLogInfo(`Setting up browser for ${environment} environment`, {
      jobId,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    });

    const setupResult =
      environment === "production"
        ? await browserSetupProduction(jobId, "agoda")
        : await browserSetupLocal(
            jobId,
            "agoda",
            brightDataSessionId,
            windowSize,
            timezone,
            acceptLanguage
          );

    browser = setupResult.browser;
    const loginPage = setupResult.page;
    await dualLogInfo("Browser setup completed successfully", { jobId });

    if (loginPage) {
      await takeSuccessScreenshot(loginPage, jobId, "browser_setup_completed");
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      15,
      "agoda_reopen_case_browser_setup_complete",
      undefined
    );

    await agodaLogin(browser, loginPage, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully", { jobId });

    if (loginPage) {
      await takeSuccessScreenshot(loginPage, jobId, "login_completed");
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      40,
      "agoda_reopen_case_login_complete",
      undefined
    );

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const stoppedErr = new Error(
        "Scraping was stopped before the Agoda property page could be opened"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
    }

    // Straight to the property page — no date range, no booking data fetch.
    propertyPage = await openPropertyPage(browser, agodaId, jobId);

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      70,
      "agoda_reopen_case_property_page_loaded",
      undefined
    );

    const job = await jobService.getJobById(jobId);
    const customMessage = await buildReopenMessage(
      reopenBookingIds,
      caseId,
      jobId
    );

    await dualLogInfo(
      `Starting Need Help automation for ${reopenBookingIds.length} booking(s) to reopen`,
      { jobId, agodaId, caseId, reopenBookingIds }
    );

    await automateNeedHelpWithCleanup(propertyPage, {
      jobId,
      agodaId,
      propertyName: job?.property_name,
      customMessage,
      // Nothing is attached on a reopen — the booking IDs go in the message.
      skipFileUpload: true,
      // Failures surface as `case_status`, not as a job_status rewrite.
      updateJobStatusOnFailure: false,
    });

    await progressManager.markJobCompleted(jobId);
    await timeManager.endSession();

    await dualLogInfo("Agoda reopen-case process completed successfully", {
      jobId,
      agodaId,
      caseId,
      bookingCount: reopenBookingIds.length,
      timeSession: timeManager.getSessionInfo(),
    });

    return {
      jobId,
      agodaId,
      caseId: caseId ?? null,
      reopenBookingIds,
    };
  } catch (error: any) {
    await dualLogError("Error in Agoda reopen-case:", error, { jobId });

    if (browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeErrorScreenshot(activePage, jobId, "reopen_case_error");
        }
      } catch (screenshotError) {
        await dualLogError("Failed to take error screenshot:", screenshotError, {
          jobId,
        });
      }
    }

    // Release the OTP slot so queued jobs can move on.
    otpCompletionNotifier.notifyOtpCompleted(jobId);

    await timeManager.endSession();
    await progressManager.handleJobError(jobId, error);

    try {
      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        operation: "agoda_reopen_case_error",
      });
      await dualLogInfo("Standardized cleanup completed", {
        jobId,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup (continuing with error handling):",
        cleanupError.message,
        { jobId }
      );
    }

    // job_status is intentionally left alone here — the caller records the
    // outcome on `case_status` instead.

    try {
      await emailNotifier.notifyJobError(
        jobId,
        error?.message || "Unknown error in Agoda reopen-case",
        error,
        {
          stage: "agoda_reopen_case",
          progressPercentage:
            progressManager.getJobProgress(jobId)?.progressPercentage,
        }
      );
    } catch (emailError) {
      await dualLogError("Failed to send error notification email:", emailError, {
        jobId,
      });
    }

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        await dualLogInfo("Browser closed successfully", { jobId });
      } catch (cleanupError) {
        await dualLogError("Error during final browser cleanup:", cleanupError, {
          jobId,
        });
      }
    }
  }
}

export default runAgodaReopenCase;
