import fs from "fs";
import path from "path";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { timeManager } from "../../common/time-manager.js";
import {
  getStandardFilePaths,
  checkAndDeleteExistingFile,
} from "./file-naming.js";

/**
 * Standardized error cleanup utilities for Agoda scraping
 * Uses jobId-only approach for consistent cleanup across all error scenarios
 */

/**
 * Result of standardized cleanup operation
 */
export interface StandardizedCleanupResult {
  downloadFilesCleanedCount: number;
  exportFilesCleanedCount: number;
  foldersRemovedCount: number;
  errors: string[];
  totalFilesProcessed: number;
}

/**
 * Main standardized cleanup function for error handling
 * Uses jobId-only approach - much simpler and more reliable than old method
 */
export async function cleanupOnError(
  jobId?: string,
  additionalContext?: {
    agodaId?: string;
    propertyName?: string;
    operation?: string;
  }
): Promise<StandardizedCleanupResult> {
  const result: StandardizedCleanupResult = {
    downloadFilesCleanedCount: 0,
    exportFilesCleanedCount: 0,
    foldersRemovedCount: 0,
    errors: [],
    totalFilesProcessed: 0,
  };

  try {
    await dualLogInfo("🧹 Starting standardized error cleanup process...", {
      jobId,
      operation: additionalContext?.operation || "unknown",
      timeSession: timeManager.getSessionInfo(),
    });

    if (!jobId) {
      await dualLogInfo(
        "⚠️ No jobId provided for cleanup - performing legacy cleanup if possible",
        { additionalContext }
      );

      // Fallback to legacy cleanup if agodaId is available
      if (additionalContext?.agodaId) {
        return await performLegacyCleanup(
          additionalContext.agodaId,
          additionalContext.propertyName
        );
      }

      result.errors.push(
        "No jobId provided and no fallback parameters available"
      );
      return result;
    }

    // Get standardized file paths
    const standardPaths = getStandardFilePaths(jobId);

    // Clean download files and folders
    const downloadResult = await cleanupStandardizedDownloads(
      standardPaths.downloadDir,
      standardPaths.downloadFilePath,
      jobId
    );
    result.downloadFilesCleanedCount = downloadResult.cleanedCount;
    result.errors.push(...downloadResult.errors);
    result.totalFilesProcessed += downloadResult.totalProcessed;

    // Clean export files and folders
    const exportResult = await cleanupStandardizedExports(
      standardPaths.exportDir,
      standardPaths.exportFilePath,
      jobId
    );
    result.exportFilesCleanedCount = exportResult.cleanedCount;
    result.errors.push(...exportResult.errors);
    result.totalFilesProcessed += exportResult.totalProcessed;

    // Count removed folders
    result.foldersRemovedCount =
      downloadResult.foldersRemoved + exportResult.foldersRemoved;

    await dualLogInfo("✅ Standardized error cleanup completed", {
      jobId,
      downloadFilesCleanedCount: result.downloadFilesCleanedCount,
      exportFilesCleanedCount: result.exportFilesCleanedCount,
      foldersRemovedCount: result.foldersRemovedCount,
      totalFilesProcessed: result.totalFilesProcessed,
      errors: result.errors.length,
      timeSession: timeManager.getSessionInfo(),
    });

    return result;
  } catch (error: any) {
    await dualLogError("❌ Error during standardized cleanup:", error.message, {
      jobId,
    });

    result.errors.push(`Cleanup error: ${error.message}`);
    return result;
  }
}

/**
 * Clean standardized download files and folders
 */
