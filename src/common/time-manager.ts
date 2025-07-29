import dotenv from "dotenv";
import { autoRefreshToken, getTokenRefreshInfo } from "./load-token.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";
import { emailNotifier } from "./email-notifier.js";

dotenv.config();

export interface TimeSession {
  startTime: Date;
  maxDurationMs: number;
  bufferMs: number;
  jobId?: string;
}

export class TimeManager {
  private static instance: TimeManager;
  private currentSession: TimeSession | null = null;

  private constructor() {}

  public static getInstance(): TimeManager {
    if (!TimeManager.instance) {
      TimeManager.instance = new TimeManager();
    }
    return TimeManager.instance;
  }

  /**
   * Auto-refresh Google OAuth2 token after time session events
   */
  private async autoRefreshGoogleToken(): Promise<void> {
    try {
      await dualLogInfo(
        "Starting automatic Google OAuth2 token refresh after time session event",
        {
          tokenInfo: getTokenRefreshInfo(),
        }
      );

      const refreshSuccess = await autoRefreshToken();

      if (refreshSuccess) {
        await dualLogInfo(
          "Automatic Google OAuth2 token refresh completed successfully",
          {
            tokenInfo: getTokenRefreshInfo(),
          }
        );
      } else {
        await dualLogWarn(
          "Automatic Google OAuth2 token refresh was not successful",
          {
            tokenInfo: getTokenRefreshInfo(),
          }
        );
        
        // Send email notification for token refresh failure
        if (this.currentSession?.jobId) {
          try {
            await emailNotifier.notifyJobError(
              this.currentSession.jobId,
              "Google OAuth2 token refresh was not successful",
              new Error("Token refresh failed"),
              {
                stage: "oauth_token_refresh_failure",
                progressPercentage: 0,
              }
            );
          } catch (emailError) {
            await dualLogError("Failed to send token refresh failure notification:", emailError);
          }
        }
      }
    } catch (error: any) {
      await dualLogError(
        "Error during automatic Google OAuth2 token refresh:",
        error,
        {
          tokenInfo: getTokenRefreshInfo(),
        }
      );
      
      // Send email notification for token refresh error
      if (this.currentSession?.jobId) {
        try {
          await emailNotifier.notifyJobError(
            this.currentSession.jobId,
            `Google OAuth2 token refresh error: ${error?.message || "Token refresh error"}`,
            error,
            {
              stage: "oauth_token_refresh_error",
              progressPercentage: 0,
            }
          );
        } catch (emailError) {
          await dualLogError("Failed to send token refresh error notification:", emailError);
        }
      }
    }
  }

  /**
   * Start a new time session for browser management
   */
  async startSession(jobId?: string): Promise<void> {
    // Get time limit from environment, default to 1 hour
    const timeLimitStr = process.env.BROWSER_TIME_LIMIT || "1h";

    // Parse the time limit with units support
    const maxDurationMs = this.parseTimeLimit(timeLimitStr);

    // Buffer time (5 minutes less than the limit)
    const bufferMs = 5 * 60 * 1000; // 5 minutes in milliseconds

    this.currentSession = {
      startTime: new Date(),
      maxDurationMs,
      bufferMs,
      jobId,
    };

    await dualLogInfo(
      `Started new time session. Max duration: ${timeLimitStr}, Buffer: 5m`,
      {
        jobId,
        timeLimitStr,
        maxDurationMs,
        startTime: this.currentSession.startTime.toISOString(),
        effectiveTimeLimit: (maxDurationMs - bufferMs) / 1000 / 60, // in minutes
      }
    );
  }

  /**
   * Check if the current session has exceeded the time limit
   */
  async shouldRestartBrowser(): Promise<boolean> {
    if (!this.currentSession) {
      await dualLogWarn("No active time session found", {});
      return false;
    }

    const currentTime = new Date();
    const elapsedMs =
      currentTime.getTime() - this.currentSession.startTime.getTime();
    const effectiveLimit =
      this.currentSession.maxDurationMs - this.currentSession.bufferMs;

    const shouldRestart = elapsedMs >= effectiveLimit;

    if (shouldRestart) {
      await dualLogInfo(
        `Time limit reached. Elapsed: ${Math.round(
          elapsedMs / 1000 / 60
        )}m, Limit: ${Math.round(effectiveLimit / 1000 / 60)}m`,
        {
          jobId: this.currentSession.jobId,
          elapsedMinutes: Math.round(elapsedMs / 1000 / 60),
          limitMinutes: Math.round(effectiveLimit / 1000 / 60),
        }
      );
    }

    return shouldRestart;
  }

