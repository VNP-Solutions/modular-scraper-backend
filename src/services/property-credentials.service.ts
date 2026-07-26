import { Types } from "mongoose";
import { encryptPassword } from "../common/encription.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { Job } from "../models/job.model.js";
import { PropertyCredentials } from "../models/Property-credentials.js";
import { Property } from "../models/property.model.js";
import { dbmsRecurringJobsService } from "./dbms-recurring-jobs.service.js";

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
   * Update booking password for ALL properties with the same username AND same portfolio
   * Finds all properties that share the same bookingUsername within the same portfolio and updates all their passwords
   */
  async updateBookingPasswordByJobId(
    jobId: string,
    newPassword: string
  ): Promise<{
    success: boolean;
    affectedProperties: Array<{ propertyId: string; propertyName: string }>;
    username: string;
    totalUpdated: number;
  }> {
    try {
      await dualLogInfo(
        `Updating booking password for all properties with same username and same portfolio (job ${jobId})...`
      );

      // Step 1: Get job details to find the specific property_id and portfolio_id
      const job = await Job.findById(jobId).select("property_id portfolio_id").lean();

      if (!job) {
        await dualLogError(`Job not found with ID: ${jobId}`);
        return {
          success: false,
          affectedProperties: [],
          username: "",
          totalUpdated: 0,
        };
      }

      if (!job.property_id) {
        await dualLogError(`Job ${jobId} has no property_id`);
        return {
          success: false,
          affectedProperties: [],
          username: "",
          totalUpdated: 0,
        };
      }

      if (!job.portfolio_id) {
        await dualLogError(`Job ${jobId} has no portfolio_id`);
        return {
          success: false,
          affectedProperties: [],
          username: "",
          totalUpdated: 0,
        };
      }

      await dualLogInfo(
        `Found portfolio_id: ${job.portfolio_id} for job ${jobId}`
      );

      // Step 2: Get credentials for this property to find the username
      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      })
        .select("bookingUsername")
        .lean();

      if (!credentials || !credentials.bookingUsername) {
        await dualLogError(
          `No booking username found for property ${job.property_id} (job ${jobId})`
        );
        return {
          success: false,
          affectedProperties: [],
          username: "",
          totalUpdated: 0,
        };
      }

      const username = credentials.bookingUsername;
      await dualLogInfo(
        `Found username: ${username}, searching for all properties with same username in portfolio ${job.portfolio_id}...`
      );

      // Step 3: Find all property_ids that belong to the same portfolio AND build property name map from jobs
      const portfolioJobs = await Job.find({ portfolio_id: job.portfolio_id })
        .select("property_id property_name")
        .lean();

      const portfolioPropertyIds = [
        ...new Set(
          portfolioJobs
            .map((j) => j.property_id?.toString())
            .filter((id): id is string => id !== undefined)
        ),
      ].map((id) => new Types.ObjectId(id));

      // Build a map of property_id -> property_name from jobs as fallback
      const jobPropertyNameMap = new Map<string, string>();
      portfolioJobs.forEach((j) => {
        if (j.property_id && j.property_name) {
          jobPropertyNameMap.set(j.property_id.toString(), j.property_name);
        }
      });

      await dualLogInfo(
        `Found ${portfolioPropertyIds.length} properties in portfolio ${job.portfolio_id}`
      );
      await dualLogInfo(
        `Built property name map from ${jobPropertyNameMap.size} jobs`
      );

      // Step 4: Find ALL properties with the same bookingUsername AND in the same portfolio
      const allMatchingCredentials = await PropertyCredentials.find({
        bookingUsername: username,
        property_id: { $in: portfolioPropertyIds },
      })
        .select("property_id")
        .lean();

      await dualLogInfo(
        `Found ${allMatchingCredentials.length} properties with username: ${username} in portfolio ${job.portfolio_id}`
      );

      // Step 5: Encrypt the password
      const encryptedPassword = encryptPassword(newPassword);

      // Step 6: Update ALL properties with the same username AND same portfolio
      const updateResult = await PropertyCredentials.updateMany(
        {
          bookingUsername: username,
          property_id: { $in: portfolioPropertyIds },
        },
        {
          $set: {
            bookingPassword: encryptedPassword,
          },
        }
      );

      await dualLogInfo(
        `Updated ${updateResult.modifiedCount} property credentials with new password`
      );

      // Step 7: Get property names for all affected properties
      const propertyIds = allMatchingCredentials.map((c) => c.property_id);
      
      await dualLogInfo(
        `Fetching property names for ${propertyIds.length} property IDs...`
      );
      await dualLogInfo(
        `Property IDs to fetch: ${propertyIds.map(id => id.toString()).join(", ")}`
      );

      // Try to get property names from Property collection first
      const properties = await Property.find({
        _id: { $in: propertyIds },
      })
        .select("_id property_name")
        .lean();

      await dualLogInfo(
        `Found ${properties.length} properties in Property collection`
      );

      // Map property IDs to names from Property collection
      const propertyMap = new Map<string, string>();
      properties.forEach((prop: any) => {
        if (prop.property_name) {
          propertyMap.set(prop._id.toString(), prop.property_name);
        }
      });

      await dualLogInfo(
        `Mapped ${propertyMap.size} property names from Property collection`
      );

      // Build affected properties array with fallback to Job property names
      const affectedProperties = allMatchingCredentials.map((cred) => {
        const propertyId = cred.property_id.toString();
        let propertyName = propertyMap.get(propertyId);
        
        // Fallback to job property name if not found in Property collection
        if (!propertyName) {
          propertyName = jobPropertyNameMap.get(propertyId);
        }
        
        // Final fallback
        if (!propertyName) {
          propertyName = "Unknown Property";
        }

        return {
          propertyId,
          propertyName,
        };
      });

      // Log if any properties didn't get matched
      const unmatchedCount = affectedProperties.filter(
        (p) => p.propertyName === "Unknown Property"
      ).length;
      if (unmatchedCount > 0) {
        await dualLogError(
          `WARNING: ${unmatchedCount} properties could not be matched to Property or Job collections`
        );
        await dualLogError(
          `Unmatched property IDs: ${affectedProperties
            .filter((p) => p.propertyName === "Unknown Property")
            .map((p) => p.propertyId)
            .join(", ")}`
        );
      } else {
        await dualLogInfo(
          `Successfully resolved all ${affectedProperties.length} property names`
        );
      }

      await dualLogInfo(
        `Successfully updated booking password for ${affectedProperties.length} properties with username: ${username} in portfolio ${job.portfolio_id}`
      );
      await dualLogInfo(
        `Affected properties: ${affectedProperties
          .map((p) => `${p.propertyName} (${p.propertyId})`)
          .join(", ")}`
      );

      await dbmsRecurringJobsService.syncBookingCredentialsForProperties({
        bookingUsername: username,
        bookingPassword: newPassword,
        propertyIds: affectedProperties.map((p) => p.propertyId),
      });

      return {
        success: true,
        affectedProperties,
        username,
        totalUpdated: updateResult.modifiedCount,
      };
    } catch (error) {
      await dualLogError(
        `Error updating booking password by job ID ${jobId}:`,
        error
      );
      return {
        success: false,
        affectedProperties: [],
        username: "",
        totalUpdated: 0,
      };
    }
  }

  /**
   * Get single property details from a job ID
   * Returns property and portfolio information for the specific job
   */
  async getPropertyDetailsFromJobId(jobId: string): Promise<{
    propertyName: string;
    portfolioName: string;
    propertyId: Types.ObjectId;
  } | null> {
    try {
      await dualLogInfo(
        `[getPropertyDetailsFromJobId] Getting property details for job: ${jobId}`
      );

      // Get job details
      const job = await Job.findById(jobId)
        .select("property_id portfolio_id property_name portfolio_name")
        .lean();

      if (!job) {
        await dualLogError(`Job not found with ID: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        await dualLogError(`Job ${jobId} has no property_id`);
        return null;
      }

      // Get property details from Property collection
      const property = await Property.findById(job.property_id)
        .select("_id property_name")
        .lean();

      // Use property name from Property collection if available, fallback to job's property_name
      const propertyName =
        property?.property_name || job.property_name || "Unknown Property";
      const portfolioName = job.portfolio_name || "Unknown Portfolio";

      await dualLogInfo(
        `[getPropertyDetailsFromJobId] Found property: ${propertyName} in portfolio: ${portfolioName}`
      );

      return {
        propertyName,
        portfolioName,
        propertyId: job.property_id,
      };
    } catch (error) {
      await dualLogError(
        `Error getting property details for job ${jobId}:`,
        error
      );
      return null;
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
