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

      // Get property IDs from jobs since properties don't have portfolio_id
      const jobs = await Job.find({ portfolio_id: portfolioId })
        .select("property_id")
        .lean();

      // Extract unique property IDs
      const propertyIds = [
        ...new Set(
          jobs
            .map((job) => job.property_id)
            .filter((id): id is Types.ObjectId => id !== undefined)
        ),
      ];

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

  /**
   * Get portfolio and property details for a given portfolio ID
   * Returns structured data with portfolio name and all property names
   */
  async getPortfolioAndPropertyDetails(portfolioId: Types.ObjectId): Promise<{
    portfolioName: string;
    properties: Array<{ propertyName: string; propertyId: Types.ObjectId }>;
  } | null> {
    try {
      await dualLogInfo(
        `[getPortfolioAndPropertyDetails] Starting lookup for portfolio: ${portfolioId}`
      );

      // Get all jobs for this portfolio to find property IDs and portfolio name
      const jobs = await Job.find({ portfolio_id: portfolioId })
        .select("property_id property_name portfolio_name")
        .lean();

      await dualLogInfo(
        `[getPortfolioAndPropertyDetails] Found ${jobs.length} jobs for portfolio ${portfolioId}`
      );

      if (jobs.length === 0) {
        await dualLogError(`No jobs found for portfolio ${portfolioId}`);
        return null;
      }

      const portfolioName = jobs[0]?.portfolio_name || "Unknown Portfolio";

      // Extract unique property IDs from jobs
      const uniquePropertyIds = [
        ...new Set(
          jobs
            .map((job) => job.property_id?.toString())
            .filter((id): id is string => id !== undefined)
        ),
      ];

      await dualLogInfo(
        `[getPortfolioAndPropertyDetails] Found ${
          uniquePropertyIds.length
        } unique property IDs: ${uniquePropertyIds.join(", ")}`
      );

      if (uniquePropertyIds.length === 0) {
        await dualLogError(
          `No property IDs found in jobs for portfolio ${portfolioId}`
        );
        return null;
      }

      // Fetch actual property documents to get current property names (source of truth)
      const properties = await Property.find({
        _id: { $in: uniquePropertyIds.map((id) => new Types.ObjectId(id)) },
      })
        .select("_id property_name")
        .lean();

      await dualLogInfo(
        `[getPortfolioAndPropertyDetails] Fetched ${properties.length} property documents from database`
      );

      // Log each property to see what data we have
      properties.forEach((prop: any, index: number) => {
        dualLogInfo(
          `[getPortfolioAndPropertyDetails] Property ${index + 1}: ID=${
            prop._id
          }, name="${prop.property_name || "MISSING"}"`
        );
      });

      if (properties.length === 0) {
        await dualLogError(
          `No properties found in database for portfolio ${portfolioId}. Checked IDs: ${uniquePropertyIds.join(
            ", "
          )}`
        );
        return null;
      }

      // If property names are missing from Property collection, fall back to job property_name
      const jobPropertyMap = new Map<string, string>();
      jobs.forEach((job) => {
        if (job.property_id && job.property_name) {
          jobPropertyMap.set(job.property_id.toString(), job.property_name);
        }
      });

      // Map properties with current names from Property collection, fallback to job names
      const propertyDetails = properties.map((prop: any) => {
        const propertyName =
          prop.property_name ||
          jobPropertyMap.get(prop._id.toString()) ||
          "Unknown Property";

        return {
          propertyName,
          propertyId: prop._id,
        };
      });

      await dualLogInfo(
        `[getPortfolioAndPropertyDetails] Final result for portfolio ${portfolioName}:`,
        propertyDetails.map((p) => `${p.propertyName} (${p.propertyId})`)
      );

      return {
        portfolioName,
        properties: propertyDetails,
      };
    } catch (error) {
      await dualLogError(
        `Error getting portfolio and property details for ${portfolioId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get latest Booking.com credentials from database using job_id
   * Fetches the most up-to-date password for the property associated with the job
   */
  async getBookingCredentialsFromJob(
    jobId: string
  ): Promise<{ bookingUsername?: string; bookingPassword?: string } | null> {
    try {
      // Step 1: Get job details to find property_id
      const job = await Job.findById(jobId).select("property_id").lean();

      if (!job || !job.property_id) {
        await dualLogError(
          `Cannot get credentials: Job not found or has no property_id for job ${jobId}`
        );
        return null;
      }

      // Step 2: Get property credentials using property_id
      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      })
        .select("bookingUsername bookingPassword")
        .lean();

      if (!credentials) {
        await dualLogError(
          `No Booking.com credentials found for property ${job.property_id}`
        );
        return null;
      }

      await dualLogInfo(
        `Retrieved latest Booking.com credentials from database for job ${jobId}`
      );

      return {
        bookingUsername: credentials.bookingUsername,
        bookingPassword: credentials.bookingPassword,
      };
    } catch (error) {
      await dualLogError(
        `Error getting Booking.com credentials for job ${jobId}:`,
        error
      );
      return null;
    }
  }
}

export const propertyCredentialsService = new PropertyCredentialsService();
