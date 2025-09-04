/**
 * Folder Cleanup Utility
 *
 * This module provides functionality to clean up downloads and import folders
 * when errors occur during the Agoda scraping process.
 *
 * Key Features:
 * - Cleans CSV files from downloads folder based on Agoda ID pattern
 * - Cleans CSV files from import folder based on property-agoda-id pattern
 * - Preserves .gitkeep files and other non-CSV files
 * - Provides detailed logging of cleanup operations
 * - Safe error handling to prevent cleanup failures from affecting main process
 *
 * Usage:
 * ```typescript
 * import { cleanupFoldersOnError } from './folder-cleanup.js';
 *
 * try {
 *   // Your scraping code here
 * } catch (error) {
 *   await cleanupFoldersOnError(agodaId, propertyName, jobId);
 *   throw error;
 * }
 * ```
 */

import fs from "fs";
import path from "path";
import { dualLogError, dualLogInfo } from "./log-helper.js";
import { timeManager } from "./time-manager.js";

/**
 * Options for folder cleanup
 */
export interface FolderCleanupOptions {
  agodaId?: string;
  propertyName?: string;
  jobId?: string;
  cleanDownloads?: boolean; // Default: true
  cleanImport?: boolean; // Default: true
  preserveGitkeep?: boolean; // Default: true
  dryRun?: boolean; // Default: false - if true, only logs what would be deleted
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  downloadsCleanedCount: number;
  importCleanedCount: number;
  errors: string[];
  totalFilesProcessed: number;
}

/**
 * Clean up downloads and import folders when errors occur
 * This is the main function to call during error handling
 */
export async function cleanupFoldersOnError(
  agodaId?: string,
  propertyName?: string,
  jobId?: string,
  options: Partial<FolderCleanupOptions> = {}
): Promise<CleanupResult> {
  const cleanupOptions: FolderCleanupOptions = {
    agodaId,
    propertyName,
    jobId,
    cleanDownloads: true,
    cleanImport: true,
    preserveGitkeep: true,
    dryRun: false,
    ...options,
  };

  try {
    await dualLogInfo("🧹 Starting error cleanup process for folders...", {
      jobId: cleanupOptions.jobId,
      agodaId: cleanupOptions.agodaId,
      propertyName: cleanupOptions.propertyName,
      timeSession: timeManager.getSessionInfo(),
    });

    const result = await performFolderCleanup(cleanupOptions);

    await dualLogInfo("✅ Error cleanup process completed", {
      jobId: cleanupOptions.jobId,
      downloadsCleanedCount: result.downloadsCleanedCount,
      importCleanedCount: result.importCleanedCount,
      totalFilesProcessed: result.totalFilesProcessed,
      errors: result.errors.length,
      timeSession: timeManager.getSessionInfo(),
    });

    return result;
  } catch (error: any) {
    await dualLogError("❌ Error during folder cleanup:", error.message, {
      jobId: cleanupOptions.jobId,
    });

    return {
      downloadsCleanedCount: 0,
      importCleanedCount: 0,
      errors: [error.message],
      totalFilesProcessed: 0,
    };
  }
}

/**
 * Perform the actual folder cleanup operations
 */
async function performFolderCleanup(
  options: FolderCleanupOptions
): Promise<CleanupResult> {
  const result: CleanupResult = {
    downloadsCleanedCount: 0,
    importCleanedCount: 0,
    errors: [],
    totalFilesProcessed: 0,
  };

  // Clean downloads folder
  if (options.cleanDownloads) {
    try {
      const downloadsResult = await cleanDownloadsFolder(options);
      result.downloadsCleanedCount = downloadsResult.cleanedCount;
      result.errors.push(...downloadsResult.errors);
      result.totalFilesProcessed += downloadsResult.totalProcessed;
    } catch (error: any) {
      result.errors.push(`Downloads cleanup error: ${error.message}`);
      await dualLogError("Error cleaning downloads folder:", error.message, {
        jobId: options.jobId,
      });
    }
  }

  // Clean import folder
  if (options.cleanImport) {
    try {
      const importResult = await cleanImportFolder(options);
      result.importCleanedCount = importResult.cleanedCount;
      result.errors.push(...importResult.errors);
      result.totalFilesProcessed += importResult.totalProcessed;
    } catch (error: any) {
      result.errors.push(`Import cleanup error: ${error.message}`);
      await dualLogError("Error cleaning import folder:", error.message, {
        jobId: options.jobId,
      });
    }
  }

  return result;
}

