import { Types } from "mongoose";
import {
  Authorization,
  CardActivity,
  ICardActivity,
  MoneyAmount,
} from "../models/card-activity.model.js";
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
import { PhoneNumberSlot } from "../models/phone-number-slot.model.js";
import {
  IPropertyCredentials,
  PropertyCredentials,
} from "../models/property-cred.model.js";
import { IProperty, Property } from "../models/property.model.js";

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
  /** When true, job is treated as expedited / quick-run (default false). */
  is_quick_job?: boolean;
}

export interface CreateCardActivityData {
  totalSettlementAmount?: MoneyAmount;
  authorizations?: Authorization[];
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
  card_activity?: CreateCardActivityData;
  reservation_status: string;
  additional_text?: string;
}

// Re-export from central failed-reason module (stable codes + messages, set at throw/catch sites)
export { getFailedReasonForUser } from "../common/failed-reason.js";

export class JobService {
  /**
   * Validate and convert string to ObjectId
   */
  private validateObjectId(id: string, fieldName: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new Error(
        `Invalid ${fieldName}: ${id}. Must be a valid MongoDB ObjectId (24 character hex string).`,
      );
    }
    return new Types.ObjectId(id);
  }

  /**
   * Get job with populated property to access expedia_id
   */
  async getJobWithProperty(
    jobId: string,
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
    expediaId: string;
    user_email?: string;
    user_password?: string;
    /**
     * Phone number assigned to this property (from `Property.phone_number`,
     * sourced from a `PhoneNumberSlot`). Used for Expedia OTP verification so
     * each property uses its own number instead of a shared env fallback.
     */
    phone_number?: string;
    credentials?: Partial<IPropertyCredentials>;
    property?: IProperty & { credentials?: Partial<IPropertyCredentials> };
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
          `Property not found for job ${jobId}, property_id: ${job.property_id}`,
        );
        return null;
      }

      if (!property.expedia_id || property.expedia_id === "0") {
        console.error(
          `Property ${property._id} has no valid expedia_id (current: ${property.expedia_id})`,
        );
        return null;
      }

      // Load credentials for this property and hydrate onto the response
      const creds = await PropertyCredentials.findOne({
        property_id: property._id,
      });

      // Attach credentials on the fly to the property object (not persisted here)
      const propertyWithCreds = property.toObject();
      (propertyWithCreds as any).credentials = creds
        ? (creds.toObject() as Partial<IPropertyCredentials>)
        : undefined;

      // Resolve OTP phone number for this property.
      //
      // The schema keeps two copies on `properties`:
      //   - `phone_number` / `slot`     (denormalized mirror, fast path)
      //   - `phone_number_slot_id`      (FK ref to `phone_number_slots`)
      //
      // The slot doc is the source of truth; the mirror may be stale or unset
      // depending on the assignment service. So: prefer the mirror if present,
      // otherwise dereference the FK into `phone_number_slots`.
      let resolvedPhoneNumber: string | undefined = property.phone_number;
      if (!resolvedPhoneNumber && property.phone_number_slot_id) {
        try {
          const slotDoc = await PhoneNumberSlot.findById(
            property.phone_number_slot_id,
          );
          if (slotDoc?.phone_number) {
            resolvedPhoneNumber = slotDoc.phone_number;
            console.log(
              `📱 Resolved phone_number from PhoneNumberSlot ${slotDoc._id} for property ${property._id}`,
            );
          }
        } catch (slotError) {
          console.warn(
            `Failed to load PhoneNumberSlot ${property.phone_number_slot_id} for property ${property._id}:`,
            slotError,
          );
        }
      }

      console.log(
        `✅ Found expedia_id: ${property.expedia_id} for job: ${jobId}`,
      );
      return {
        expediaId: property.expedia_id,
        // Map legacy fields from credentials for backward compatibility
        user_email: creds?.expediaUsername,
        user_password: creds?.expediaPassword,
        phone_number: resolvedPhoneNumber,
        credentials: creds
          ? {
              _id: creds._id,
              property_id: creds.property_id,
              expediaUsername: creds.expediaUsername,
              expediaPassword: creds.expediaPassword,
              agodaUsername: creds.agodaUsername,
              agodaPassword: creds.agodaPassword,
              bookingUsername: creds.bookingUsername,
              bookingPassword: creds.bookingPassword,
              expediaEmailAssociated: creds.expediaEmailAssociated,
              propertyContactEmail: creds.propertyContactEmail,
              portfolioContactEmail: creds.portfolioContactEmail,
              multiplePortfolioEmails: creds.multiplePortfolioEmails,
              createdAt: creds.createdAt,
              updatedAt: creds.updatedAt,
            }
          : undefined,
        property: propertyWithCreds as IProperty & {
          credentials?: Partial<IPropertyCredentials>;
        },
      };
    } catch (error) {
      console.error(`Error getting expedia_id for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Get Agoda ID from job's associated property
   */
  async getAgodaIdFromJob(jobId: string): Promise<{
    agodaId: string;
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
          `Property not found for job ${jobId}, property_id: ${job.property_id}`,
        );
        return null;
      }

      if (!property.agoda_id || property.agoda_id === "0") {
        console.error(
          `Property ${property._id} has no valid agoda_id (current: ${property.agoda_id})`,
        );
        return null;
      }

      console.log(`✅ Found agoda_id: ${property.agoda_id} for job: ${jobId}`);
      return {
        agodaId: property.agoda_id,
      };
    } catch (error) {
      console.error(`Error getting agoda_id for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Update job case_open status
   */
  async updateJobCaseOpen(
    jobId: string,
    caseOpen: boolean,
  ): Promise<IJob | null> {
    try {
      const updatedJob = await Job.findByIdAndUpdate(
        jobId,
        { case_open: caseOpen },
        { new: true },
      ).exec();

      if (!updatedJob) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      console.log(`✅ Updated case_open to ${caseOpen} for job: ${jobId}`);
      return updatedJob;
    } catch (error) {
      console.error(`Error updating case_open for job ${jobId}:`, error);
      throw error;
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

  /** Property linked to the job (for Hotel ID / name in Drive exports). */
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
   * Update job status. When status is Failed or Partial, pass failedReason so the UI can show why the job failed.
   * When status is Running, Completed, Pending, or InQueue, failed_reason is cleared.
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    failedReason?: string | null,
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      const updateData: any = {
        job_status: status,
        updatedAt: new Date(),
      };

      // If changing to Running status, assign current worker and clear previous screenshot trail
      if (status === JobStatus.Running) {
        updateData.worker_assigned = process.env.WORKER_ID || "scraper-worker";
        updateData.screenshot_urls = [];
        updateData.failed_reason = null;
      }

      // Set or clear failed_reason for UI
      if (status === JobStatus.Failed || status === JobStatus.Partial) {
        const reasonStr = typeof failedReason === "string" ? failedReason.trim() : "";
        updateData.failed_reason = reasonStr ? reasonStr.slice(0, 1000) : undefined;
      } else {
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
  async partialCompleteJob(
    jobId: string,
    failedReason?: string | null,
  ): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Partial, failedReason);
  }

  /**
   * Fail job - Update status to Failed
   */
  async failJob(
    jobId: string,
    failedReason?: string | null,
  ): Promise<IJob | null> {
    return await this.updateJobStatus(jobId, JobStatus.Failed, failedReason);
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
        { new: true },
      );
    } catch (error) {
      console.error(`Error updating job log link: ${error}`);
      return null;
    }
  }

  /**
   * Update link to exported job_items file (e.g. Google Drive XLSX URL).
   */
  async updateJobItemsFileLink(
    jobId: string,
    fileLink: string,
  ): Promise<IJob | null> {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");

      return await Job.findByIdAndUpdate(
        objectId,
        {
          job_items_file_link: fileLink,
          updatedAt: new Date(),
        },
        { new: true },
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
        { new: true },
      );
    } catch (error) {
      console.error(`Error updating job live URL: ${error}`);
      return null;
    }
  }

  /**
   * Append a screenshot entry to the job's screenshot_urls array
   */
  async addScreenshotUrl(
    jobId: string,
    entry: {
      step: string;
      url: string;
      timestamp: string;
      type: "step" | "error";
    },
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
   * Check if job exists and is in valid state
   */
  async validateJob(
    jobId: string,
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
        "property_id",
      );

      const { card_activity, ...jobItemFields } = itemData;

      const jobItem = new JobItem({
        ...jobItemFields,
        job_id: jobObjectId,
        property_id: propertyObjectId,
        has_card_info: itemData.has_card_info || false,
        has_payment_info: itemData.has_payment_info || false,
        has_card_activity: false,
      });

      const savedJobItem = await jobItem.save();

      if (card_activity && this.hasAnyCardActivityData(card_activity)) {
        try {
          const cardActivityDoc = await CardActivity.create({
            job_item_id: savedJobItem._id,
            job_id: jobObjectId,
            property_id: propertyObjectId,
            reservation_id: itemData.reservation_id,
            totalSettlementAmount: card_activity.totalSettlementAmount,
            authorizations: card_activity.authorizations || [],
          });

          savedJobItem.has_card_activity = true;
          savedJobItem.card_activity_id = cardActivityDoc._id;
          await savedJobItem.save();
        } catch (cardActivityError) {
          console.error(
            `Error creating card activity for job item ${savedJobItem._id}: ${cardActivityError}`,
          );
        }
      }

      return savedJobItem;
    } catch (error) {
      console.error(`Error creating job item: ${error}`);
      throw error;
    }
  }

  /**
   * Check whether the card activity payload has any meaningful data worth persisting.
   */
  private hasAnyCardActivityData(data: CreateCardActivityData): boolean {
    if (!data) return false;
    const hasTotal =
      !!data.totalSettlementAmount &&
      (data.totalSettlementAmount.amount !== undefined ||
        !!data.totalSettlementAmount.currency);
    const hasAuthorizations =
      Array.isArray(data.authorizations) && data.authorizations.length > 0;
    return hasTotal || hasAuthorizations;
  }

  /**
   * Attach or update a card activity record for an existing job item.
   */
  async upsertJobItemCardActivity(
    jobItemId: string,
    data: CreateCardActivityData,
  ): Promise<ICardActivity | null> {
    try {
      const jobItemObjectId = this.validateObjectId(jobItemId, "jobItemId");
      const jobItem = await JobItem.findById(jobItemObjectId);
      if (!jobItem) {
        console.error(`Job item ${jobItemId} not found for card activity`);
        return null;
      }

      const cardActivity = await CardActivity.findOneAndUpdate(
        { job_item_id: jobItemObjectId },
        {
          $set: {
            job_item_id: jobItemObjectId,
            job_id: jobItem.job_id,
            property_id: jobItem.property_id,
            reservation_id: jobItem.reservation_id,
            totalSettlementAmount: data.totalSettlementAmount,
            authorizations: data.authorizations || [],
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      if (
        !jobItem.has_card_activity ||
        !jobItem.card_activity_id ||
        jobItem.card_activity_id.toString() !== cardActivity._id.toString()
      ) {
        jobItem.has_card_activity = true;
        jobItem.card_activity_id = cardActivity._id;
        await jobItem.save();
      }

      return cardActivity;
    } catch (error) {
      console.error(`Error upserting card activity: ${error}`);
      return null;
    }
  }

  /**
   * Create multiple job items in batch
   */
  async createJobItemsBatch(
    itemsData: CreateJobItemData[],
  ): Promise<IJobItem[]> {
    try {
      const jobItems = itemsData.map((itemData) => {
        const jobObjectId = this.validateObjectId(itemData.job_id, "job_id");
        const propertyObjectId = this.validateObjectId(
          itemData.property_id,
          "property_id",
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
    cardInfo: CardInfo,
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
        { new: true },
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
    paymentInfo: PaymentInfo,
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
        { new: true },
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
    reservationId: string,
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
    reservationId: string,
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

  /**
   * Job items with `CardActivity.authorizations` for Expedia master XLSX (automated-export.md §1.1).
   */
  async getJobItemsWithCardActivitiesForExport(jobId: string): Promise<
    Array<{ item: IJobItem; authorizations: Authorization[] }>
  > {
    try {
      const objectId = this.validateObjectId(jobId, "jobId");
      const items = await JobItem.find({ job_id: objectId })
        .sort({ createdAt: -1 })
        .exec();
      const activityIds = items
        .map((i) => i.card_activity_id)
        .filter((id): id is Types.ObjectId => Boolean(id));
      if (activityIds.length === 0) {
        return items.map((item) => ({ item, authorizations: [] }));
      }
      const activities = await CardActivity.find({ _id: { $in: activityIds } })
        .lean()
        .exec();
      const byId = new Map(
        activities.map((a) => {
          const doc = a as {
            _id: Types.ObjectId;
            authorizations?: Authorization[];
          };
          return [String(doc._id), doc] as const;
        }),
      );
      return items.map((item) => {
        const cid = item.card_activity_id?.toString();
        const doc = cid ? byId.get(cid) : undefined;
        const auths = Array.isArray(doc?.authorizations)
          ? doc!.authorizations!
          : [];
        return { item, authorizations: auths };
      });
    } catch (error) {
      console.error(
        `Error getJobItemsWithCardActivitiesForExport for ${jobId}:`,
        error,
      );
      return [];
    }
  }
}

// Export singleton instance
export const jobService = new JobService();