async function cleanupStandardizedDownloads(
  downloadDir: string,
  downloadFilePath: string,
  jobId: string
): Promise<{
  cleanedCount: number;
  errors: string[];
  totalProcessed: number;
  foldersRemoved: number;
}> {
  const result: {
    cleanedCount: number;
    errors: string[];
    totalProcessed: number;
    foldersRemoved: number;
  } = {
    cleanedCount: 0,
    errors: [],
    totalProcessed: 0,
    foldersRemoved: 0,
  };

  try {
    if (fs.existsSync(downloadDir)) {
      await dualLogInfo(
        `Cleaning standardized download directory: ${downloadDir}`,
        {
          jobId,
        }
      );

      // Clean the specific download file
      if (fs.existsSync(downloadFilePath)) {
        try {
          await checkAndDeleteExistingFile(downloadFilePath, jobId);
          result.cleanedCount++;
          result.totalProcessed++;
        } catch (fileError: any) {
          result.errors.push(
            `Failed to delete download file: ${fileError.message || fileError}`
          );
        }
      }

      // Clean any other CSV files in the directory (legacy files)
      const files = fs.readdirSync(downloadDir);
      for (const file of files) {
        if (file.endsWith(".csv") && !file.includes(".gitkeep")) {
          const filePath = path.join(downloadDir, file);
          try {
            fs.unlinkSync(filePath);
            result.cleanedCount++;
            result.totalProcessed++;
            await dualLogInfo(`Cleaned legacy download file: ${file}`, {
              jobId,
            });
          } catch (fileError: any) {
            result.errors.push(
              `Failed to delete legacy file ${file}: ${
                fileError.message || fileError
              }`
            );
          }
        }
      }

      // Remove the entire job-specific download directory
      try {
        fs.rmSync(downloadDir, { recursive: true, force: true });
        result.foldersRemoved++;
        await dualLogInfo(`✅ Removed download directory: ${downloadDir}`, {
          jobId,
        });
      } catch (dirError: any) {
        result.errors.push(
          `Failed to remove download directory: ${dirError.message || dirError}`
        );
      }
    } else {
      await dualLogInfo(`Download directory does not exist: ${downloadDir}`, {
        jobId,
      });
    }

    return result;
  } catch (error: any) {
    result.errors.push(`Download cleanup error: ${error.message}`);
    await dualLogError("Error cleaning downloads:", error.message, { jobId });
    return result;
  }
}

/**
 * Clean standardized export files and folders
 */
async function cleanupStandardizedExports(
  exportDir: string,
  exportFilePath: string,
  jobId: string
): Promise<{
  cleanedCount: number;
  errors: string[];
  totalProcessed: number;
  foldersRemoved: number;
}> {
  const result: {
    cleanedCount: number;
    errors: string[];
    totalProcessed: number;
    foldersRemoved: number;
  } = {
    cleanedCount: 0,
    errors: [],
    totalProcessed: 0,
    foldersRemoved: 0,
  };

  try {
    if (fs.existsSync(exportDir)) {
      await dualLogInfo(
        `Cleaning standardized export directory: ${exportDir}`,
        {
          jobId,
        }
      );

      // Clean the specific export file
      if (fs.existsSync(exportFilePath)) {
        try {
          await checkAndDeleteExistingFile(exportFilePath, jobId);
          result.cleanedCount++;
          result.totalProcessed++;
        } catch (fileError: any) {
          result.errors.push(
            `Failed to delete export file: ${fileError.message || fileError}`
          );
        }
      }

      // Clean any other CSV files in the directory (legacy files)
      const files = fs.readdirSync(exportDir);
      for (const file of files) {
        if (file.endsWith(".csv") && !file.includes(".gitkeep")) {
          const filePath = path.join(exportDir, file);
          try {
            fs.unlinkSync(filePath);
            result.cleanedCount++;
            result.totalProcessed++;
            await dualLogInfo(`Cleaned legacy export file: ${file}`, { jobId });
          } catch (fileError: any) {
            result.errors.push(
              `Failed to delete legacy file ${file}: ${
                fileError.message || fileError
              }`
            );
          }
        }
      }

      // Remove the entire job-specific export directory
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
        result.foldersRemoved++;
        await dualLogInfo(`✅ Removed export directory: ${exportDir}`, {
          jobId,
        });
      } catch (dirError: any) {
        result.errors.push(
          `Failed to remove export directory: ${dirError.message || dirError}`
        );
      }
    } else {
      await dualLogInfo(`Export directory does not exist: ${exportDir}`, {
        jobId,
      });
    }

    return result;
  } catch (error: any) {
    result.errors.push(`Export cleanup error: ${error.message}`);
    await dualLogError("Error cleaning exports:", error.message, { jobId });
    return result;
  }
}

/**
 * Legacy cleanup function for backward compatibility
 * Only used when jobId is not available but agodaId is provided
 */
