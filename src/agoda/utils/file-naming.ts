import fs from "fs";
import path from "path";
import { dualLogInfo, dualLogError } from "../../common/log-helper.js";

/**
 * Standardized file naming utilities for Agoda scraping
 * Uses only jobId for consistent file management across first and second steps
 */

/**
 * Generate standardized filename for Agoda files using only jobId
 */
export function generateStandardFilename(
  jobId: string,
  step: "download" | "export"
): string {
  return `${jobId}.csv`;
}

/**
 * Get file paths for both download and export steps
 */
export function getStandardFilePaths(jobId: string): {
  downloadFilePath: string;
  exportFilePath: string;
  downloadDir: string;
  exportDir: string;
} {
  const baseDownloadDir = path.resolve(process.cwd(), "downloads");
  const baseExportDir = path.resolve(process.cwd(), "import");

  // Create job-specific directories
  const downloadDir = path.join(baseDownloadDir, jobId);
  const exportDir = path.join(baseExportDir, jobId);

  const downloadFilePath = path.join(
    downloadDir,
    generateStandardFilename(jobId, "download")
  );
  const exportFilePath = path.join(
    exportDir,
    generateStandardFilename(jobId, "export")
  );

  return {
    downloadFilePath,
    exportFilePath,
    downloadDir,
    exportDir,
  };
}

/**
 * Check if file exists and delete it if it does
 */
export async function checkAndDeleteExistingFile(
  filePath: string,
  jobId?: string
): Promise<boolean> {
  try {
    if (fs.existsSync(filePath)) {
      await dualLogInfo(`Found existing file, deleting: ${filePath}`, {
        jobId,
      });
      fs.unlinkSync(filePath);
      await dualLogInfo(`Successfully deleted existing file: ${filePath}`, {
        jobId,
      });
      return true;
    }
    return false;
  } catch (error) {
    await dualLogError(`Error deleting existing file ${filePath}:`, error, {
      jobId,
    });
    throw error;
  }
}

/**
 * Verify that the file being processed matches the expected jobId
 */
export function verifyFileJobId(
  filePath: string,
  expectedJobId: string
): boolean {
  try {
    const fileName = path.basename(filePath, ".csv");
    return fileName === expectedJobId;
  } catch (error) {
    return false;
  }
}

/**
 * Ensure directory exists for file operations
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Find and rename downloaded files to standard naming convention
 * This handles files downloaded by Agoda that may have different names
 */
export async function standardizeDownloadedFile(
  downloadDir: string,
  jobId: string,
  targetFileName: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(downloadDir)) {
      return null;
    }

    const files = fs.readdirSync(downloadDir);

    // Look for CSV files that aren't already using our standard naming
    const csvFiles = files.filter(
      (file) =>
        file.endsWith(".csv") &&
        !file.includes(".gitkeep") &&
        file !== targetFileName
    );

    if (csvFiles.length === 0) {
      // Check if standard file already exists
      const standardFilePath = path.join(downloadDir, targetFileName);
      if (fs.existsSync(standardFilePath)) {
        await dualLogInfo(`Standard file already exists: ${standardFilePath}`, {
          jobId,
        });
        return standardFilePath;
      }
      return null;
    }

    // Sort by modification time (newest first)
    const sortedFiles = csvFiles
      .map((file) => ({
        name: file,
        path: path.join(downloadDir, file),
        mtime: fs.statSync(path.join(downloadDir, file)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const latestFile = sortedFiles[0];
    const standardFilePath = path.join(downloadDir, targetFileName);

    // Check and delete existing standard file if it exists
    await checkAndDeleteExistingFile(standardFilePath, jobId);

    // Rename the latest downloaded file to standard name
    fs.renameSync(latestFile.path, standardFilePath);

    await dualLogInfo(
      `Renamed downloaded file from ${latestFile.name} to ${targetFileName}`,
      { jobId }
    );

    // Clean up any other downloaded files
    for (let i = 1; i < sortedFiles.length; i++) {
      try {
        fs.unlinkSync(sortedFiles[i].path);
        await dualLogInfo(`Cleaned up extra file: ${sortedFiles[i].name}`, {
          jobId,
        });
      } catch (cleanupError) {
        await dualLogError(
          `Error cleaning up file ${sortedFiles[i].name}:`,
          cleanupError,
          { jobId }
        );
      }
    }

    return standardFilePath;
  } catch (error) {
    await dualLogError(`Error standardizing downloaded file:`, error, {
      jobId,
    });
    throw error;
  }
}

/**
 * Validate file before processing/submitting
 */
export async function validateFileForProcessing(
  filePath: string,
  expectedJobId: string,
  operation: string
): Promise<void> {
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for ${operation}: ${filePath}`);
  }

  // Verify jobId matches filename
  if (!verifyFileJobId(filePath, expectedJobId)) {
    throw new Error(
      `File jobId mismatch for ${operation}. Expected: ${expectedJobId}, File: ${path.basename(
        filePath,
        ".csv"
      )}`
    );
  }

  // Check if file has content
  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    throw new Error(`Empty file detected for ${operation}: ${filePath}`);
  }

  await dualLogInfo(
    `✅ File validation passed for ${operation}: ${path.basename(filePath)}`,
    { jobId: expectedJobId, filePath, fileSize: stats.size }
  );
}
