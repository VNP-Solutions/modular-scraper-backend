import dotenv from "dotenv";
import { Page } from "puppeteer";
import { applyFilter } from "../apply-filter/apply-filter.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { splitDateRangeIntoChunks } from "./helper.js";
dotenv.config();

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "2", 10);

export async function splitDateRange(
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

    // Wait for date filters to be visible
    await dualLogInfo("Waiting for date filters...");
    await page.waitForSelector('input[type="radio"][name="dateTypeFilter"]', {
      visible: true,
      timeout: 80000,
    });

    // Get the current URL
    const currentUrl = page.url();
    await dualLogInfo(`Current tab URL: ${currentUrl}`);

    // Generate date chunks
    const dateChunks = splitDateRangeIntoChunks(
      start_date,
      end_date,
      CHUNK_SIZE
    );

    await dualLogInfo(`Processing ${dateChunks.length} date chunks...`, {
      totalChunks: dateChunks.length,
      chunkSize: CHUNK_SIZE,
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

      await dualLogInfo(
        `Processing chunk ${i + 1}/${dateChunks.length}: ${chunk.start} to ${
          chunk.end
        }`,
        { chunkIndex: i + 1, totalChunks: dateChunks.length, chunk, jobId }
      );
      await applyFilter(page, chunk.start, chunk.end, expediaId, jobId);
    }
  } catch (error) {
    await dualLogError("Error in setDateRange:", error, { jobId });
    throw error;
  }
}
