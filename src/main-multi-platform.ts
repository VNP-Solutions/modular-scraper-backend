import dotenv from "dotenv";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
  isJobLoggingActive,
} from "./common/log-helper.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { ScraperFactory, SupportedPlatforms, ScrapingJobParams, detectPlatform } from "./scrapers/scraper-factory.js";

dotenv.config();

import type { BookingGroupScrapeStep } from "./scrapers/base-scraper.js";

interface MultiPlatformJobParams {
  platform?: SupportedPlatforms | string;
  propertyId?: string;
  propertyIdForDb?: string;
  startDate?: string;
  endDate?: string;
  jobId?: string;
  user_email?: string;
  user_password?: string;
  url?: string; // For platform detection
  bookingGroupSteps?: BookingGroupScrapeStep[];
  groupOtpLeaseJobId?: string;
  workerAssignmentTag?: string;
}

async function mainMultiPlatform(params: MultiPlatformJobParams): Promise<void> {
  let jobLogger = null;
  const isBookingGroup = Boolean(
    params.bookingGroupSteps && params.bookingGroupSteps.length > 0
  );

  try {
    // Initialize job logging if jobId is provided
    if (params.jobId) {
      jobLogger = initializeJobLogging(params.jobId);
      await dualLogInfo(`Starting multi-platform job ${params.jobId}`, {
        platform: params.platform,
        propertyId: params.propertyId,
        startDate: params.startDate,
        endDate: params.endDate,
        user_email: params.user_email ? "[REDACTED]" : undefined,
      });
    }

    // Determine platform
    let platform: SupportedPlatforms;
    
    if (params.platform && ScraperFactory.isPlatformSupported(params.platform)) {
      platform = params.platform as SupportedPlatforms;
      await dualLogInfo(`Using specified platform: ${platform}`);
    } else if (params.url) {
      const detectedPlatform = detectPlatform(params.url);
      if (detectedPlatform) {
        platform = detectedPlatform;
        await dualLogInfo(`Detected platform from URL: ${platform}`);
      } else {
        throw new Error(`Could not detect platform from URL: ${params.url}`);
      }
    } else {
      // Default to Expedia for backward compatibility
      platform = SupportedPlatforms.EXPEDIA;
      await dualLogInfo(`No platform specified, defaulting to: ${platform}`);
    }

    // Validate credentials (stored passwords are encrypted JSON; plain strings pass through)
    const email = params.user_email;
    let password: string | undefined;
    if (params.user_password) {
      try {
        password = decryptPassword(params.user_password);
      } catch {
        password = params.user_password;
      }
    }

    if (!email || !password) {
      throw new Error("Login credentials are required");
    }

    // Create scraper instance
    await dualLogInfo(`Creating ${platform} scraper`);
    const scraper = ScraperFactory.createScraper({
      platform,
      jobId: params.jobId,
      enableUI: true,
      timeout: 300000
    });

    // Check if scraping should continue
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogInfo("Scraping was stopped before execution");
      if (params.jobId && isJobLoggingActive()) {
        await finalizeJobLogging("failed");
      }
      return;
    }

    // Prepare scraping job parameters
    const scrapingParams: ScrapingJobParams = {
      jobId: params.jobId,
      propertyId: params.propertyId,
      propertyIdForDb: params.propertyIdForDb,
      startDate: params.startDate,
      endDate: params.endDate,
      credentials: {
        email,
        password,
      },
      bookingGroupSteps: params.bookingGroupSteps,
      groupOtpLeaseJobId: params.groupOtpLeaseJobId,
      workerAssignmentTag: params.workerAssignmentTag,
    };

    if (
      platform === SupportedPlatforms.BOOKING &&
      params.bookingGroupSteps &&
      params.bookingGroupSteps.length > 0
    ) {
      const first = params.bookingGroupSteps[0];
      scrapingParams.propertyId = params.propertyId ?? first.bookingId;
      scrapingParams.propertyIdForDb =
        params.propertyIdForDb ?? first.propertyIdForDb;
      scrapingParams.jobId =
        params.groupOtpLeaseJobId ?? params.jobId ?? first.jobId;
      scrapingParams.groupOtpLeaseJobId =
        params.groupOtpLeaseJobId ?? params.jobId ?? first.jobId;
    }

    // Execute scraping
    await dualLogInfo(`Starting ${platform} scraping process`);
    const result = await scraper.executeScraping(scrapingParams);

    if (!result.success) {
      await dualLogError(`${platform} scraping failed:`, result.error);
      throw new Error(result.error || `${platform} scraping failed`);
    }

    await dualLogInfo(`${platform} scraping completed successfully`, {
      dataKeys: result.data ? Object.keys(result.data) : [],
      screenshots: result.screenshots?.length || 0,
    });

    if (params.jobId) {
      if (!isBookingGroup) {
        await finalizeJobLogging("success");
      } else if (isJobLoggingActive()) {
        await finalizeJobLogging("success");
      }
    }
  } catch (error) {
    await dualLogError("Multi-platform scraping error:", error);

    if (params.jobId && isJobLoggingActive()) {
      await finalizeJobLogging("failed");
    }
    throw error;
  }
}

// Backward compatibility function that matches the original main signature
async function main(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  user_email?: string,
  user_password?: string,
  platform?: SupportedPlatforms | string
): Promise<void> {
  return mainMultiPlatform({
    platform: platform || SupportedPlatforms.EXPEDIA,
    propertyId: expediaId,
    startDate,
    endDate,
    jobId,
    user_email,
    user_password
  });
}

// Export both functions
export default main;
export { mainMultiPlatform, SupportedPlatforms };