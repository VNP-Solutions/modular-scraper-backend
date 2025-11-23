import { Types } from "mongoose";
import { INotification, Notification } from "../models/notification.model.js";

export interface CreateNotificationDto {
  user_id: string;
  title?: string;
  message: string;
  type?: string;
  metadata?: Record<string, any>;
}

export interface PublicNotificationDto {
  title?: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface ProtectedNotificationDto {
  user_ids: string[];
  title?: string;
  message: string;
  metadata?: Record<string, any>;
}

export class NotificationService {
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
   * Get all user IDs from the User collection
   */
  private async getAllUserIds(): Promise<string[]> {
    const mongoose = await import("mongoose");
    const db = mongoose.connection.db!;

    const users = await db
      .collection("users")
      .find({}, { projection: { _id: 1 } })
      .toArray();

    return users.map((user) => user._id.toString());
  }

  async sendNotification(data: CreateNotificationDto): Promise<INotification> {
    try {
      const userObjectId = this.validateObjectId(data.user_id, "user_id");

      const notification = new Notification({
        ...data,
        user_id: userObjectId,
        type: "private",
        is_read: false,
      });

      return await notification.save();
    } catch (error) {
      console.error(`Error sending notification: ${error}`);
      throw error;
    }
  }

  async sendPublicNotification(
    data: PublicNotificationDto
  ): Promise<INotification[]> {
    try {
      const userIds = await this.getAllUserIds();

      if (!userIds.length) {
        return [];
      }

      const notifications = userIds.map((userId) => ({
        ...data,
        user_id: this.validateObjectId(userId, "user_id"),
        type: "public",
        is_read: false,
      }));

      return await Notification.insertMany(notifications);
    } catch (error) {
      console.error(`Error sending public notification: ${error}`);
      throw error;
    }
  }

  async sendProtectedNotification(
    data: ProtectedNotificationDto
  ): Promise<INotification[]> {
    try {
      if (!data.user_ids?.length) {
        return [];
      }

      const notifications = data.user_ids.map((userId) => ({
        title: data.title,
        message: data.message,
        metadata: data.metadata,
        user_id: this.validateObjectId(userId, "user_id"),
        type: "protected",
        is_read: false,
      }));

      return await Notification.insertMany(notifications);
    } catch (error) {
      console.error(`Error sending protected notification: ${error}`);
      throw error;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
