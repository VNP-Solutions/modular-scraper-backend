import { Types } from "mongoose";
import {
  FAILED_REASON,
  getFailedReasonForUser,
  hasFailedReasonCode,
  inferBookingOtpFailedReasonCode,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import {
  IJob,
  Job,
  JobStatus,
  OTAProvider,
  PostingType,
  resolveJobOtaProvider,
} from "../models/job.model.js";
import { PropertyCredentials } from "../models/Property-credentials.js";
import { IProperty, Property } from "../models/property.model.js";
import { notificationService } from "./notification.service.js";

export interface CreateJobData {
  name?: string;
  user_id: string;
  property_id?: string;
  portfolio_id?: string;
  sub_portfolio_id?: string;
  posting_type: PostingType;
  portfolio_name: string;
  sub_portfolio_name: string;
  property_name: string;
  billing_type: string;
  next_due_date: Date;
  ota_provider: OTAProvider;
  execution_type: string;
  job_backoff_length_loading: number;
  job_backoff_length_selector: number;
  priority?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  queue_name?: string;
}

export class JobService {
  private currentJobId: string | null = null;
  private currentRetryCheck: {
    canRetry: boolean;
    job?: IJob;
    reason?: string;
  } | null = null;

  /**
   * Set the current job ID for retry checking
   */
  async setJobIdForRetryCheck(jobId: string): Promise<void> {
    this.currentJobId = jobId;
    this.currentRetryCheck = await this.canRetryJob(jobId);
  }

  /**
   * Get canRetry status for the current job
   */
  get canRetry(): boolean {
    return this.currentRetryCheck?.canRetry ?? false;
  }

  /**
   * Get the current job for retry operations
   */
  get currentJob(): IJob | undefined {
    return this.currentRetryCheck?.job;
  }

  /**
   * Get the reason why retry is not allowed
   */
  get retryReason(): string | undefined {
    return this.currentRetryCheck?.reason;
  }

  /**
   * Get the current retry attempt count
   */
  get retryAttempt(): number {
    return this.currentRetryCheck?.job?.retries_attempted || 0;
  }

  /**
   * Get the maximum retry attempts allowed
   */
  get maxRetries(): number {
    return this.currentRetryCheck?.job?.max_retries || 3;
  }

  /**
   * Validate and convert string to ObjectId
   */
  private validateObjectId(id: string, fieldName: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new Error(
        `Invalid ${fieldName}: ${id}. Must be a valid MongoDB ObjectId (24 character hex string).`
      );
    }
    return new Types.ObjectId(id);
  }

  /**
   * Clear the current retry check state
   */
  clearRetryCheck(): void {
    this.currentJobId = null;
    this.currentRetryCheck = null;
  }

  /**
   * Get job with populated property to access expedia_id
   */
  async getJobWithProperty(
    jobId: string
  ): Promise<(IJob & { property?: IProperty }) | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      return (await Job.findById(objectId).populate("property_id")) as any;
    } catch (error) {
      console.error(`Error getting job with property: ${error}`);
      return null;
    }
  }

  /**
   * Get expedia_id from job's property
   */
  async getExpediaIdFromJob(jobId: string): Promise<{
    user_email: string;
    user_password: string;
    expediaId: string;
  } | null> {
    try {
      const job = await this.getJobWithProperty(jobId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      // Get property details
      const property = await Property.findById(job.property_id);

      if (!property) {
        console.error(
          `Property not found for job ${jobId}, property_id: ${job.property_id}`
        );
        return null;
      }

      // `expedia_id` is a number in the DBMS schema; the callers below all
      // work with it as a string.
      const expediaId =
        property.expedia_id != null ? String(property.expedia_id) : "";

      if (!expediaId || expediaId === "0") {
        console.error(
          `Property ${property._id} has no valid expedia_id (current: ${property.expedia_id})`
        );
        return null;
      }

      console.log(`Found expedia_id: ${expediaId} for job: ${jobId}`);
      return {
        expediaId,
        user_email: property.user_email || "",
        user_password: property.user_password || "",
      };
    } catch (error) {
      console.error(`Error getting expedia_id for job ${jobId}:`, error);
      return null;
    }
  }
  /**
   * Get booking_id from job's property
   */
  async getBookingIdFromJob(jobId: string): Promise<{
    bookingId: number;
    portfolioId?: string;
    propertyId?: string;
    bookingUsername?: string;
    bookingPassword?: string;
  } | null> {
    try {
      const job = await this.getJobWithProperty(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }
      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }
      // Get property details
      const property = await Property.findById(job.property_id);
      if (!property) {
        console.error(
          `Property not found for job ${jobId}, property_id: ${job.property_id}`
        );
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: property._id,
      });

      // Check if booking_id exists and is valid
      if (!property.booking_id || property.booking_id === 0) {
        console.error(`Property ${job.property_id} has no valid booking_id`);

        // Send public notification for missing booking_id
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com Credentials Missing",
            message: `Booking.com credentials are missing for property ${
              property.property_name ||
              job.property_name ||
              job.property_id._id.toString()
            }. Property has no valid booking_id. Please update credentials`,
            metadata: {
              jobId,
              propertyId: job.property_id._id.toString(),
              propertyName: property.property_name || job.property_name,
              bookingId: property.booking_id,
              issue: "missing_booking_id",
              detectedAt: new Date().toISOString(),
            },
          });
        } catch (notificationError) {
          console.error(
            `Error sending booking credential missing notification: ${notificationError}`
          );
        }

        return null;
      }

      // Check if booking credentials are missing
      if (!credentials?.bookingUsername || !credentials?.bookingPassword) {
        console.error(`Property ${job.property_id} has no booking credentials`);

        // Send public notification for missing booking credentials
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com Credentials Missing",
            message: `Booking.com credentials are missing for property ${
              property.property_name ||
              job.property_name ||
              job.property_id._id.toString()
            }. Please update credentials`,
            metadata: {
              jobId,
              propertyId: job.property_id._id.toString(),
              propertyName: property.property_name || job.property_name,
              bookingId: property.booking_id,
              hasUsername: !!credentials?.bookingUsername,
              hasPassword: !!credentials?.bookingPassword,
              issue: "missing_credentials",
              detectedAt: new Date().toISOString(),
            },
          });
        } catch (notificationError) {
          console.error(
            `Error sending booking credential missing notification: ${notificationError}`
          );
        }
      }

      console.log(`Found booking_id: ${property.booking_id} for job: ${jobId}`);

      return {
        bookingId: property.booking_id,
        portfolioId: job.portfolio_id?.toString(),
        propertyId: job.property_id._id.toString(),
        bookingUsername: credentials?.bookingUsername,
        bookingPassword: credentials?.bookingPassword,
      };
    } catch (error) {
      console.error(`Error getting booking_id for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Create job (external jobs creation - read only for scraper)
   */
  async createJob(jobData: CreateJobData): Promise<IJob> {
    const job = new Job({
      ...jobData,
      user_id: this.validateObjectId(jobData.user_id, "user_id"),
      property_id: jobData.property_id
        ? this.validateObjectId(jobData.property_id, "property_id")
        : undefined,
      portfolio_id: jobData.portfolio_id
        ? this.validateObjectId(jobData.portfolio_id, "portfolio_id")
        : undefined,
      sub_portfolio_id: jobData.sub_portfolio_id
        ? this.validateObjectId(jobData.sub_portfolio_id, "sub_portfolio_id")
        : undefined,
      job_status: JobStatus.Pending,
      current_stage: "initialized",
      progress_percentage: 0,
      worker_assigned: null,
      job_queue_length: 0,
      retry_count: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return await job.save();
  }

  /**
   * Get job by ID
   */
  async getJobById(jobId: string): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(objectId);
      if (!job) return null;
      const resolved = resolveJobOtaProvider(job);
      if (
        resolved !== undefined &&
        resolved !== null &&
        String(resolved).trim() !== ""
      ) {
        const cur = job.ota_provider;
        const empty =
          cur === undefined ||
          cur === null ||
          (typeof cur === "string" && cur.trim() === "");
        if (empty) {
          job.set("ota_provider", resolved as OTAProvider);
        }
      }
      return job;
    } catch (error) {
      console.error(`Error getting job by ID: ${error}`);
      return null;
    }
  }

  /** Property linked to the job (e.g. booking_id for Drive XLSX). */
  async getPropertyForJob(jobId: string): Promise<IProperty | null> {
    const job = await this.getJobById(jobId);
    if (!job?.property_id) return null;
    try {
      return await Property.findById(job.property_id);
    } catch (error) {
      console.error(`Error getting property for job: ${error}`);
      return null;
    }
  }

  /**
   * Update job status
   * @param workerAssigned When status is Running, stored on the job (e.g. `WORKER_ID:pool-worker-0`) so parallel jobs are distinguishable.
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    workerAssigned?: string
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      const updateData: any = {
        job_status: status,
        updatedAt: new Date(),
      };

      // If changing to Running status, assign current worker and clear previous screenshot trail
      if (status === JobStatus.Running) {
        updateData.worker_assigned =
          workerAssigned ?? (process.env.WORKER_ID || "scraper-worker");
        updateData.screenshot_urls = [];
        updateData.failed_reason = null;
      }

      return await Job.findByIdAndUpdate(objectId, updateData, { new: true });
    } catch (error) {
      console.error(`Error updating job status: ${error}`);
      return null;
    }
  }

  /**
   * Start job - Update status to Running
   */
  async startJob(
    jobId: string,
    workerAssigned?: string
  ): Promise<IJob | null> {
    return await this.updateJobStatus(
      jobId,
      JobStatus.Running,
      workerAssigned
    );
  }

  /**
   * Complete job - Update status to Completed
   */
  async completeJob(jobId: string): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Completed);
  }

  /**
   * Partial complete job - Update status to Partial
   */
  async partialCompleteJob(jobId: string): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Partial);
  }

  /**
   * Fail job - Update status to Failed
   */
  async failJob(jobId: string): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Failed);
  }

  /**
   * Update job status along with a specific failed_reason message.
   * Pass null to clear an existing failed_reason.
   */
  async updateJobStatusWithReason(
    jobId: string,
    status: JobStatus,
    failedReason?: string | null,
    workerAssigned?: string
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const updateData: any = {
        job_status: status,
        updatedAt: new Date(),
      };
      if (status === JobStatus.Running) {
        updateData.worker_assigned =
          workerAssigned ?? (process.env.WORKER_ID || "scraper-worker");
        updateData.screenshot_urls = [];
        updateData.failed_reason = null;
      }
      if (failedReason !== undefined) {
        updateData.failed_reason = failedReason ?? null;
      }
      return await Job.findByIdAndUpdate(objectId, updateData, { new: true });
    } catch (error) {
      console.error(`Error updating job status with reason: ${error}`);
      return null;
    }
  }

  /**
   * Set job to Failed while preserving any failed_reason already saved by an
   * inner catch block (first-writer-wins). Only writes a fallback reason when
   * the DB document has no failed_reason yet.
   */
  async failJobSafe(
    jobId: string,
    fallbackReason?: string
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const existing = await Job.findById(objectId).select("failed_reason");
      const reason = existing?.failed_reason ?? fallbackReason ?? null;
      return await Job.findByIdAndUpdate(
        objectId,
        {
          job_status: JobStatus.Failed,
          failed_reason: reason,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error in failJobSafe: ${error}`);
      return null;
    }
  }


  async addScreenshotUrl(
    jobId: string,
    entry: {
      step: string;
      url: string;
      timestamp: string;
      type: "step" | "error";
    }
  ): Promise<void> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      await Job.findByIdAndUpdate(objectId, {
        $push: { screenshot_urls: entry },
        updatedAt: new Date(),
      });
    } catch (error) {
      console.error(`Error adding screenshot URL to job: ${error}`);
    }
  }

  /**
   * Increment retry attempts for a job
   */
  async incrementRetryAttempts(jobId: string): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      return await Job.findByIdAndUpdate(
        objectId,
        {
          $inc: { retries_attempted: 1 },
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error incrementing retry attempts: ${error}`);
      return null;
    }
  }

  /**
   * Check if job can be retried (not exceeded max retries)
   */
  async canRetryJob(
    jobId: string
  ): Promise<{ canRetry: boolean; job?: IJob; reason?: string }> {
    try {
      const job = await this.getJobById(jobId);

      if (!job) {
        return { canRetry: false, reason: "Job not found" };
      }

      if (
        job.job_status !== JobStatus.Failed &&
        job.job_status !== JobStatus.Cancelled
      ) {
        return {
          canRetry: false,
          job,
          reason: `Job is not in Failed or Cancelled status. Current status: ${job.job_status}`,
        };
      }

      if (job.retries_attempted >= job.max_retries) {
        return {
          canRetry: false,
          job,
          reason: `Maximum retries exceeded (${job.retries_attempted}/${job.max_retries})`,
        };
      }

      return { canRetry: true, job };
    } catch (error) {
      console.error(`Error checking if job can be retried: ${error}`);
      return { canRetry: false, reason: "Error checking retry eligibility" };
    }
  }

  /**
   * Update job log link
   */
  async updateJobLogLink(jobId: string, logLink: string): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      return await Job.findByIdAndUpdate(
        objectId,
        {
          log_link: logLink,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating job log link: ${error}`);
      return null;
    }
  }

  async updateJobItemsFileLink(
    jobId: string,
    fileLink: string
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      return await Job.findByIdAndUpdate(
        objectId,
        {
          job_items_file_link: fileLink,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating job items file link: ${error}`);
      return null;
    }
  }

  /**
   * Update job live URL
   */
  async updateJobLiveUrl(jobId: string, liveUrl: string): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      return await Job.findByIdAndUpdate(
        objectId,
        {
          live_url: liveUrl,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating job live URL: ${error}`);
      return null;
    }
  }

  /**
   * Booking VCCS: store how many reservations matched the charge-before filter
   * after Phase 1 list pagination (for UI / reporting).
   */
  async updateBookingVccsFilteredReservationCount(
    jobId: string,
    count: number
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      return await Job.findByIdAndUpdate(
        objectId,
        {
          booking_vccs_filtered_reservation_count: count,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(
        `Error updating booking VCCS filtered reservation count: ${error}`
      );
      return null;
    }
  }

  /**
   * Check if job exists and is in valid state
   */
  async validateJob(
    jobId: string
  ): Promise<{ exists: boolean; job?: IJob; canRun: boolean }> {
    const job = await this.getJobById(jobId);

    if (!job) {
      return { exists: false, canRun: false };
    }

    const canRun =
      job.job_status === JobStatus.Pending ||
      job.job_status === JobStatus.InQueue ||
      job.job_status === JobStatus.Partial;

    return {
      exists: true,
      job,
      canRun,
    };
  }

}

// Export singleton instance
export const jobService = new JobService();

// Re-export failed-reason helpers for convenience
export {
  FAILED_REASON,
  getFailedReasonForUser,
  hasFailedReasonCode,
  inferBookingOtpFailedReasonCode,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "../common/failed-reason.js";