/**
 * Clean downloads folder - removes CSV files matching agodaId pattern
 * Supports both job-specific folders and main downloads folder
 * Pattern: {agodaId}_*.csv or {propertyName}-{agodaId}.csv
 */
async function cleanDownloadsFolder(
  options: FolderCleanupOptions
): Promise<{ cleanedCount: number; errors: string[]; totalProcessed: number }> {
  const result: {
    cleanedCount: number;
    errors: string[];
    totalProcessed: number;
  } = {
    cleanedCount: 0,
    errors: [],
    totalProcessed: 0,
  };

  try {
    const baseDownloadsDir = path.resolve(process.cwd(), "downloads");

    if (!fs.existsSync(baseDownloadsDir)) {
      await dualLogInfo(
        "Downloads directory does not exist, skipping cleanup",
        {
          jobId: options.jobId,
        }
      );
      return result;
    }

    // Clean ONLY job-specific folder if jobId is provided (for concurrent job safety)
    if (options.jobId) {
      const jobDownloadsDir = path.join(baseDownloadsDir, options.jobId);
      if (fs.existsSync(jobDownloadsDir)) {
        await dualLogInfo(
          `Cleaning job-specific downloads folder: ${jobDownloadsDir}`,
          { jobId: options.jobId }
        );

        const jobFolderResult = await cleanDownloadsFolderContent(
          jobDownloadsDir,
          options
        );
        result.cleanedCount += jobFolderResult.cleanedCount;
        result.errors.push(...jobFolderResult.errors);
        result.totalProcessed += jobFolderResult.totalProcessed;

        // Remove the entire job folder after cleanup (safe for concurrent jobs)
        try {
          fs.rmSync(jobDownloadsDir, { recursive: true, force: true });
          await dualLogInfo(`✅ Removed job folder: ${jobDownloadsDir}`, {
            jobId: options.jobId,
          });
        } catch (removeDirError: any) {
          await dualLogError(
            `Warning: Could not remove job folder: ${removeDirError.message}`,
            removeDirError,
            { jobId: options.jobId }
          );
        }
      } else {
        await dualLogInfo(
          `Job-specific downloads folder does not exist: ${jobDownloadsDir}`,
          { jobId: options.jobId }
        );
      }
    } else {
      // Only clean main downloads folder if no jobId (legacy mode)
      await dualLogInfo(
        "No jobId provided - cleaning main downloads folder (legacy mode)",
        { jobId: options.jobId }
      );

      const mainFolderResult = await cleanDownloadsFolderContent(
        baseDownloadsDir,
        options
      );
      result.cleanedCount += mainFolderResult.cleanedCount;
      result.errors.push(...mainFolderResult.errors);
      result.totalProcessed += mainFolderResult.totalProcessed;
    }

    return result;
  } catch (error: any) {
    result.errors.push(`Downloads folder cleanup error: ${error.message}`);
    throw error;
  }
}

/**
 * Clean contents of a specific downloads folder
 */
