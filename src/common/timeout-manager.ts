import { jobService } from "../services/job.service.js";
import { dualLogWarn } from "./log-helper.js";

export interface TimeoutConfig {
  loading: number;
  selector: number;
}

export class TimeoutManager {
  private static instance: TimeoutManager;
  private jobTimeouts: Map<string, TimeoutConfig> = new Map();

  // Default fallback values if database lookup fails
  private readonly DEFAULT_LOADING_TIMEOUT = 30000;
  private readonly DEFAULT_SELECTOR_TIMEOUT = 10000;

  private constructor() {}

  public static getInstance(): TimeoutManager {
    if (!TimeoutManager.instance) {
      TimeoutManager.instance = new TimeoutManager();
    }
    return TimeoutManager.instance;
  }

  /**
   * Get timeout configuration for a specific job
   */
  async getTimeoutConfig(jobId?: string): Promise<TimeoutConfig> {
    if (!jobId) {
      return this.getDefaultTimeouts();
    }

    // Check cache first
    if (this.jobTimeouts.has(jobId)) {
      return this.jobTimeouts.get(jobId)!;
    }

    try {
      // Fetch from database
      const job = await jobService.getJobById(jobId);

      if (
        job &&
        job.job_backoff_length_loading &&
        job.job_backoff_length_selector
      ) {
        const config: TimeoutConfig = {
          loading: job.job_backoff_length_loading,
          selector: job.job_backoff_length_selector,
        };

        // Cache the configuration
        this.jobTimeouts.set(jobId, config);
        return config;
      } else {
        await dualLogWarn(
          `Job ${jobId} not found or missing timeout config, using defaults`,
          { jobId }
        );
        return this.getDefaultTimeouts();
      }
    } catch (error) {
      await dualLogWarn(
        `Failed to fetch timeout config for job ${jobId}, using defaults: ${error}`,
        { jobId, error: error instanceof Error ? error.message : error }
      );
      return this.getDefaultTimeouts();
    }
  }

  /**
   * Get loading timeout for a specific job
   */
  async getLoadingTimeout(jobId?: string): Promise<number> {
    const config = await this.getTimeoutConfig(jobId);
    return config.loading;
  }

  /**
   * Get selector timeout for a specific job
   */
  async getSelectorTimeout(jobId?: string): Promise<number> {
    const config = await this.getTimeoutConfig(jobId);
    return config.selector;
  }

  /**
   * Clear cached timeout for a job (useful when job is updated)
   */
  clearJobTimeout(jobId: string): void {
    this.jobTimeouts.delete(jobId);
  }

  /**
   * Clear all cached timeouts
   */
  clearAllTimeouts(): void {
    this.jobTimeouts.clear();
  }

  /**
   * Get default timeout configuration
   */
  private getDefaultTimeouts(): TimeoutConfig {
    return {
      loading: this.DEFAULT_LOADING_TIMEOUT,
      selector: this.DEFAULT_SELECTOR_TIMEOUT,
    };
  }

  /**
   * Update timeout configuration for a job in cache
   */
  updateJobTimeout(jobId: string, config: TimeoutConfig): void {
    this.jobTimeouts.set(jobId, config);
  }
}

// Export singleton instance
export const timeoutManager = TimeoutManager.getInstance();
