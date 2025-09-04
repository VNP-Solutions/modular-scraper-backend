import { EventEmitter } from "events";

/**
 * Global singleton for notifying when OTP work is completed in a job
 * This allows scraping functions to signal the worker that OTP work is done
 */
class OtpCompletionNotifier extends EventEmitter {
  private static instance: OtpCompletionNotifier | null = null;

  private constructor() {
    super();
  }

  public static getInstance(): OtpCompletionNotifier {
    if (!OtpCompletionNotifier.instance) {
      OtpCompletionNotifier.instance = new OtpCompletionNotifier();
    }
    return OtpCompletionNotifier.instance;
  }

  /**
   * Notify that OTP work has been completed for a specific job
   */
  public notifyOtpCompleted(jobId: string): void {
    console.log(`OTP completion notification sent for job ${jobId}`);
    this.emit("otpCompleted", jobId);
  }

  /**
   * Register a listener for OTP completion events
   */
  public onOtpCompleted(callback: (jobId: string) => void): void {
    this.on("otpCompleted", callback);
  }

  /**
   * Remove OTP completion listener
   */
  public removeOtpCompletedListener(callback: (jobId: string) => void): void {
    this.removeListener("otpCompleted", callback);
  }

  /**
   * Remove all listeners (useful for cleanup)
   */
  public removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

// Export singleton instance
export const otpCompletionNotifier = OtpCompletionNotifier.getInstance();