async function cleanDownloadsFolderContent(
  downloadsDir: string,
  options: FolderCleanupOptions
): Promise<{ cleanedCount: number; errors: string[]; totalProcessed: number }> {
  const result: {
    cleanedCount: number;
    errors: string[];
    totalProcessed: number;
  } = {
    cleanedCount: 0,
    errors: [],
    totalProcessed: 0,
  };

  try {
    const files = fs.readdirSync(downloadsDir);
    await dualLogInfo(
      `Found ${files.length} files in downloads directory: ${downloadsDir}`,
      {
        jobId: options.jobId,
      }
    );

    for (const file of files) {
      result.totalProcessed++;

      // Skip non-CSV files and .gitkeep files
      if (
        !file.endsWith(".csv") ||
        (options.preserveGitkeep && file.includes(".gitkeep"))
      ) {
        continue;
      }

      // If agodaId is provided, only clean files matching either pattern:
      // 1. Old pattern: {agodaId}_*.csv (e.g., "2456448_Agoda_Performance_...")
      // 2. New pattern: {propertyName}-{agodaId}.csv (e.g., "ac-hotel-arlington-national-landing-2456448.csv")
      if (options.agodaId) {
        const oldAgodaPattern = new RegExp(
          `^${escapeRegExp(options.agodaId)}_.*\\.csv$`,
          "i"
        );
        const newAgodaPattern = new RegExp(
          `.*-${escapeRegExp(options.agodaId)}\\.csv$`,
          "i"
        );

        if (!oldAgodaPattern.test(file) && !newAgodaPattern.test(file)) {
          continue;
        }
      }

      const filePath = path.join(downloadsDir, file);

      if (options.dryRun) {
        await dualLogInfo(`[DRY RUN] Would delete downloads file: ${file}`, {
          jobId: options.jobId,
        });
        result.cleanedCount++;
      } else {
        try {
          fs.unlinkSync(filePath);
          await dualLogInfo(`✅ Deleted downloads file: ${file}`, {
            jobId: options.jobId,
          });
          result.cleanedCount++;
        } catch (error: any) {
          const errorMsg = `Failed to delete downloads file ${file}: ${error.message}`;
          result.errors.push(errorMsg);
          await dualLogError(errorMsg, error, { jobId: options.jobId });
        }
      }
    }

    return result;
  } catch (error: any) {
    result.errors.push(`Downloads folder cleanup error: ${error.message}`);
    throw error;
  }
}

/**
 * Clean import folder - removes CSV files matching property-agoda-id pattern
 * Pattern: {propertyName}-{agodaId}.csv or any CSV containing agodaId
 */
async function cleanImportFolder(
  options: FolderCleanupOptions
): Promise<{ cleanedCount: number; errors: string[]; totalProcessed: number }> {
  const result: {
    cleanedCount: number;
    errors: string[];
    totalProcessed: number;
  } = {
    cleanedCount: 0,
    errors: [],
    totalProcessed: 0,
  };

  try {
    const importDir = path.resolve(process.cwd(), "import");

    if (!fs.existsSync(importDir)) {
      await dualLogInfo("Import directory does not exist, skipping cleanup", {
        jobId: options.jobId,
      });
      return result;
    }

    const files = fs.readdirSync(importDir);
    await dualLogInfo(`Found ${files.length} files in import directory`, {
      jobId: options.jobId,
    });

    for (const file of files) {
      result.totalProcessed++;

      // Skip non-CSV files and .gitkeep files
      if (
        !file.endsWith(".csv") ||
        (options.preserveGitkeep && file.includes(".gitkeep"))
      ) {
        continue;
      }

      let shouldDelete = false;

      // If agodaId is provided, check if file contains it
      if (options.agodaId && file.includes(options.agodaId)) {
        shouldDelete = true;
      }

      // If propertyName is provided, check for property-agoda pattern
      if (options.propertyName && options.agodaId) {
        const propertyPattern = new RegExp(
          `^${escapeRegExp(options.propertyName)}-${escapeRegExp(
            options.agodaId
          )}\\.csv$`,
          "i"
        );
        if (propertyPattern.test(file)) {
          shouldDelete = true;
        }
      }

      // If no specific criteria provided, clean any CSV that looks like property-agoda format
      if (
        !options.agodaId &&
        !options.propertyName &&
        file.includes("-") &&
        file.endsWith(".csv")
      ) {
        shouldDelete = true;
      }

      if (!shouldDelete) {
        continue;
      }

      const filePath = path.join(importDir, file);

      if (options.dryRun) {
        await dualLogInfo(`[DRY RUN] Would delete import file: ${file}`, {
          jobId: options.jobId,
        });
        result.cleanedCount++;
      } else {
        try {
          fs.unlinkSync(filePath);
          await dualLogInfo(`✅ Deleted import file: ${file}`, {
            jobId: options.jobId,
          });
          result.cleanedCount++;
        } catch (error: any) {
          const errorMsg = `Failed to delete import file ${file}: ${error.message}`;
          result.errors.push(errorMsg);
          await dualLogError(errorMsg, error, { jobId: options.jobId });
        }
      }
    }

    return result;
  } catch (error: any) {
    result.errors.push(`Import folder cleanup error: ${error.message}`);
    throw error;
  }
}

