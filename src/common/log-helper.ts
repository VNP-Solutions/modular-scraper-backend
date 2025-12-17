import { jobService } from "../services/job.service.js";
import { JobLogger } from "./logger.js";

// ANSI Color codes for console output
const COLORS = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',      // Info
  yellow: '\x1b[33m',     // Warning
  red: '\x1b[31m',        // Error
  green: '\x1b[32m',      // Success
  blue: '\x1b[34m',       // Debug
  magenta: '\x1b[35m',    // Job ID
  gray: '\x1b[90m',       // Thread ID
};

// Store the current job logger globally for the running job
let currentJobLogger: JobLogger | null = null;
let currentJobId: string | null = null;
let currentWorkerId: string | null = null;

/**
 * Initialize logging for a job
 */
export function initializeJobLogging(jobId: string): JobLogger {
  currentJobLogger = JobLogger.getInstance(jobId);
  currentJobId = jobId;
  return currentJobLogger;
}

/**
 * Set the current worker/thread ID for logging
 */
export function setCurrentWorkerId(workerId: string | null): void {
  currentWorkerId = workerId;
}

/**
 * Enhanced console.log that also writes to job log file
 */
export async function logInfo(message: string, metadata?: any): Promise<void> {
  const threadPrefix = currentWorkerId ? `${currentWorkerId} - ` : "";
  if (currentJobLogger) {
    await currentJobLogger.info(message, metadata);
  } else {
    console.log(
      `${threadPrefix}${message}`,
      metadata ? JSON.stringify(metadata) : ""
    );
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

  const threadPrefix = currentWorkerId ? `${currentWorkerId} - ` : "";
  if (currentJobLogger) {
    await currentJobLogger.error(message, errorDetails);
  } else {
    console.error(
      `${threadPrefix}${message}`,
      errorDetails ? JSON.stringify(errorDetails) : ""
    );
  }
}

/**
 * Enhanced console.warn that also writes to job log file
 */
export async function logWarn(message: string, metadata?: any): Promise<void> {
  const threadPrefix = currentWorkerId ? `${currentWorkerId} - ` : "";
  if (currentJobLogger) {
    await currentJobLogger.warn(message, metadata);
  } else {
    console.warn(
      `${threadPrefix}${message}`,
      metadata ? JSON.stringify(metadata) : ""
    );
  }
}

/**
 * Enhanced console.debug that also writes to job log file
 */
export async function logDebug(message: string, metadata?: any): Promise<void> {
  const threadPrefix = currentWorkerId ? `${currentWorkerId} - ` : "";
  if (currentJobLogger) {
    await currentJobLogger.debug(message, metadata);
  } else {
    console.debug(
      `${threadPrefix}${message}`,
      metadata ? JSON.stringify(metadata) : ""
    );
  }
}

/**
 * Finalize logging for a job and upload to S3
 */
export async function finalizeJobLogging(
  jobStatus: "success" | "failed" | "partial"
): Promise<string | null> {
  if (currentJobLogger && currentJobId) {
    try {
      const s3Url = await currentJobLogger.finalize(jobStatus);

      // Save the log URL to the job document
      if (s3Url) {
        await jobService.updateJobLogLink(currentJobId, s3Url);
        console.log(`Log URL saved to job ${currentJobId}: ${s3Url}`);
      }

      currentJobLogger = null; // Clear the reference
      currentJobId = null; // Clear the job ID
      return s3Url;
    } catch (error) {
      console.error(
        `Error finalizing job logging for job ${currentJobId}:`,
        error
      );
      currentJobLogger = null; // Clear the reference even on error
      currentJobId = null; // Clear the job ID even on error
      return null;
    }
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
 * Format log prefix with colors
 */
function formatLogPrefix(level: 'INFO' | 'WARN' | 'ERROR'): string {
  const timestamp = new Date().toISOString();
  const threadPart = currentWorkerId ? `${COLORS.gray}[${currentWorkerId}]${COLORS.reset}` : "";
  const jobPart = currentJobId ? `${COLORS.magenta}[Job:${currentJobId.slice(-8)}]${COLORS.reset}` : "";
  
  let levelColor = COLORS.cyan;
  if (level === 'WARN') levelColor = COLORS.yellow;
  if (level === 'ERROR') levelColor = COLORS.red;
  
  const levelPart = `${levelColor}[${level}]${COLORS.reset}`;
  
  return `${threadPart}${jobPart}${levelPart}`;
}

/**
 * Dual info logging - writes to both console AND file (if job logging is active)
 */
export async function dualLogInfo(
  message: string,
  metadata?: any
): Promise<void> {
  const prefix = formatLogPrefix('INFO');
  console.log(
    `${prefix} ${COLORS.cyan}${message}${COLORS.reset}`,
    metadata ? JSON.stringify(metadata) : ""
  );
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

  const prefix = formatLogPrefix('ERROR');
  console.error(
    `${prefix} ${COLORS.red}${message}${COLORS.reset}`,
    errorDetails ? JSON.stringify(errorDetails) : ""
  );
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
  const prefix = formatLogPrefix('WARN');
  console.warn(
    `${prefix} ${COLORS.yellow}${message}${COLORS.reset}`,
    metadata ? JSON.stringify(metadata) : ""
  );
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
  const threadPrefix = currentWorkerId ? `${currentWorkerId} - ` : "";
  console.debug(
    `${threadPrefix}${message}`,
    metadata ? JSON.stringify(metadata) : ""
  );
  if (currentJobLogger) {
    await currentJobLogger.debug(message, metadata);
  }
}
