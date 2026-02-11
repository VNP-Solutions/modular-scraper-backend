import { Types } from "mongoose";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { Job } from "../models/job.model.js";
import {
  IPropertyCredentials,
  PropertyCredentials,
} from "../models/property-cred.model.js";

export class PropertyCredentialsService {
  /**
   * Get credentials by job ID
   * Looks up the property associated with the job and returns its credentials
   */
  async getCredentialsByJobId(
    jobId: string,
  ): Promise<IPropertyCredentials | null> {
    try {
      await dualLogInfo(`Getting credentials for job ${jobId}`, { jobId });

      // First, get the job and its property_id
      const job = await Job.findById(jobId).exec();
      if (!job || !job.property_id) {
        await dualLogError(
          `Job not found or no property associated with job ${jobId}`,
          undefined,
          { jobId },
        );
        return null;
      }

      // Then get the credentials for that property
      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      }).exec();

      if (!credentials) {
        await dualLogInfo(
          `No credentials found for property ${job.property_id} (job ${jobId})`,
          { jobId, propertyId: job.property_id },
        );
        return null;
      }

      await dualLogInfo(`Successfully retrieved credentials for job ${jobId}`, {
        jobId,
        propertyId: job.property_id,
        hasExpediaCredentials: !!(
          credentials.expediaUsername && credentials.expediaPassword
        ),
        hasAgodaCredentials: !!(
          credentials.agodaUsername && credentials.agodaPassword
        ),
      });

      return credentials;
    } catch (error) {
      await dualLogError(`Error getting credentials for job ${jobId}:`, error, {
        jobId,
      });
      throw error;
    }
  }

  /**
   * Get credentials by property ID
   */
  async getCredentialsByPropertyId(
    propertyId: string | Types.ObjectId,
  ): Promise<IPropertyCredentials | null> {
    try {
      const credentials = await PropertyCredentials.findOne({
        property_id: propertyId,
      }).exec();

      return credentials;
    } catch (error) {
      await dualLogError(
        `Error getting credentials for property ${propertyId}:`,
        error,
        { propertyId },
      );
      throw error;
    }
  }

  /**
   * Create or update credentials for a property
   */
  async upsertCredentials(
    propertyId: string | Types.ObjectId,
    credentials: Partial<{
      expediaUsername: string;
      expediaPassword: string;
      agodaUsername: string;
      agodaPassword: string;
    }>,
  ): Promise<IPropertyCredentials> {
    try {
      const result = await PropertyCredentials.findOneAndUpdate(
        { property_id: propertyId },
        { $set: credentials },
        { upsert: true, new: true },
      ).exec();

      await dualLogInfo(`Credentials upserted for property ${propertyId}`, {
        propertyId,
        hasExpediaCredentials: !!(
          result.expediaUsername && result.expediaPassword
        ),
        hasAgodaCredentials: !!(result.agodaUsername && result.agodaPassword),
      });

      return result;
    } catch (error) {
      await dualLogError(
        `Error upserting credentials for property ${propertyId}:`,
        error,
        { propertyId },
      );
      throw error;
    }
  }

  /**
   * Delete credentials for a property
   */
  async deleteCredentials(
    propertyId: string | Types.ObjectId,
  ): Promise<boolean> {
    try {
      const result = await PropertyCredentials.deleteOne({
        property_id: propertyId,
      }).exec();

      await dualLogInfo(`Credentials deleted for property ${propertyId}`, {
        propertyId,
        deleted: result.deletedCount > 0,
      });

      return result.deletedCount > 0;
    } catch (error) {
      await dualLogError(
        `Error deleting credentials for property ${propertyId}:`,
        error,
        { propertyId },
      );
      throw error;
    }
  }
}

// Export singleton instance
export const propertyCredentialsService = new PropertyCredentialsService();
