import dotenv from "dotenv";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "./common/log-helper.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { ScraperFactory, SupportedPlatforms, ScrapingJobParams, detectPlatform } from "./scrapers/scraper-factory.js";

dotenv.config();

interface MultiPlatformJobParams {
  platform?: SupportedPlatforms | string;
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  jobId?: string;
  user_email?: string;
  user_password?: string;
  url?: string; // For platform detection
}

async function mainMultiPlatform(params: MultiPlatformJobParams): Promise<void> {
  let jobLogger = null;

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

    // Validate credentials
    const email = params.user_email;
    const password = params.user_password ? decryptPassword(params.user_password) : undefined;

    if (!email || !password) {
      throw new Error('Login credentials are required');
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
      if (params.jobId) {
        await finalizeJobLogging("failed");
      }
      return;
    }

    // Prepare scraping job parameters
    const scrapingParams: ScrapingJobParams = {
      jobId: params.jobId,
      propertyId: params.propertyId,
      startDate: params.startDate,
      endDate: params.endDate,
      credentials: {
        email,
        password
      }
    };

    // Execute scraping
    await dualLogInfo(`Starting ${platform} scraping process`);
    const result = await scraper.executeScraping(scrapingParams);

    if (result.success) {
      await dualLogInfo(`${platform} scraping completed successfully`, {
        dataKeys: result.data ? Object.keys(result.data) : [],
        screenshots: result.screenshots?.length || 0
      });

      // Finalize logging with success status
      if (params.jobId) {
        await finalizeJobLogging("success");
      }
    } else {
      await dualLogError(`${platform} scraping failed:`, result.error);
      
      // Finalize logging with failed status
      if (params.jobId) {
        await finalizeJobLogging("failed");        }
    }

  } catch (error) {
    await dualLogError("Multi-platform scraping error:", error);

    // Finalize logging with failed status
    if (params.jobId) {
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

// Example usage:
/*
// Using the original interface (Expedia)
await main('12345', '2024-01-01', '2024-01-31', 'job123', 'user@example.com', 'password');

// Using the new multi-platform interface
await mainMultiPlatform({
  platform: SupportedPlatforms.BOOKING,
  propertyId: '67890',
  startDate: '2024-01-01',
  endDate: '2024-01-31',
  jobId: 'job124',
  user_email: 'admin@example.com',
  user_password: 'encrypted_password'
});

// Platform detection from URL
await mainMultiPlatform({
  url: 'https://admin.booking.com',
  propertyId: '67890',
  startDate: '2024-01-01',
  endDate: '2024-01-31',
  jobId: 'job125',
  user_email: 'admin@example.com',
  user_password: 'encrypted_password'
});
*/