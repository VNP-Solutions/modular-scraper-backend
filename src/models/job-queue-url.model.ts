import mongoose, { Document, Schema, Types } from "mongoose";

// Enum for JobQueueUrl status
export enum JobQueueUrlStatus {
  Available = "Available", // URL is free to use
  Booked = "Booked", // URL is assigned to a job by another project
  Maintenance = "Maintenance",
  Disabled = "Disabled",
}

// Interface for the JobQueueUrl document
export interface IJobQueueUrl extends Document {
  _id: Types.ObjectId;
  name: string;
  url: string;
  status: JobQueueUrlStatus;
  description?: string;
  assigned_to_job_id?: string;
  last_used?: Date;
  priority: number;
  max_concurrent_jobs: number;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema for JobQueueUrl
const JobQueueUrlSchema = new Schema<IJobQueueUrl>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      validate: {
        validator: function (v: string): boolean {
          // Basic URL validation
          return /^https?:\/\/.+/.test(v);
        },
        message: "Invalid URL format",
      },
    },
    status: {
      type: String,
      enum: Object.values(JobQueueUrlStatus),
      default: JobQueueUrlStatus.Available,
      required: true,
    },
    description: {
      type: String,
      required: false,
      trim: true,
    },
    assigned_to_job_id: {
      type: String,
      required: false,
    },
    last_used: {
      type: Date,
      required: false,
    },
    priority: {
      type: Number,
      default: 1,
      required: true,
      min: 1,
    },
    max_concurrent_jobs: {
      type: Number,
      default: 1,
      required: true,
      min: 1,
    },
    is_active: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "job_queue_urls",
  }
);

// Indexes for efficient queries
JobQueueUrlSchema.index({ status: 1, is_active: 1 });
JobQueueUrlSchema.index({ url: 1 });
JobQueueUrlSchema.index({ priority: -1 });
JobQueueUrlSchema.index({ assigned_to_job_id: 1 });
JobQueueUrlSchema.index({ last_used: 1 });

// Static methods for job queue management
JobQueueUrlSchema.statics.getAvailableUrl =
  async function (): Promise<IJobQueueUrl | null> {
    return this.findOne({
      status: JobQueueUrlStatus.Available,
      is_active: true,
    })
      .sort({ priority: -1, last_used: 1 })
      .exec();
  };

JobQueueUrlSchema.statics.assignUrlToJob = async function (
  jobId: string
): Promise<IJobQueueUrl | null> {
  return this.findOneAndUpdate(
    {
      status: JobQueueUrlStatus.Available,
      is_active: true,
    },
    {
      $set: {
        status: JobQueueUrlStatus.Booked,
        assigned_to_job_id: jobId,
        last_used: new Date(),
      },
    },
    {
      new: true,
      sort: { priority: -1, last_used: 1 },
    }
  ).exec();
};

JobQueueUrlSchema.statics.releaseUrlFromJob = async function (
  jobId: string
): Promise<IJobQueueUrl | null> {
  return this.findOneAndUpdate(
    {
      assigned_to_job_id: jobId,
      status: JobQueueUrlStatus.Booked,
    },
    {
      $set: {
        status: JobQueueUrlStatus.Available,
        assigned_to_job_id: null,
        last_used: new Date(),
      },
    },
    { new: true }
  ).exec();
};

// Instance methods
JobQueueUrlSchema.methods.markAsAvailable = function (): Promise<IJobQueueUrl> {
  this.status = JobQueueUrlStatus.Available;
  this.assigned_to_job_id = null;
  this.last_used = new Date();
  return this.save();
};

JobQueueUrlSchema.methods.assignToJob = function (
  jobId: string
): Promise<IJobQueueUrl> {
  this.status = JobQueueUrlStatus.Booked;
  this.assigned_to_job_id = jobId;
  this.last_used = new Date();
  return this.save();
};

// Interface for static methods (for TypeScript support)
interface JobQueueUrlModel extends mongoose.Model<IJobQueueUrl> {
  getAvailableUrl(): Promise<IJobQueueUrl | null>;
  assignUrlToJob(jobId: string): Promise<IJobQueueUrl | null>;
  releaseUrlFromJob(jobId: string): Promise<IJobQueueUrl | null>;
}

export const JobQueueUrl = mongoose.model<IJobQueueUrl, JobQueueUrlModel>(
  "JobQueueUrl",
  JobQueueUrlSchema
);
