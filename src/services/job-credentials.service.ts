import { Types } from "mongoose";
import { Job } from "../models/job.model.js";
import {
  IPropertyCredentials,
  PropertyCredentials,
} from "../models/property-credentials.model.js";
import { IProperty, Property } from "../models/property.model.js";

export interface CreatePropertyCredentialsData {
  property_id: string;
  expediaUsername?: string;
  expediaPassword?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  bookingUsername?: string;
  bookingPassword?: string;
  expediaEmailAssociated?: string;
  propertyContactEmail?: string;
  portfolioContactEmail?: string;
  multiplePortfolioEmails?: string[];
}

export interface UpdatePropertyCredentialsData {
  expediaUsername?: string;
  expediaPassword?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  bookingUsername?: string;
  bookingPassword?: string;
  expediaEmailAssociated?: string;
  propertyContactEmail?: string;
  portfolioContactEmail?: string;
  multiplePortfolioEmails?: string[];
}

export interface PropertyCredentialsResponse {
  expediaUsername?: string;
  expediaPassword?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  bookingUsername?: string;
  bookingPassword?: string;
  expediaEmailAssociated?: string;
  propertyContactEmail?: string;
  portfolioContactEmail?: string;
  multiplePortfolioEmails: string[];
}

export class PropertyCredentialsService {
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
   * Create property credentials
   */
  async createPropertyCredentials(
    credentialsData: CreatePropertyCredentialsData
  ): Promise<IPropertyCredentials> {
    try {
      const propertyObjectId = this.validateObjectId(
        credentialsData.property_id,
        "property_id"
      );

      // Check if property exists
      const property = await Property.findById(propertyObjectId);
      if (!property) {
        throw new Error(`Property not found: ${credentialsData.property_id}`);
      }

      // Check if credentials already exist for this property
      const existingCredentials = await PropertyCredentials.findOne({
        property_id: propertyObjectId,
      });
      if (existingCredentials) {
        throw new Error(
          `Credentials already exist for property: ${credentialsData.property_id}`
        );
      }

      const credentials = new PropertyCredentials({
        ...credentialsData,
        property_id: propertyObjectId,
        multiplePortfolioEmails: credentialsData.multiplePortfolioEmails || [],
      });

      return await credentials.save();
    } catch (error) {
      console.error(`Error creating property credentials: ${error}`);
      throw error;
    }
  }

