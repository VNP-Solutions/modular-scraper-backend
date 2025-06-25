import { JobLogger } from "./logger.js";

// Store the current job logger globally for the running job
let currentJobLogger: JobLogger | null = null;

/**
 * Initialize logging for a job
 */
export function initializeJobLogging(jobId: string): JobLogger {
  currentJobLogger = JobLogger.getInstance(jobId);
  return currentJobLogger;
}

/**
 * Enhanced console.log that also writes to job log file
 */
export async function logInfo(message: string, metadata?: any): Promise<void> {
  if (currentJobLogger) {
    await currentJobLogger.info(message, metadata);
  } else {
    console.log(message, metadata ? JSON.stringify(metadata) : "");
  }
}

/**
 * Enhanced console.error that also writes to job log file
 */
export async function logError(
  message: string,
  error?: any,
  metadata?: any
): Promise<void> {
  const errorDetails = error
    ? {
        error: error.message || error,
        stack: error.stack || "",
        ...metadata,
      }
    : metadata;

  if (currentJobLogger) {
    await currentJobLogger.error(message, errorDetails);
  } else {
    console.error(message, errorDetails ? JSON.stringify(errorDetails) : "");
  }
}

/**
 * Enhanced console.warn that also writes to job log file
 */
export async function logWarn(message: string, metadata?: any): Promise<void> {
  if (currentJobLogger) {
    await currentJobLogger.warn(message, metadata);
  } else {
    console.warn(message, metadata ? JSON.stringify(metadata) : "");
  }
}

/**
 * Enhanced console.debug that also writes to job log file
 */
export async function logDebug(message: string, metadata?: any): Promise<void> {
  if (currentJobLogger) {
    await currentJobLogger.debug(message, metadata);
  } else {
    console.debug(message, metadata ? JSON.stringify(metadata) : "");
  }
}

/**
 * Finalize logging for a job and upload to S3
 */
export async function finalizeJobLogging(
  jobStatus: "success" | "failed" | "partial"
): Promise<string | null> {
  if (currentJobLogger) {
    const s3Url = await currentJobLogger.finalize(jobStatus);
    currentJobLogger = null; // Clear the reference
    return s3Url;
  }
  return null;
}

/**
 * Get current job logger
 */
export function getCurrentJobLogger(): JobLogger | null {
  return currentJobLogger;
}

/**
 * Check if job logging is active
 */
export function isJobLoggingActive(): boolean {
  return currentJobLogger !== null;
}

// === DUAL LOGGING FUNCTIONS ===
// These functions automatically handle both console and file logging

/**
 * Dual info logging - writes to both console AND file (if job logging is active)
 */
export async function dualLogInfo(
  message: string,
  metadata?: any
): Promise<void> {
  console.log(message, metadata ? JSON.stringify(metadata) : "");
  if (currentJobLogger) {
    await currentJobLogger.info(message, metadata);
  }
}

/**
 * Dual error logging - writes to both console AND file (if job logging is active)
 */
export async function dualLogError(
  message: string,
  error?: any,
  metadata?: any
): Promise<void> {
  const errorDetails = error
    ? {
        error: error.message || error,
        stack: error.stack || "",
        ...metadata,
      }
    : metadata;

  console.error(message, errorDetails ? JSON.stringify(errorDetails) : "");
  if (currentJobLogger) {
    await currentJobLogger.error(message, errorDetails);
  }
}

/**
 * Dual warn logging - writes to both console AND file (if job logging is active)
 */
export async function dualLogWarn(
  message: string,
  metadata?: any
): Promise<void> {
  console.warn(message, metadata ? JSON.stringify(metadata) : "");
  if (currentJobLogger) {
    await currentJobLogger.warn(message, metadata);
  }
}

/**
 * Dual debug logging - writes to both console AND file (if job logging is active)
 */
export async function dualLogDebug(
  message: string,
  metadata?: any
): Promise<void> {
  console.debug(message, metadata ? JSON.stringify(metadata) : "");
  if (currentJobLogger) {
    await currentJobLogger.debug(message, metadata);
  }
}
