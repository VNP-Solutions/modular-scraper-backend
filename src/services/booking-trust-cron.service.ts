import cron from "node-cron";
import { bookingTrustScheduler } from "./booking-trust-scheduler.service.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import { BookingErrorType, getBookingErrorDescription } from "../common/booking-error-types.js";

enum ScheduleType {
  INTERVAL = 'interval',
  CRON = 'cron',
  SPECIFIC = 'specific'
}

enum TimeUnit {
  MINUTES = 'minutes',
  HOURS = 'hours',
  DAYS = 'days',
  WEEKS = 'weeks'
}
interface CronConfig {
  enabled: boolean;
  schedule: {
    type: ScheduleType;
    value: string | number | string[];
    unit?: TimeUnit;
  };
  timezone?: string;
}

interface CronStatus {
  isRunning: boolean;
  isEnabled: boolean;
  currentConfig: CronConfig;
  nextRun?: string;
  lastRun?: string;
}

export class BookingTrustCronService {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  // By default run every hour
  private config: CronConfig = {
    enabled: true,
    schedule: {
      type: ScheduleType.INTERVAL,
      value: 1,
      unit: TimeUnit.HOURS
    },
    timezone: 'UTC'
  };

  /**
   * Configure the cron job
   */
  configure(newConfig: CronConfig): boolean {
    // Validate configuration
    if (!this.validateConfig(newConfig)) {
      throw new Error("Invalid configuration");
    }

    this.config = { ...this.config, ...newConfig };
    
    // Restart cron job if it's running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
    
    dualLogInfo("Cron configuration updated", { config: this.config });
    return true;
  }

  /**
   * Get current configuration
   */
  getConfiguration(): CronConfig {
    return { ...this.config };
  }

  /**
   * Start the hourly cron job for booking trust verification
   */
  start(): void {
    if (this.cronJob) {
      dualLogInfo("Booking trust cron job is already running");
      return;
    }

    if (!this.config.enabled) {
      dualLogInfo("Booking trust cron job is disabled");
      return;
    }

    const cronExpression = this.generateCronExpression();

    // Run cron according to configuration
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.runScheduledVerification();
    }, {
      scheduled: true,
      timezone: this.config.timezone || "UTC"
    });

    this.isRunning = true;
    dualLogInfo(`Booking trust verification cron job started - schedule: ${cronExpression}`);
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
  getStatus(): CronStatus {
    return {
      isRunning: this.isRunning,
      isEnabled: this.config.enabled,
      nextRun: this.cronJob ? "Next hour at minute 0" : undefined,
      currentConfig: this.getConfiguration(),
    };
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: CronConfig): boolean {
    // Validate schedule type
    if (!Object.values(ScheduleType).includes(config.schedule.type)) {
      return false;
    }

    // Validate interval configuration
    if (config.schedule.type === ScheduleType.INTERVAL) {
      if (typeof config.schedule.value !== 'number' || config.schedule.value < 1) {
        return false;
      }
      if (!config.schedule.unit || !Object.values(TimeUnit).includes(config.schedule.unit)) {
        return false;
      }
      // Prevent too frequent runs (minimum 5 minutes)
      if (config.schedule.value < 5 && config.schedule.unit === TimeUnit.MINUTES) {
        return false;
      }
    }

    // Validate cron expression
    if (config.schedule.type === ScheduleType.CRON) {
      if (typeof config.schedule.value !== 'string' || !cron.validate(config.schedule.value)) {
        return false;
      }
    }

    // Validate specific times
    if (config.schedule.type === ScheduleType.SPECIFIC) {
      if (!Array.isArray(config.schedule.value) || config.schedule.value.length === 0) {
        return false;
      }
      // Validate time format (HH:MM)
      for (const time of config.schedule.value) {
        if (typeof time !== 'string' || !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Generate cron expression from configuration
   */
  private generateCronExpression(): string {
    const { type, value, unit } = this.config.schedule;

    switch (type) {
      case ScheduleType.INTERVAL:
        return this.intervalToCron(value as number, unit || TimeUnit.HOURS);
      
      case ScheduleType.CRON:
        return value as string;
      
      case ScheduleType.SPECIFIC:
        return this.specificTimesToCron(value as string[]);
      
      default:
        return "0 * * * *"; // Default: every hour
    }
  }

  /**
   * Convert interval to cron expression
   */
  private intervalToCron(value: number, unit: TimeUnit): string {
    switch (unit) {
      case TimeUnit.MINUTES:
        return `*/${value} * * * *`;
      case TimeUnit.HOURS:
        return `0 */${value} * * *`;
      case TimeUnit.DAYS:
        return `0 0 */${value} * *`;
      case TimeUnit.WEEKS:
        return `0 0 * * ${value}`;
      default:
        return "0 * * * *";
    }
  }

  /**
   * Convert specific times to cron expression
   */
  private specificTimesToCron(times: string[]): string {
    // For multiple specific times, we need to create multiple cron jobs
    // I'll use the first time and log a warning
    if (times.length > 1) {
      dualLogInfo("Multiple specific times provided, using first time", { times });
    }
    
    const time = times[0];
    const [hour, minute] = time.split(':').map(Number);
    return `${minute} ${hour} * * *`;
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