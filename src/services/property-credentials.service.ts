import { Types } from "mongoose";
import { encryptPassword } from "../common/encription.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { Job } from "../models/job.model.js";
import { PropertyCredentials } from "../models/Property-credentials.js";
import { Property } from "../models/property.model.js";

class PropertyCredentialsService {
  /**
   * Get portfolio_id from job_id
   */
  async getPortfolioIdFromJobId(jobId: string): Promise<Types.ObjectId | null> {
    try {
      const job = await Job.findById(jobId).select("portfolio_id").lean();

      if (!job) {
        await dualLogError(`Job not found with ID: ${jobId}`);
        return null;
      }

      if (!job.portfolio_id) {
        await dualLogError(`Job ${jobId} has no portfolio_id`);
        return null;
      }

      return job.portfolio_id;
    } catch (error) {
      await dualLogError(
        `Error getting portfolio_id from job ${jobId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get all property IDs from a portfolio
   */
  async getPropertyIdsByPortfolioId(
    portfolioId: Types.ObjectId
  ): Promise<Types.ObjectId[]> {
    try {
      await dualLogInfo(
        `Finding all properties for portfolio ${portfolioId}...`
      );

      const properties = await Property.find({ portfolio_id: portfolioId })
        .select("_id")
        .lean();

      const propertyIds = properties.map((prop) => prop._id);

      await dualLogInfo(
        `Found ${propertyIds.length} properties in portfolio ${portfolioId}`
      );

      return propertyIds;
    } catch (error) {
      await dualLogError(
        `Error getting properties for portfolio ${portfolioId}:`,
        error
      );
      return [];
    }
  }

  /**
   * Update booking password for a property
   */
  async updateBookingPassword(
    propertyId: string | Types.ObjectId,
    newPassword: string
  ): Promise<boolean> {
    try {
      await dualLogInfo(
        `Updating booking password for property ${propertyId}...`
      );

      // Encrypt the new password
      const encryptedPassword = encryptPassword(newPassword);

      // Update the property credentials
      const result = await PropertyCredentials.findOneAndUpdate(
        { property_id: propertyId },
        {
          $set: {
            bookingPassword: encryptedPassword,
          },
        },
        { new: true }
      );

      if (!result) {
        await dualLogError(
          `Property credentials not found for property ${propertyId}`
        );
        return false;
      }

      await dualLogInfo(
        `Successfully updated booking password for property ${propertyId}`
      );
      return true;
    } catch (error) {
      await dualLogError(
        `Error updating booking password for property ${propertyId}:`,
        error
      );
      return false;
    }
  }

  /**
   * Update booking password for all properties in a portfolio using job_id (OPTIMIZED)
   */
  async updateBookingPasswordByJobId(
    jobId: string,
    newPassword: string
  ): Promise<boolean> {
    try {
      await dualLogInfo(`Updating booking password for job ${jobId}...`);

      // Step 1: Get portfolio_id from job_id
      const portfolioId = await this.getPortfolioIdFromJobId(jobId);

      if (!portfolioId) {
        await dualLogError(`Could not find portfolio_id for job ${jobId}`);
        return false;
      }

      await dualLogInfo(`Found portfolio ${portfolioId} for job ${jobId}`);

      // Step 2: Get all property IDs in this portfolio
      const propertyIds = await this.getPropertyIdsByPortfolioId(portfolioId);

      if (propertyIds.length === 0) {
        await dualLogError(`No properties found for portfolio ${portfolioId}`);
        return false;
      }

      await dualLogInfo(
        `Updating booking password for ${propertyIds.length} properties in portfolio ${portfolioId}`
      );

      // Step 3: Encrypt the password once (efficient - done only once)
      const encryptedPassword = encryptPassword(newPassword);

      // Step 4: OPTIMIZED - Use updateMany for bulk update (single query)
      const updateResult = await PropertyCredentials.updateMany(
        { property_id: { $in: propertyIds } },
        {
          $set: {
            bookingPassword: encryptedPassword,
          },
        }
      );

      const successCount = updateResult.modifiedCount;
      const matchedCount = updateResult.matchedCount;

      // Step 5: Log summary
      await dualLogInfo(
        `Password update complete: ${successCount} properties updated (${matchedCount} matched) out of ${propertyIds.length} in portfolio`
      );

      if (successCount === 0 && matchedCount === 0) {
        await dualLogError(
          `No property credentials found for any property in portfolio ${portfolioId}`
        );
        return false;
      }

      if (successCount < propertyIds.length) {
        await dualLogInfo(
          `Note: ${
            propertyIds.length - matchedCount
          } properties don't have credentials records yet`
        );
      }

      // Return true if at least one update succeeded
      return successCount > 0;
    } catch (error) {
      await dualLogError(
        `Error updating booking password by job ID ${jobId}:`,
        error
      );
      return false;
    }
  }
}

export const propertyCredentialsService = new PropertyCredentialsService();
