import dotenv from "dotenv";
import { Browser, Page } from "puppeteer";
import { applyFilter } from "../apply-filter/apply-filter.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeManager } from "../common/time-manager.js";
import { timeoutManager } from "../common/timeout-manager.js";
import {
  generateResumeDateChunks,
  splitDateRangeIntoChunks,
} from "./helper.js";

dotenv.config();

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "1", 10);

export async function splitDateRange(
  browser: Browser,
  page: Page,
  start_date: string,
  end_date: string,
  expediaId: string,
  jobId?: string
) {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during date splitting");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    // Wait for date filters to be visible
    await dualLogInfo("Waiting for date filters...");
    await page.waitForSelector('input[type="radio"][name="dateTypeFilter"]', {
      visible: true,
      timeout: selectorTimeout,
    });

    // Get the current URL
    const currentUrl = page.url();
    await dualLogInfo(`Current tab URL: ${currentUrl}`);

    // Check if job should resume from a specific date
    let resumeDate = null;
    let dateChunks: Array<{ start: string; end: string }> = [];

    if (jobId) {
      resumeDate = progressManager.getJobLastProcessedDate(jobId);
      if (resumeDate) {
        await dualLogInfo(`Resuming from last processed date: ${resumeDate}`, {
          jobId,
          resumeDate,
          originalStartDate: start_date,
          endDate: end_date,
        });

        // Generate chunks from resume date to end date
        dateChunks = generateResumeDateChunks(resumeDate, end_date, CHUNK_SIZE);
      } else {
        // No resume date, start from beginning
        dateChunks = splitDateRangeIntoChunks(start_date, end_date, CHUNK_SIZE);
      }

      // Initialize or update progress tracking
      await progressManager.initializeJobProgress(
        jobId,
        resumeDate || start_date,
        end_date,
        dateChunks.length
      );
    } else {
      // No job ID, start from beginning
      dateChunks = splitDateRangeIntoChunks(start_date, end_date, CHUNK_SIZE);
    }

    await dualLogInfo(`Processing ${dateChunks.length} date chunks...`, {
      totalChunks: dateChunks.length,
      chunkSize: CHUNK_SIZE,
      resumeDate: resumeDate || "none",
      jobId,
    });

    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i];

      // Check if scraping is paused before each chunk
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("Scraping was stopped during date chunk processing");
        return;
      }

      // Check if browser restart is needed
      if (await timeManager.shouldRestartBrowser()) {
        await dualLogInfo(
          `Time limit reached at chunk ${i + 1}/${
            dateChunks.length
          }. Marking job for browser restart.`,
          {
            chunkIndex: i + 1,
            totalChunks: dateChunks.length,
            chunk,
            jobId,
            timeSession: timeManager.getSessionInfo(),
          }
        );

        // Update progress and mark for resume
        if (jobId) {
          await progressManager.updateJobProgress(
            jobId,
            chunk.start, // Save the current chunk start as last processed
            Math.round((i / dateChunks.length) * 100),
            `browser_restart_needed_at_${chunk.start}`,
            i
          );

          await progressManager.setJobResumable(
            jobId,
            chunk.start,
            "Time limit reached - browser restart needed"
          );
        }

        // End current time session
        await timeManager.endSession();

        // Return a special indicator that browser restart is needed
        throw new Error(`BROWSER_RESTART_NEEDED:${chunk.start}`);
      }

      await dualLogInfo(
        `Processing chunk ${i + 1}/${dateChunks.length}: ${chunk.start} to ${
          chunk.end
        }`,
        {
          chunkIndex: i + 1,
          totalChunks: dateChunks.length,
          chunk,
          jobId,
          timeSession: timeManager.getSessionInfo(),
        }
      );

      // Process the current chunk
      await applyFilter(browser, page, chunk.start, chunk.end, expediaId, jobId);

      // Update progress after completing a chunk
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          chunk.end, // Save the chunk end as last processed
          Math.round(((i + 1) / dateChunks.length) * 100),
          `completed_chunk_${i + 1}_of_${dateChunks.length}`,
          i + 1
        );
      }

      await dualLogInfo(`Completed chunk ${i + 1}/${dateChunks.length}`, {
        chunkIndex: i + 1,
        totalChunks: dateChunks.length,
        chunk,
        jobId,
        timeSession: timeManager.getSessionInfo(),
      });
    }

    // Mark job as completed if we reach here
    if (jobId) {
      await progressManager.markJobCompleted(jobId);
    }

    await dualLogInfo("All date chunks processed successfully!", {
      totalChunks: dateChunks.length,
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });
  } catch (error) {
    // Check if this is a browser restart error
    if (
      error instanceof Error &&
      error.message.startsWith("BROWSER_RESTART_NEEDED:")
    ) {
      // Re-throw browser restart errors to be handled by the main function
      throw error;
    }

    await dualLogError("Error in splitDateRange:", error, { jobId });
    throw error;
  }
}