  /**
   * Get property credentials by property ID
   */
  async getCredentialsByPropertyId(
    propertyId: string
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");
      return await PropertyCredentials.findOne({ property_id: objectId });
    } catch (error) {
      console.error(`Error getting credentials by property ID: ${error}`);
      return null;
    }
  }

  /**
   * Get property credentials by credentials ID
   */
  async getCredentialsById(
    credentialsId: string
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(credentialsId, "credentialsId");
      return await PropertyCredentials.findById(objectId);
    } catch (error) {
      console.error(`Error getting credentials by ID: ${error}`);
      return null;
    }
  }

  /**
   * Update property credentials
   */
  async updatePropertyCredentials(
    propertyId: string,
    updateData: UpdatePropertyCredentialsData
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");

      return await PropertyCredentials.findOneAndUpdate(
        { property_id: objectId },
        {
          ...updateData,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating property credentials: ${error}`);
      return null;
    }
  }

  /**
   * Update credentials by credentials ID
   */
  async updateCredentialsById(
    credentialsId: string,
    updateData: UpdatePropertyCredentialsData
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(credentialsId, "credentialsId");

      return await PropertyCredentials.findByIdAndUpdate(
        objectId,
        {
          ...updateData,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error updating credentials by ID: ${error}`);
      return null;
    }
  }

  /**
   * Delete property credentials
   */
  async deletePropertyCredentials(propertyId: string): Promise<boolean> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");
      const result = await PropertyCredentials.deleteOne({
        property_id: objectId,
      });
      return result.deletedCount > 0;
    } catch (error) {
      console.error(`Error deleting property credentials: ${error}`);
      return false;
    }
  }

  /**
   * Get property credentials by job ID
   */
  async getCredentialsByJobId(
    jobId: string
  ): Promise<IPropertyCredentials | null> {
    try {
      const jobObjectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(jobObjectId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      });

      if (!credentials) {
        console.error(`No credentials found for property: ${job.property_id}`);
        return null;
      }

      console.log(
        `Found credentials for job: ${jobId}, property: ${job.property_id}`
      );

      return credentials;
    } catch (error) {
      console.error(`Error getting credentials for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Get Expedia credentials from job
   */
  async getExpediaCredentialsFromJob(jobId: string): Promise<{
    expediaUsername?: string;
    expediaPassword?: string;
    expediaEmailAssociated?: string;
    propertyId?: string;
  } | null> {
    try {
      const jobObjectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(jobObjectId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      });

      if (!credentials) {
        console.error(`No credentials found for property: ${job.property_id}`);
        return null;
      }

      console.log(
        `✅ Found Expedia credentials for job: ${jobId}, property: ${job.property_id}`
      );

      return {
        expediaUsername: credentials.expediaUsername,
        expediaPassword: credentials.expediaPassword,
        expediaEmailAssociated: credentials.expediaEmailAssociated,
        propertyId: job.property_id.toString(),
      };
    } catch (error) {
      console.error(
        `Error getting Expedia credentials for job ${jobId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get Agoda credentials from job
   */
  async getAgodaCredentialsFromJob(jobId: string): Promise<{
    agodaUsername?: string;
    agodaPassword?: string;
    propertyId?: string;
  } | null> {
    try {
      const jobObjectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(jobObjectId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      });

      if (!credentials) {
        console.error(`No credentials found for property: ${job.property_id}`);
        return null;
      }

      console.log(
        `✅ Found Agoda credentials for job: ${jobId}, property: ${job.property_id}`
      );

      return {
        agodaUsername: credentials.agodaUsername,
        agodaPassword: credentials.agodaPassword,
        propertyId: job.property_id.toString(),
      };
    } catch (error) {
      console.error(`Error getting Agoda credentials for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Get Booking.com credentials from job
   */
  async getBookingCredentialsFromJob(jobId: string): Promise<{
    bookingUsername?: string;
    bookingPassword?: string;
    propertyId?: string;
  } | null> {
    try {
      const jobObjectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(jobObjectId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      });

      if (!credentials) {
        console.error(`No credentials found for property: ${job.property_id}`);
        return null;
      }

      console.log(
        `✅ Found Booking credentials for job: ${jobId}, property: ${job.property_id}`
      );

      return {
        bookingUsername: credentials.bookingUsername,
        bookingPassword: credentials.bookingPassword,
        propertyId: job.property_id.toString(),
      };
    } catch (error) {
      console.error(
        `Error getting Booking credentials for job ${jobId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get all credentials from job (all OTA providers)
   */
  async getAllCredentialsFromJob(
    jobId: string
  ): Promise<PropertyCredentialsResponse | null> {
    try {
      const jobObjectId = this.validateObjectId(jobId, "jobId");
      const job = await Job.findById(jobObjectId);

      if (!job) {
        console.error(`Job not found: ${jobId}`);
        return null;
      }

      if (!job.property_id) {
        console.error(`Job ${jobId} has no property_id assigned`);
        return null;
      }

      const credentials = await PropertyCredentials.findOne({
        property_id: job.property_id,
      });

      if (!credentials) {
        console.error(`No credentials found for property: ${job.property_id}`);
        return null;
      }

      console.log(
        `✅ Found all credentials for job: ${jobId}, property: ${job.property_id}`
      );

      return {
        expediaUsername: credentials.expediaUsername,
        expediaPassword: credentials.expediaPassword,
        agodaUsername: credentials.agodaUsername,
        agodaPassword: credentials.agodaPassword,
        bookingUsername: credentials.bookingUsername,
        bookingPassword: credentials.bookingPassword,
        expediaEmailAssociated: credentials.expediaEmailAssociated,
        propertyContactEmail: credentials.propertyContactEmail,
        portfolioContactEmail: credentials.portfolioContactEmail,
        multiplePortfolioEmails: credentials.multiplePortfolioEmails,
      };
    } catch (error) {
      console.error(`Error getting all credentials for job ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Check if credentials exist for property
   */
  async credentialsExist(propertyId: string): Promise<boolean> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");
      const count = await PropertyCredentials.countDocuments({
        property_id: objectId,
      });
      return count > 0;
    } catch (error) {
      console.error(`Error checking if credentials exist: ${error}`);
      return false;
    }
  }

  /**
   * Get credentials with property details
   */
  async getCredentialsWithProperty(
    propertyId: string
  ): Promise<(IPropertyCredentials & { property?: IProperty }) | null> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");
      return (await PropertyCredentials.findOne({
        property_id: objectId,
      }).populate("property_id")) as any;
    } catch (error) {
      console.error(`Error getting credentials with property: ${error}`);
      return null;
    }
  }

  /**
   * Add email to multiple portfolio emails
   */
  async addPortfolioEmail(
    propertyId: string,
    email: string
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");

      return await PropertyCredentials.findOneAndUpdate(
        { property_id: objectId },
        {
          $addToSet: { multiplePortfolioEmails: email },
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error adding portfolio email: ${error}`);
      return null;
    }
  }

  /**
   * Remove email from multiple portfolio emails
   */
  async removePortfolioEmail(
    propertyId: string,
    email: string
  ): Promise<IPropertyCredentials | null> {
    try {
      const objectId = this.validateObjectId(propertyId, "propertyId");

      return await PropertyCredentials.findOneAndUpdate(
        { property_id: objectId },
        {
          $pull: { multiplePortfolioEmails: email },
          updatedAt: new Date(),
        },
        { new: true }
      );
    } catch (error) {
      console.error(`Error removing portfolio email: ${error}`);
      return null;
    }
  }

  /**
   * Get all properties with credentials
   */
  async getAllPropertiesWithCredentials(): Promise<IPropertyCredentials[]> {
    try {
      return await PropertyCredentials.find()
        .populate("property_id", "property_name expedia_id")
        .sort({ createdAt: -1 })
        .exec();
    } catch (error) {
      console.error(`Error getting all properties with credentials: ${error}`);
      return [];
    }
  }

  /**
   * Get credentials count
   */
  async getCredentialsCount(): Promise<number> {
    try {
      return await PropertyCredentials.countDocuments();
    } catch (error) {
      console.error(`Error getting credentials count: ${error}`);
      return 0;
    }
  }
}

// Export singleton instance
export const propertyCredentialsService = new PropertyCredentialsService();