  /**
   * Get remaining time in the current session
   */
  getRemainingTime(): number | null {
    if (!this.currentSession) {
      return null;
    }

    const currentTime = new Date();
    const elapsedMs =
      currentTime.getTime() - this.currentSession.startTime.getTime();
    const effectiveLimit =
      this.currentSession.maxDurationMs - this.currentSession.bufferMs;

    return Math.max(0, effectiveLimit - elapsedMs);
  }

  /**
   * Get elapsed time in the current session
   */
  getElapsedTime(): number | null {
    if (!this.currentSession) {
      return null;
    }

    const currentTime = new Date();
    return currentTime.getTime() - this.currentSession.startTime.getTime();
  }

  /**
   * End the current session with automatic Google OAuth2 token refresh
   */
  async endSession(): Promise<void> {
    if (this.currentSession) {
      const elapsedMs = this.getElapsedTime() || 0;
      await dualLogInfo(
        `Ending time session. Total duration: ${Math.round(
          elapsedMs / 1000 / 60
        )}m`,
        {
          jobId: this.currentSession.jobId,
          totalMinutes: Math.round(elapsedMs / 1000 / 60),
        }
      );

      // Auto-refresh Google OAuth2 token before ending the session
      await this.autoRefreshGoogleToken();

      this.currentSession = null;

      await dualLogInfo(
        "Time session ended successfully with Google OAuth2 token refresh",
        {}
      );
    }
  }

  /**
   * Reset the session start time (useful after browser restart) with automatic Google OAuth2 token refresh
   */
  async resetSession(jobId?: string): Promise<void> {
    if (this.currentSession) {
      this.currentSession.startTime = new Date();
      this.currentSession.jobId = jobId || this.currentSession.jobId;

      await dualLogInfo("Resetting time session start time", {
        jobId: this.currentSession.jobId,
        newStartTime: this.currentSession.startTime.toISOString(),
      });
    } else {
      // If no session exists, start a new one
      await this.startSession(jobId);
      return; // startSession doesn't include token refresh by default
    }

    // Auto-refresh Google OAuth2 token when resetting session
    await this.autoRefreshGoogleToken();

    await dualLogInfo(
      "Time session reset completed with Google OAuth2 token refresh",
      {
        jobId: this.currentSession?.jobId,
      }
    );
  }

  /**
   * Get session info for logging
   */
  getSessionInfo(): any {
    if (!this.currentSession) {
      return null;
    }

    const elapsedMs = this.getElapsedTime() || 0;
    const remainingMs = this.getRemainingTime() || 0;

    return {
      jobId: this.currentSession.jobId,
      startTime: this.currentSession.startTime.toISOString(),
      elapsedMinutes: Math.round(elapsedMs / 1000 / 60),
      remainingMinutes: Math.round(remainingMs / 1000 / 60),
      maxDurationMinutes: Math.round(
        this.currentSession.maxDurationMs / 1000 / 60
      ),
      bufferMinutes: Math.round(this.currentSession.bufferMs / 1000 / 60),
    };
  }

  /**
   * Get comprehensive session and Google OAuth2 token info for logging
   */
  getSessionAndTokenInfo(): any {
    return {
      session: this.getSessionInfo(),
      token: getTokenRefreshInfo(),
    };
  }

  /**
   * Parse time limit string with support for different units
   * Supports: 10m (minutes), 6h (hours), 2d (days), or plain numbers (treated as hours)
   */
  private parseTimeLimit(timeLimitStr: string): number {
    const trimmed = timeLimitStr.trim().toLowerCase();

    // Check if it's just a number (backward compatibility - treat as hours)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const hours = parseFloat(trimmed);
      return hours * 60 * 60 * 1000; // Convert to milliseconds
    }

    // Parse with units
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([mhd])$/);

    if (!match) {
      dualLogWarn(
        `Invalid time format: ${timeLimitStr}. Using default 1 hour.`,
        {}
      );
      return 60 * 60 * 1000; // Default to 1 hour
    }

    const value = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
      case "m": // minutes
        return value * 60 * 1000;
      case "h": // hours
        return value * 60 * 60 * 1000;
      case "d": // days
        return value * 24 * 60 * 60 * 1000;
      default:
        dualLogWarn(`Unknown time unit: ${unit}. Using default 1 hour.`, {});
        return 60 * 60 * 1000; // Default to 1 hour
    }
  }

  /**
   * Format milliseconds to human-readable time string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else {
      return `${minutes}m`;
    }
  }
}

// Export singleton instance
export const timeManager = TimeManager.getInstance();
