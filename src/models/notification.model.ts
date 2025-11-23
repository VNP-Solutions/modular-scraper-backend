import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for the Notification document
export interface INotification extends Document {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  title?: string;
  message: string;
  type?: string;
  metadata?: Record<string, any>;
  is_read: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Mongoose Schema for Notification
const NotificationSchema = new Schema<INotification>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: false,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: false,
    },
    metadata: {
      type: Schema.Types.Mixed,
      required: false,
    },
    is_read: {
      type: Boolean,
      default: false,
      required: true,
    },
    readAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "notifications",
  }
);

// Index for efficient queries on user_id and is_read
NotificationSchema.index({ user_id: 1, is_read: 1 });

export const Notification = mongoose.model<INotification>(
  "Notification",
  NotificationSchema
);
