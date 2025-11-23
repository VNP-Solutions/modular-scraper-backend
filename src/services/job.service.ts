import { Types } from "mongoose";
import {
  CardInfo,
  IJobItem,
  JobItem,
  PaymentInfo,
} from "../models/job-item.model.js";
import {
  IJob,
  Job,
  JobStatus,
  OTAProvider,
  PostingType,
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

export interface CreateJobItemData {
  job_id: string;
  property_id: string;
  guest_name: string;
  reservation_id: string;
  confirmation_number: string;
  check_in_date: Date;
  check_out_date: Date;
  room_type: string;
  booking_amount: number;
  booked_date: Date;
  has_card_info?: boolean;
  card_info?: CardInfo;
  has_payment_info?: boolean;
  payment_info?: PaymentInfo;
  reservation_status: string;
  additional_text?: string;
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

      if (!property.expedia_id || property.expedia_id === "0") {
        console.error(
          `Property ${property._id} has no valid expedia_id (current: ${property.expedia_id})`
        );
        return null;
      }

      console.log(`Found expedia_id: ${property.expedia_id} for job: ${jobId}`);
      return {
        expediaId: property.expedia_id,
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
      return await Job.findById(objectId);
    } catch (error) {
      console.error(`Error getting job by ID: ${error}`);
      return null;
    }
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      const updateData: any = {
        job_status: status,
        updatedAt: new Date(),
      };

      // If changing to Running status, assign current worker
      if (status === JobStatus.Running) {
        updateData.worker_assigned = process.env.WORKER_ID || "scraper-worker";
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
  async startJob(jobId: string): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Running);
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
      job.job_status === JobStatus.Partial;

    return {
      exists: true,
      job,
      canRun,
    };
  }

  /**
   * Get job items count for a job
   */
  async getJobItemsCount(jobId: string): Promise<number> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      return await JobItem.countDocuments({ job_id: objectId });
    } catch (error) {
      console.error(`Error getting job items count: ${error}`);
      return 0;
    }
  }

  /**
   * Create job item (scraped data)
   */
  async createJobItem(itemData: CreateJobItemData): Promise<IJobItem> {
    try {
      const jobObjectId = this.validateObjectId(itemData.job_id, "job_id");
      const propertyObjectId = this.validateObjectId(
        itemData.property_id,
        "property_id"
      );

      const jobItem = new JobItem({
        ...itemData,
        job_id: jobObjectId,
        property_id: propertyObjectId,
        has_card_info: itemData.has_card_info || false,
        has_payment_info: itemData.has_payment_info || false,
      });

      return await jobItem.save();
    } catch (error) {
      console.error(`Error creating job item: ${error}`);
      throw error;
    }
  }

  /**
   * Update job item with complete data
   */
  async updateJobItem(
    jobItemId: string,
    updateData: Partial<CreateJobItemData>
  ): Promise<IJobItem | null> {
    try {
      const objectId = this.validateObjectId(jobItemId, "jobItemId");

      // Convert string IDs to ObjectIds if present
      const updatePayload: any = { ...updateData };
      if (updateData.job_id) {
        updatePayload.job_id = this.validateObjectId(
          updateData.job_id,
          "job_id"
        );
      }
      if (updateData.property_id) {
        updatePayload.property_id = this.validateObjectId(
          updateData.property_id,
          "property_id"
        );
      }

      updatePayload.updatedAt = new Date();

      return await JobItem.findByIdAndUpdate(objectId, updatePayload, {
        new: true,
      });
    } catch (error) {
      console.error(`Error updating job item: ${error}`);
      return null;
    }
  }

  /**
   * Find job item by reservation ID (alias for getJobItemByReservation)
   */
  async findJobItemByReservationId(
    jobId: string,
    reservationId: string
  ): Promise<IJobItem | null> {
    return this.getJobItemByReservation(jobId, reservationId);
  }

  /**
   * Create multiple job items in batch
   */
  async createJobItemsBatch(
    itemsData: CreateJobItemData[]
  ): Promise<IJobItem[]> {
    try {
      const jobItems = itemsData.map((itemData) => {
        const jobObjectId = this.validateObjectId(itemData.job_id, "job_id");
        const propertyObjectId = this.validateObjectId(
          itemData.property_id,
          "property_id"
        );

        return new JobItem({
          ...itemData,
          job_id: jobObjectId,
          property_id: propertyObjectId,
          has_card_info: itemData.has_card_info || false,
          has_payment_info: itemData.has_payment_info || false,
        });
      });

      return await JobItem.insertMany(jobItems);
    } catch (error) {
      console.error(`Error creating job items batch: ${error}`);
      throw error;
    }
  }

  /**
   * Update job item with card info
   */
  async updateJobItemCardInfo(
    jobItemId: string,
    cardInfo: CardInfo
  ): Promise<IJobItem | null> {
    try {
      const objectId = this.validateObjectId(jobItemId, "jobItemId");
      return await JobItem.findByIdAndUpdate(
        objectId,
        {
          has_card_info: true,
          card_info: cardInfo,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating job item card info: ${error}`);
      return null;
    }
  }

  /**
   * Update job item with payment info
   */
  async updateJobItemPaymentInfo(
    jobItemId: string,
    paymentInfo: PaymentInfo
  ): Promise<IJobItem | null> {
    try {
      const objectId = this.validateObjectId(jobItemId, "jobItemId");
      return await JobItem.findByIdAndUpdate(
        objectId,
        {
          has_payment_info: true,
          payment_info: paymentInfo,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating job item payment info: ${error}`);
      return null;
    }
  }

  /**
   * Get job items by job ID
   */
  async getJobItems(jobId: string, limit?: number): Promise<IJobItem[]> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const query = JobItem.find({ job_id: objectId }).sort({
        createdAt: -1,
      });

      if (limit) {
        query.limit(limit);
      }

      return await query.exec();
    } catch (error) {
      console.error(`Error getting job items: ${error}`);
      return [];
    }
  }

  /**
   * Get job item by reservation ID
   */
  async getJobItemByReservation(
    jobId: string,
    reservationId: string
  ): Promise<IJobItem | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      return await JobItem.findOne({
        job_id: objectId,
        reservation_id: reservationId,
      });
    } catch (error) {
      console.error(`Error getting job item by reservation: ${error}`);
      return null;
    }
  }

  /**
   * Check if reservation already exists for job
   */
  async reservationExists(
    jobId: string,
    reservationId: string
  ): Promise<boolean> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const count = await JobItem.countDocuments({
        job_id: objectId,
        reservation_id: reservationId,
      });
      return count > 0;
    } catch (error) {
      console.error(`Error checking if reservation exists: ${error}`);
      return false;
    }
  }

  /**
   * Get job progress statistics
   */
  async getJobProgress(jobId: string): Promise<{
    totalItems: number;
    itemsWithCardInfo: number;
    itemsWithPaymentInfo: number;
    completionPercentage: number;
  }> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const pipeline = [
        { $match: { job_id: objectId } },
        {
          $group: {
            _id: null,
            totalItems: { $sum: 1 },
            itemsWithCardInfo: {
              $sum: { $cond: [{ $eq: ["$has_card_info", true] }, 1, 0] },
            },
            itemsWithPaymentInfo: {
              $sum: { $cond: [{ $eq: ["$has_payment_info", true] }, 1, 0] },
            },
          },
        },
      ];

      const result = await JobItem.aggregate(pipeline);

      if (result.length === 0) {
        return {
          totalItems: 0,
          itemsWithCardInfo: 0,
          itemsWithPaymentInfo: 0,
          completionPercentage: 0,
        };
      }

      const stats = result[0];
      const completionPercentage =
        stats.totalItems > 0
          ? Math.round((stats.itemsWithPaymentInfo / stats.totalItems) * 100)
          : 0;

      return {
        totalItems: stats.totalItems,
        itemsWithCardInfo: stats.itemsWithCardInfo,
        itemsWithPaymentInfo: stats.itemsWithPaymentInfo,
        completionPercentage,
      };
    } catch (error) {
      console.error(`Error getting job progress: ${error}`);
      return {
        totalItems: 0,
        itemsWithCardInfo: 0,
        itemsWithPaymentInfo: 0,
        completionPercentage: 0,
      };
    }
  }

  /**
   * Delete job items for a job
   */
  async deleteJobItems(jobId: string): Promise<{ deletedCount: number }> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const result = await JobItem.deleteMany({ job_id: objectId });
      return { deletedCount: result.deletedCount || 0 };
    } catch (error) {
      console.error(`Error deleting job items: ${error}`);
      return { deletedCount: 0 };
    }
  }

  /**
   * Get latest job items for monitoring
   */
  async getLatestJobItems(limit: number = 10): Promise<IJobItem[]> {
    return await JobItem.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("job_id", "job_status portfolio_name property_name")
      .exec();
  }

  /**
   * Advanced get job items with pagination, search, filter, and sorting
   */
  async getJobItemsAdvanced({
    jobId,
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    sortOrder = "desc",
    search,
    reasonForCharge,
  }: {
    jobId: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    search?: string;
    reasonForCharge?: string;
  }): Promise<{
    items: IJobItem[];
    totalDocuments: number;
    currentPage: number;
    totalPage: number;
    limit: number;
  }> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const filter: any = { job_id: objectId };
      if (search) {
        filter.$or = [
          { guest_name: { $regex: search, $options: "i" } },
          { reservation_id: { $regex: search, $options: "i" } },
        ];
      }
      if (reasonForCharge) {
        filter["card_info.reason_for_charge"] = {
          $regex: reasonForCharge,
          $options: "i",
        };
      }
      const sort: any = {};
      sort[sortBy] = sortOrder === "asc" ? 1 : -1;
      const skip = (page - 1) * limit;
      const [items, totalDocuments] = await Promise.all([
        JobItem.find(filter).sort(sort).skip(skip).limit(limit).exec(),
        JobItem.countDocuments(filter),
      ]);
      const totalPage = Math.ceil(totalDocuments / limit) || 1;
      return {
        items,
        totalDocuments,
        currentPage: page,
        totalPage,
        limit,
      };
    } catch (error) {
      console.error(`Error in getJobItemsAdvanced: ${error}`);
      return {
        items: [],
        totalDocuments: 0,
        currentPage: page,
        totalPage: 1,
        limit,
      };
    }
  }
}

// Export singleton instance
export const jobService = new JobService();
