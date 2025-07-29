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
    try {
      await page.waitForSelector('input[type="radio"][name="dateTypeFilter"]', {
        visible: true,
        timeout: selectorTimeout,
      });
    } catch (error: any) {
      await dualLogError("Failed to find date filters:", error);
      
      // Send email notification for date filter error
      if (jobId) {
        try {        } catch (emailError) {
          await dualLogError("Failed to send date filters error notification:", emailError);
        }
      }
      throw error;
    }

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
      try {
        await progressManager.initializeJobProgress(
          jobId,
          resumeDate || start_date,
          end_date,
          dateChunks.length
        );
      } catch (error: any) {
        await dualLogError("Failed to initialize job progress:", error);
        
        // Send email notification for progress initialization error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send progress initialization error notification:", emailError);
          }
        }
        throw error;
      }
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
          }. Triggering browser restart...`,
          {
            currentChunk: i + 1,
            totalChunks: dateChunks.length,
            lastProcessedDate: chunk.start,
            jobId,
          }
        );

        // Save progress before restart
        if (jobId) {
          try {
            await progressManager.setJobResumable(
              jobId,
              chunk.start,
              "Browser time limit reached"
            );
          } catch (error: any) {
            await dualLogError("Failed to set job resumable before browser restart:", error);
            
            // Send email notification for resumable set error
            try {            } catch (emailError) {
              await dualLogError("Failed to send resumable set error notification:", emailError);
            }
            throw error;
          }
        }

        // Throw browser restart error to trigger restart in main
        throw new Error(`BROWSER_RESTART_NEEDED:${chunk.start}`);
      }

      try {
        await dualLogInfo(
          `Processing chunk ${i + 1}/${dateChunks.length}: ${chunk.start} to ${chunk.end}`,
          {
            currentChunk: i + 1,
            totalChunks: dateChunks.length,
            chunkStart: chunk.start,
            chunkEnd: chunk.end,
            jobId,
          }
        );

        // Apply filter for this chunk
        await applyFilter(
          browser,
          page,
          chunk.start,
          chunk.end,
          expediaId,
          jobId
        );

        // Update progress after successful chunk processing
        if (jobId) {
          try {
            const progressPercentage = Math.round(((i + 1) / dateChunks.length) * 100);
            await progressManager.updateJobProgress(
              jobId,
              chunk.end,
              progressPercentage,
              `processed_chunk_${i + 1}`,
              i + 1
            );
          } catch (error: any) {
            await dualLogError("Failed to update job progress after chunk:", error);
            
            // Send email notification for progress update error
            try {            } catch (emailError) {
              await dualLogError("Failed to send progress update error notification:", emailError);
            }
            // Don't throw here, continue processing
          }
        }

        await dualLogInfo(
          `Chunk ${i + 1}/${dateChunks.length} processed successfully`
        );
      } catch (error: any) {
        // Check if this is a browser restart error
        if (error.message && error.message.startsWith("BROWSER_RESTART_NEEDED:")) {
          // Re-throw browser restart errors
          throw error;
        }

        await dualLogError(`Error processing chunk ${i + 1}:`, error, {
          chunkIndex: i + 1,
          totalChunks: dateChunks.length,
          chunkStart: chunk.start,
          chunkEnd: chunk.end,
          jobId,
        });

        // Send email notification for chunk processing error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send chunk processing error notification:", emailError);
          }
        }

        throw error;
      }
    }

    // Mark job as completed if we processed all chunks
    if (jobId) {
      try {
        await progressManager.markJobCompleted(jobId);
        await dualLogInfo(`All date chunks processed successfully for job ${jobId}`);
      } catch (error: any) {
        await dualLogError("Failed to mark job as completed:", error);
        
        // Send email notification for job completion error
        try {        } catch (emailError) {
          await dualLogError("Failed to send job completion error notification:", emailError);
        }
        throw error;
      }
    }

    await dualLogInfo("Date range processing completed successfully", {
      totalChunks: dateChunks.length,
      jobId,
    });
  } catch (error: any) {
    await dualLogError("Error in splitDateRange:", error, { jobId, expediaId });
    
    // Send email notification for general splitDateRange error (if not already a browser restart)
    if (jobId && (!error.message || !error.message.startsWith("BROWSER_RESTART_NEEDED:"))) {
      try {      } catch (emailError) {
        await dualLogError("Failed to send date range splitting error notification:", emailError);
      }
    }
    
    throw error;
  }
}
