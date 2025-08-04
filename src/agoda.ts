import dotenv from "dotenv";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { delay } from "./common/delay.js";
import { emailNotifier } from "./common/email-notifier.js";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "./common/log-helper.js";
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { timeManager } from "./common/time-manager.js";
import { splitDateRange } from "./date-split/date-split.js";
import { getNextDateFromCompleted } from "./date-split/helper.js";
import login from "./login/login.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";
import { jobQueueUrlService } from "./services/job-queue-url.service.js";

dotenv.config();

async function agoda(
  agodaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  agodaUsername?: string,
  agodaPassword?: string
): Promise<void> {
  try {
    const environment = process.env.ENVIRONMENT || "production";
    let setupResult = null;
    let browser = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(jobId, "agoda");
    } else {
      setupResult = await browserSetupLocal(jobId, "agoda");
    }
    browser = setupResult.browser;
    const page = setupResult.page;
    

  } catch (error) {
    
    await dualLogError("Error:", error);
    throw error;
  }
}

export default agoda;