/**
 * Extract agodaId and propertyName from CSV file path
 * Supports formats like: property-name-agodaId.csv or agodaId_something.csv
 */
export function extractCleanupInfoFromPath(filePath: string): {
  agodaId?: string;
  propertyName?: string;
} {
  try {
    const fileName = path.basename(filePath, ".csv");

    // Try property-name-agodaId format
    if (fileName.includes("-")) {
      const parts = fileName.split("-");
      if (parts.length >= 2) {
        const agodaId = parts[parts.length - 1]; // Last part should be agoda ID
        const propertyName = parts.slice(0, -1).join("-"); // Everything before last part
        return { agodaId, propertyName };
      }
    }

    // Try agodaId_something format
    if (fileName.includes("_")) {
      const parts = fileName.split("_");
      if (parts.length >= 2) {
        const agodaId = parts[0]; // First part should be agoda ID
        return { agodaId };
      }
    }

    return {};
  } catch (error) {
    return {};
  }
}

/**
 * Auto-detect cleanup parameters from existing files in folders
 */
export async function autoDetectCleanupParams(jobId?: string): Promise<{
  agodaId?: string;
  propertyName?: string;
}> {
  try {
    // Check import folder first (more structured naming)
    const importDir = path.resolve(process.cwd(), "import");
    if (fs.existsSync(importDir)) {
      const files = fs.readdirSync(importDir);
      const csvFile = files.find(
        (file) =>
          file.endsWith(".csv") &&
          !file.includes(".gitkeep") &&
          file.includes("-")
      );

      if (csvFile) {
        const info = extractCleanupInfoFromPath(path.join(importDir, csvFile));
        if (info.agodaId) {
          await dualLogInfo(
            `Auto-detected cleanup params from import: ${csvFile}`,
            {
              jobId,
              agodaId: info.agodaId,
              propertyName: info.propertyName,
            }
          );
          return info;
        }
      }
    }

    // Check downloads folder as fallback
    const downloadsDir = path.resolve(process.cwd(), "downloads");
    if (fs.existsSync(downloadsDir)) {
      const files = fs.readdirSync(downloadsDir);
      const csvFile = files.find(
        (file) =>
          file.endsWith(".csv") &&
          !file.includes(".gitkeep") &&
          file.includes("_")
      );

      if (csvFile) {
        const info = extractCleanupInfoFromPath(
          path.join(downloadsDir, csvFile)
        );
        if (info.agodaId) {
          await dualLogInfo(
            `Auto-detected cleanup params from downloads: ${csvFile}`,
            {
              jobId,
              agodaId: info.agodaId,
            }
          );
          return info;
        }
      }
    }

    return {};
  } catch (error: any) {
    await dualLogError(
      "Error auto-detecting cleanup parameters:",
      error.message,
      {
        jobId,
      }
    );
    return {};
  }
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean all CSV files from both folders (emergency cleanup)
 */
export async function emergencyCleanupAllCsvFiles(
  jobId?: string
): Promise<CleanupResult> {
  await dualLogInfo("🚨 Starting emergency cleanup of all CSV files...", {
    jobId,
    timeSession: timeManager.getSessionInfo(),
  });

  return cleanupFoldersOnError(undefined, undefined, jobId, {
    cleanDownloads: true,
    cleanImport: true,
    preserveGitkeep: true,
  });
}
