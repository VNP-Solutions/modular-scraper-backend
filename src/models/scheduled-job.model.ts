import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the ScheduledJob document
export interface IScheduledJob extends Document {
  _id: Types.ObjectId;
  date: string; // Format: YYYY-MM-DD
  job_ids: Types.ObjectId[]; // Array of job IDs
  retrieval_ids: Types.ObjectId[]; // Array of retrieval IDs
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema
const ScheduledJobSchema = new Schema<IScheduledJob>(
  {
    date: {
      type: String,
      required: true,
    },
    job_ids: {
      type: [Schema.Types.ObjectId],
      required: true,
      default: [],
    },
    retrieval_ids: {
      type: [Schema.Types.ObjectId],
      required: false,
      default: [],
    },
    comment: {
      type: String,
      required: false,
      default: "",
    },
  },
  {
    timestamps: true,
    collection: "scheduled_jobs",
  }
);

// Indexes
ScheduledJobSchema.index({ date: 1 });

export const ScheduledJob = mongoose.model<IScheduledJob>(
  "ScheduledJob",
  ScheduledJobSchema
);
