import cron from "node-cron";
import { bookingTrustScheduler } from "./booking-trust-scheduler.service.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import { BookingErrorType, getBookingErrorDescription } from "../common/booking-error-types.js";

export class BookingTrustCronService {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;

  /**
   * Start the hourly cron job for booking trust verification
   */
  start(): void {
    if (this.cronJob) {
      dualLogInfo("Booking trust cron job is already running");
      return;
    }

    // Run every hour at minute 0 (e.g., 12:00, 1:00, 2:00, etc.)
    this.cronJob = cron.schedule("0 * * * *", async () => {
      await this.runScheduledVerification();
    }, {
      scheduled: true,
      timezone: "UTC"
    });

    this.isRunning = true;
    dualLogInfo("Booking trust verification cron job started - running every hour");
  }

  /**
   * Stop the cron job
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.isRunning = false;
      dualLogInfo("Booking trust verification cron job stopped");
    }
  }

  /**
   * Get the status of the cron service
   */
  getStatus(): {
    isRunning: boolean;
    nextRun?: string;
    cronExpression: string;
  } {
    return {
      isRunning: this.isRunning,
      nextRun: this.cronJob ? "Next hour at minute 0" : undefined,
      cronExpression: "0 * * * *" // Every hour at minute 0
    };
  }

  /**
   * Run the scheduled trust verification
   */
  private async runScheduledVerification(): Promise<void> {
    try {
      await dualLogInfo("Starting scheduled booking trust verification");
      
      const stats = await bookingTrustScheduler.runTrustScheduler();
      
      await dualLogInfo("Scheduled booking trust verification completed", {
        stats,
        scheduledRun: true,
        timestamp: new Date().toISOString(),
      });
      
      // Log summary if any verifications were performed
      if (stats.totalPropertiesChecked > 0) {
        await dualLogInfo(`Trust verification summary: ${stats.successfulVerifications}/${stats.totalPropertiesChecked} successful, ${stats.newlyTrusted} newly trusted properties`, {
          stats,
          duration: `${stats.totalRuntime}ms`,
        });
      }
    } catch (error) {
      await dualLogError(
        getBookingErrorDescription(BookingErrorType.UNKNOWN), 
        error, 
        {
          errorType: BookingErrorType.UNKNOWN,
          scheduledRun: true,
          timestamp: new Date().toISOString(),
        }
      );
    }
  }

  /**
   * Manually trigger the verification (for testing)
   */
  async runManual(): Promise<void> {
    await dualLogInfo("Manually triggering booking trust verification");
    await this.runScheduledVerification();
  }
}

// Export singleton instance
export const bookingTrustCron = new BookingTrustCronService();