import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  IJobQueueUrl,
  JobQueueUrl,
  JobQueueUrlStatus,
} from "../models/job-queue-url.model.js";

/**
 * JobQueueUrlService - Manages URL status changes for job processing
 *
 * Note: URLs are assigned by another project. This service only handles:
 * - Changing URL status back to "Available" when jobs complete (success/failure)
 * - Resetting all URLs to "Available" on system startup
 * - Monitoring URL statistics and status
 */
class JobQueueUrlService {
  /**
   * Get an available URL for a job
   * @returns Available JobQueueUrl or null if none available
   */
  async getAvailableUrl(): Promise<IJobQueueUrl | null> {
    try {
      const availableUrl = await JobQueueUrl.getAvailableUrl();
      if (availableUrl) {
        dualLogInfo(
          `Found available URL: ${availableUrl.name} (${availableUrl.url})`
        );
      } else {
        dualLogInfo("No available URLs found");
      }
      return availableUrl;
    } catch (error) {
      dualLogError("Error getting available URL:", error);
      return null;
    }
  }

  /**
   * Assign a URL to a job
   * @param jobId - Job ID to assign URL to
   * @returns Assigned JobQueueUrl or null if none available
   */
  async assignUrlToJob(jobId: string): Promise<IJobQueueUrl | null> {
    try {
      const assignedUrl = await JobQueueUrl.assignUrlToJob(jobId);
      if (assignedUrl) {
        dualLogInfo(`Assigned URL ${assignedUrl.name} to job ${jobId}`);
      } else {
        dualLogInfo(`No available URLs to assign to job ${jobId}`);
      }
      return assignedUrl;
    } catch (error) {
      dualLogError(`Error assigning URL to job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Release a URL from a job and set it back to Available
   * @param jobId - Job ID to release URL from
   * @returns Released JobQueueUrl or null if not found
   */
  async releaseUrlFromJob(jobId: string): Promise<IJobQueueUrl | null> {
    try {
      const releasedUrl = await JobQueueUrl.releaseUrlFromJob(jobId);
      if (releasedUrl) {
        dualLogInfo(`Released URL ${releasedUrl.name} from job ${jobId}`);
      } else {
        dualLogInfo(`No URL found assigned to job ${jobId}`);
      }
      return releasedUrl;
    } catch (error) {
      dualLogError(`Error releasing URL from job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Handle job completion (success or failure) - sets URL status back to Available
   * @param jobId - Job ID that completed
   * @param jobStatus - Final job status ('Completed', 'Failed', 'Partial')
   * @param errorMessage - Optional error message for failures
   */
  async handleJobCompletion(
    jobId: string,
    jobStatus: "Completed" | "Failed" | "Partial",
    errorMessage?: string
  ): Promise<void> {
    try {
      const releasedUrl = await this.releaseUrlFromJob(jobId);

      if (releasedUrl) {
        if (jobStatus === "Completed") {
          dualLogInfo(
            `Job ${jobId} completed successfully. URL ${releasedUrl.name} is now available.`
          );
        } else if (jobStatus === "Failed") {
          dualLogError(
            `Job ${jobId} failed${
              errorMessage ? ": " + errorMessage : ""
            }. URL ${releasedUrl.name} is now available.`
          );
        } else if (jobStatus === "Partial") {
          dualLogInfo(
            `Job ${jobId} completed partially. URL ${releasedUrl.name} is now available.`
          );
        }
      } else {
        dualLogInfo(
          `Job ${jobId} completed with status ${jobStatus}, but no URL was assigned to it.`
        );
      }
    } catch (error) {
      dualLogError(`Error handling job completion for job ${jobId}:`, error);
    }
  }

  /**
   * Get all URLs with their current status
   * @returns Array of all JobQueueUrls
   */
  async getAllUrls(): Promise<IJobQueueUrl[]> {
    try {
      return await JobQueueUrl.find().sort({ priority: -1, name: 1 }).exec();
    } catch (error) {
      dualLogError("Error getting all URLs:", error);
      return [];
    }
  }

  /**
   * Get URLs by status
   * @param status - JobQueueUrlStatus to filter by
   * @returns Array of JobQueueUrls with specified status
   */
  async getUrlsByStatus(status: JobQueueUrlStatus): Promise<IJobQueueUrl[]> {
    try {
      return await JobQueueUrl.find({ status })
        .sort({ priority: -1, name: 1 })
        .exec();
    } catch (error) {
      dualLogError(`Error getting URLs with status ${status}:`, error);
      return [];
    }
  }

  /**
   * Create a new job queue URL
   * @param urlData - URL data to create
   * @returns Created JobQueueUrl
   */
  async createUrl(urlData: {
    name: string;
    url: string;
    description?: string;
    priority?: number;
    max_concurrent_jobs?: number;
  }): Promise<IJobQueueUrl | null> {
    try {
      const newUrl = new JobQueueUrl(urlData);
      const savedUrl = await newUrl.save();
      dualLogInfo(
        `Created new job queue URL: ${savedUrl.name} (${savedUrl.url})`
      );
      return savedUrl;
    } catch (error) {
      dualLogError("Error creating URL:", error);
      return null;
    }
  }

  /**
   * Update URL status manually
   * @param urlId - URL ID to update
   * @param status - New status
   * @returns Updated JobQueueUrl
   */
  async updateUrlStatus(
    urlId: string,
    status: JobQueueUrlStatus
  ): Promise<IJobQueueUrl | null> {
    try {
      const updatedUrl = await JobQueueUrl.findByIdAndUpdate(
        urlId,
        {
          status,
          ...(status === JobQueueUrlStatus.Available && {
            assigned_to_job_id: null,
          }),
        },
        { new: true }
      ).exec();

      if (updatedUrl) {
        dualLogInfo(`Updated URL ${updatedUrl.name} status to ${status}`);
      }
      return updatedUrl;
    } catch (error) {
      dualLogError(`Error updating URL status:`, error);
      return null;
    }
  }

  /**
   * Reset all URLs to Available status (useful for system resets)
   */
  async resetAllUrlsToAvailable(): Promise<void> {
    try {
      const result = await JobQueueUrl.updateMany(
        {},
        {
          status: JobQueueUrlStatus.Available,
          assigned_to_job_id: null,
          last_used: new Date(),
        }
      ).exec();

      dualLogInfo(`Reset ${result.modifiedCount} URLs to Available status`);
    } catch (error) {
      dualLogError("Error resetting URLs to Available:", error);
    }
  }

  /**
   * Get URL statistics
   * @returns Object with URL statistics
   */
  async getUrlStatistics(): Promise<{
    total: number;
    available: number;
    booked: number;
    maintenance: number;
    disabled: number;
  }> {
    try {
      const [total, available, booked, maintenance, disabled] =
        await Promise.all([
          JobQueueUrl.countDocuments().exec(),
          JobQueueUrl.countDocuments({
            status: JobQueueUrlStatus.Available,
          }).exec(),
          JobQueueUrl.countDocuments({
            status: JobQueueUrlStatus.Booked,
          }).exec(),
          JobQueueUrl.countDocuments({
            status: JobQueueUrlStatus.Maintenance,
          }).exec(),
          JobQueueUrl.countDocuments({
            status: JobQueueUrlStatus.Disabled,
          }).exec(),
        ]);

      return { total, available, booked, maintenance, disabled };
    } catch (error) {
      dualLogError("Error getting URL statistics:", error);
      return {
        total: 0,
        available: 0,
        booked: 0,
        maintenance: 0,
        disabled: 0,
      };
    }
  }
}

export const jobQueueUrlService = new JobQueueUrlService();