async function performLegacyCleanup(
  agodaId: string,
  propertyName?: string
): Promise<StandardizedCleanupResult> {
  const result: StandardizedCleanupResult = {
    downloadFilesCleanedCount: 0,
    exportFilesCleanedCount: 0,
    foldersRemovedCount: 0,
    errors: [],
    totalFilesProcessed: 0,
  };

  try {
    await dualLogInfo("🔄 Performing legacy cleanup (agodaId-based)", {
      agodaId,
      propertyName,
    });

    // Clean downloads folder for legacy patterns
    const downloadsDir = path.resolve(process.cwd(), "downloads");
    if (fs.existsSync(downloadsDir)) {
      const downloadFiles = fs.readdirSync(downloadsDir);
      const oldDownloadCsvPattern = new RegExp(`^${agodaId}_.*\\.csv$`, "i");
      const newDownloadCsvPattern = new RegExp(`.*-${agodaId}\\.csv$`, "i");

      for (const file of downloadFiles) {
        if (
          file.endsWith(".csv") &&
          !file.includes(".gitkeep") &&
          (oldDownloadCsvPattern.test(file) || newDownloadCsvPattern.test(file))
        ) {
          const filePath = path.join(downloadsDir, file);
          try {
            fs.unlinkSync(filePath);
            result.downloadFilesCleanedCount++;
            result.totalFilesProcessed++;
            await dualLogInfo(`Legacy: Deleted download file: ${file}`);
          } catch (error: any) {
            result.errors.push(
              `Failed to delete legacy download file ${file}: ${
                error.message || error
              }`
            );
          }
        }
      }
    }

    // Clean import folder for legacy patterns
    const importDir = path.resolve(process.cwd(), "import");
    if (fs.existsSync(importDir)) {
      const importFiles = fs.readdirSync(importDir);

      for (const file of importFiles) {
        if (file.endsWith(".csv") && !file.includes(".gitkeep")) {
          if (propertyName) {
            const expectedFileName = `${propertyName
              .toLowerCase()
              .replace(/[^\w\s-]/g, "")
              .replace(/\s+/g, "-")}-${agodaId}.csv`;
            if (file.toLowerCase() === expectedFileName.toLowerCase()) {
              const filePath = path.join(importDir, file);
              try {
                fs.unlinkSync(filePath);
                result.exportFilesCleanedCount++;
                result.totalFilesProcessed++;
                await dualLogInfo(`Legacy: Deleted import file: ${file}`);
              } catch (error: any) {
                result.errors.push(
                  `Failed to delete legacy import file ${file}: ${
                    error.message || error
                  }`
                );
              }
            }
          } else {
            const agodaPattern = new RegExp(`.*-${agodaId}\\.csv$`, "i");
            if (agodaPattern.test(file)) {
              const filePath = path.join(importDir, file);
              try {
                fs.unlinkSync(filePath);
                result.exportFilesCleanedCount++;
                result.totalFilesProcessed++;
                await dualLogInfo(`Legacy: Deleted import file: ${file}`);
              } catch (error: any) {
                result.errors.push(
                  `Failed to delete legacy import file ${file}: ${
                    error.message || error
                  }`
                );
              }
            }
          }
        }
      }
    }

    await dualLogInfo("✅ Legacy cleanup completed", {
      downloadFilesCleanedCount: result.downloadFilesCleanedCount,
      exportFilesCleanedCount: result.exportFilesCleanedCount,
      totalFilesProcessed: result.totalFilesProcessed,
      errors: result.errors.length,
    });

    return result;
  } catch (error: any) {
    await dualLogError("❌ Error during legacy cleanup:", error.message);
    result.errors.push(`Legacy cleanup error: ${error.message}`);
    return result;
  }
}

/**
 * Quick cleanup helper for use in try-catch blocks
 */
export async function quickCleanupOnError(
  jobId?: string,
  operation?: string
): Promise<void> {
  try {
    const result = await cleanupOnError(jobId, { operation });
    if (result.errors.length > 0) {
      await dualLogError(
        `Quick cleanup had ${result.errors.length} errors:`,
        result.errors.join(", "),
        { jobId }
      );
    }
  } catch (cleanupError) {
    await dualLogError(
      "Error during quick cleanup (continuing with error handling):",
      cleanupError,
      { jobId }
    );
    // Don't throw - this is meant to be used in error handling
  }
}
