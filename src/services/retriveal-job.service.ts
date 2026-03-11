import { Types } from "mongoose";
import { decryptPassword } from "../common/encription.js";
import {
  FAILED_REASON,
  getFailedReasonForUser,
  hasFailedReasonCode,
  inferAgodaOtpFailedReasonCode,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import {
  IPropertyCredentials,
  PropertyCredentials,
} from "../models/property-cred.model.js";
import { IProperty } from "../models/property.model.js";
import {
  CardInfo,
  IRetrievalItem,
  PaymentInfo,
  RetrievalItem,
} from "../models/retriveal-item.model.js";
import { IRetrieval, Retrieval } from "../models/retriveal.model.js";

export interface CreateRetrievalItemData {
  retrieval_id: string;
  parent_retrieval_id: string;
  property_id: string;
  guest_name: string;
  reservation_id?: string;
  confirmation_number?: string;
  check_in_date: Date;
  check_out_date: Date;
  room_type: string;
  booking_amount?: number;
  booked_date: Date;
  has_card_info?: boolean;
  card_info?: CardInfo;
  has_payment_info?: boolean;
  payment_info?: PaymentInfo;
  reservation_status: string;
  additional_text?: string;
}

export class RetrievalService {
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
   * Get retrieval by ID
   */
  async getRetrievalById(retrievalId: string): Promise<IRetrieval | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      return await Retrieval.findById(objectId);
    } catch (error) {
      console.error(`Error getting retrieval: ${error}`);
      return null;
    }
  }

  /**
   * Get retrieval with populated property to access expedia_id
   */
  async getRetrievalWithProperty(
    retrievalId: string
  ): Promise<(IRetrieval & { property?: IProperty }) | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      return (await Retrieval.findById(objectId).populate(
        "property_id"
      )) as any;
    } catch (error) {
      console.error(`Error getting retrieval with property: ${error}`);
      return null;
    }
  }

  /**
   * Get expedia_id and credentials from retrieval's property
   */
  async getAgodaIdFromRetrieval(retrievalId: string): Promise<{
    agodaId: string;
    user_email?: string;
    user_password?: string;
    credentials?: Partial<IPropertyCredentials>;
    property?: IProperty & { credentials?: Partial<IPropertyCredentials> };
  } | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");

      const retrieval = await Retrieval.findById(objectId).populate(
        "property_id"
      );

      if (!retrieval) {
        console.log(`Retrieval ${retrievalId} not found`);
        return null;
      }

      if (!retrieval.property_id || typeof retrieval.property_id !== "object") {
        console.log(
          `Retrieval ${retrievalId} has no property_id or it's not populated`
        );
        return null;
      }

      const property = retrieval.property_id as unknown as IProperty;
      const propertyIdString = property._id.toString();

      // Get credentials
      const credentials = await PropertyCredentials.findOne({
        property_id: new Types.ObjectId(propertyIdString),
      });

      if (!credentials) {
        console.log(`No credentials found for property ${propertyIdString}`);
        // Still return agodaId even if no credentials, but check if it's valid
        const agodaId = property.agoda_id || "";
        if (!agodaId || agodaId === "0") {
          console.log(
            `Property ${propertyIdString} has invalid or missing agoda_id: ${agodaId}`
          );
          return null;
        }
        return {
          agodaId: agodaId,
          property: property,
        };
      }

      // Validate agodaId before proceeding
      const agodaId = property.agoda_id || "";
      if (!agodaId || agodaId === "0") {
        console.log(
          `Property ${propertyIdString} has invalid or missing agoda_id: ${agodaId}`
        );
        return null;
      }

      // Decrypt password if it's encrypted
      let decryptedPassword = credentials.agodaPassword;
      try {
        if (
          credentials.agodaPassword &&
          typeof credentials.agodaPassword === "string"
        ) {
          // Check if it's JSON (encrypted)
          if (credentials.agodaPassword.startsWith("{")) {
            decryptedPassword = decryptPassword(credentials.agodaPassword);
            console.log(
              `Successfully decrypted password for property ${propertyIdString}`
            );
          }
        }
      } catch (decryptError) {
        console.warn(
          `Failed to decrypt password for property ${propertyIdString}, using as-is:`,
          decryptError
        );
      }

      return {
        agodaId: agodaId,
        user_email: credentials.agodaUsername,
        user_password: decryptedPassword,
        credentials: credentials,
        property: property,
      };
    } catch (error) {
      console.error(`Error getting expedia_id from retrieval: ${error}`);
      return null;
    }
  }

  /**
   * Validate retrieval exists and can be run
   */
  async validateRetrieval(retrievalId: string): Promise<{
    exists: boolean;
    canRun: boolean;
    retrieval?: IRetrieval;
  }> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      const retrieval = await Retrieval.findById(objectId);

      if (!retrieval) {
        return { exists: false, canRun: false };
      }

      const canRun = [
        "Pending",
        "InQueue",
        "Failed",
        "Partial",
        "Stopped",
      ].includes(retrieval.job_status);

      return {
        exists: true,
        canRun,
        retrieval,
      };
    } catch (error) {
      console.error(`Error validating retrieval: ${error}`);
      return { exists: false, canRun: false };
    }
  }

  /**
   * Update retrieval status
   */
  async updateRetrievalStatus(
    retrievalId: string,
    status: string,
    additionalUpdates?: Partial<IRetrieval>
  ): Promise<IRetrieval | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");

      const updateData: any = {
        job_status: status,
        ...additionalUpdates,
      };

      if (status === "Running") {
        updateData.screenshot_urls = [];
        updateData.failed_reason = null;
      }

      return await Retrieval.findByIdAndUpdate(objectId, updateData, {
        new: true,
      });
    } catch (error) {
      console.error(`Error updating retrieval status: ${error}`);
      return null;
    }
  }

  /**
   * Update retrieval status along with a specific failed_reason message.
   * Pass null to clear an existing failed_reason.
   */
  async updateRetrievalStatusWithReason(
    retrievalId: string,
    status: string,
    failedReason?: string | null
  ): Promise<IRetrieval | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      const updateData: any = {
        job_status: status,
        updatedAt: new Date(),
      };
      if (status === "Running") {
        updateData.screenshot_urls = [];
        updateData.failed_reason = null;
      }
      if (failedReason !== undefined) {
        updateData.failed_reason = failedReason ?? null;
      }
      return await Retrieval.findByIdAndUpdate(objectId, updateData, {
        new: true,
      });
    } catch (error) {
      console.error(`Error updating retrieval status with reason: ${error}`);
      return null;
    }
  }

  /**
   * Set retrieval to Failed while preserving any failed_reason already saved by
   * an inner catch block (first-writer-wins). Only writes a fallback reason when
   * the DB document has no failed_reason yet.
   */
  async failRetrievalSafe(
    retrievalId: string,
    fallbackReason?: string
  ): Promise<IRetrieval | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      const existing = await Retrieval.findById(objectId).select("failed_reason");
      const reason = existing?.failed_reason ?? fallbackReason ?? null;
      return await Retrieval.findByIdAndUpdate(
        objectId,
        { job_status: "Failed", failed_reason: reason, updatedAt: new Date() },
        { new: true }
      );
    } catch (error) {
      console.error(`Error in failRetrievalSafe: ${error}`);
      return null;
    }
  }

  /**
   * Append a screenshot URL entry to the retrieval document
   */
  async addScreenshotUrl(
    retrievalId: string,
    entry: { step: string; url: string; timestamp: string; type: "step" | "error" }
  ): Promise<void> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      await Retrieval.findByIdAndUpdate(objectId, {
        $push: { screenshot_urls: entry },
        updatedAt: new Date(),
      });
    } catch (error) {
      console.error(`Error adding screenshot URL to retrieval: ${error}`);
    }
  }

  /**
   * Get reservations from retrieval
   */
  async getReservationsFromRetrieval(
    retrievalId: string
  ): Promise<string[] | null> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      const retrieval = await Retrieval.findById(objectId);

      if (!retrieval) {
        console.log(`Retrieval ${retrievalId} not found`);
        return null;
      }

      return retrieval.reservations || [];
    } catch (error) {
      console.error(`Error getting reservations from retrieval: ${error}`);
      return null;
    }
  }

  /**
   * Create retrieval item (scraped data)
   */
  async createRetrievalItem(
    itemData: CreateRetrievalItemData
  ): Promise<IRetrievalItem> {
    try {
      const retrievalObjectId = this.validateObjectId(
        itemData.retrieval_id,
        "retrieval_id"
      );
      const parentRetrievalObjectId = this.validateObjectId(
        itemData.parent_retrieval_id,
        "parent_retrieval_id"
      );
      const propertyObjectId = this.validateObjectId(
        itemData.property_id,
        "property_id"
      );

      const retrievalItem = new RetrievalItem({
        ...itemData,
        retrieval_id: retrievalObjectId,
        parent_retrieval_id: parentRetrievalObjectId,
        property_id: propertyObjectId,
        has_card_info: itemData.has_card_info || false,
        has_payment_info: itemData.has_payment_info || false,
      });

      return await retrievalItem.save();
    } catch (error) {
      console.error(`Error creating retrieval item: ${error}`);
      throw error;
    }
  }

  /**
   * Upsert retrieval item (update if exists, create if not)
   */
  async upsertRetrievalItem(
    itemData: CreateRetrievalItemData
  ): Promise<IRetrievalItem> {
    try {
      const retrievalObjectId = this.validateObjectId(
        itemData.retrieval_id,
        "retrieval_id"
      );
      const parentRetrievalObjectId = this.validateObjectId(
        itemData.parent_retrieval_id,
        "parent_retrieval_id"
      );
      const propertyObjectId = this.validateObjectId(
        itemData.property_id,
        "property_id"
      );

      const updateData = {
        ...itemData,
        retrieval_id: retrievalObjectId,
        parent_retrieval_id: parentRetrievalObjectId,
        property_id: propertyObjectId,
        has_card_info: itemData.has_card_info || false,
        has_payment_info: itemData.has_payment_info || false,
      };

      // Use findOneAndUpdate with upsert option
      // This will update if a document exists with the same retrieval_id and reservation_id
      // Otherwise it will create a new document
      const result = await RetrievalItem.findOneAndUpdate(
        {
          retrieval_id: retrievalObjectId,
          reservation_id: itemData.reservation_id,
        },
        updateData,
        {
          upsert: true, // Create if not exists
          new: true, // Return the updated document
          setDefaultsOnInsert: true, // Set default values on insert
        }
      );

      return result;
    } catch (error) {
      console.error(`Error upserting retrieval item: ${error}`);
      throw error;
    }
  }

  /**
   * Get retrieval items by retrieval ID
   */
  async getRetrievalItems(
    retrievalId: string,
    limit?: number
  ): Promise<IRetrievalItem[]> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");

      const query = RetrievalItem.find({ retrieval_id: objectId }).sort({
        createdAt: -1,
      });

      if (limit) {
        query.limit(limit);
      }

      return await query;
    } catch (error) {
      console.error(`Error getting retrieval items: ${error}`);
      return [];
    }
  }

  /**
   * Get retrieval items count
   */
  async getRetrievalItemsCount(retrievalId: string): Promise<number> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");
      return await RetrievalItem.countDocuments({ retrieval_id: objectId });
    } catch (error) {
      console.error(`Error getting retrieval items count: ${error}`);
      return 0;
    }
  }

  /**
   * Get retrieval progress statistics
   */
  async getRetrievalProgress(retrievalId: string): Promise<{
    totalItems: number;
    itemsWithCardInfo: number;
    itemsWithPaymentInfo: number;
    completionPercentage: number;
  }> {
    try {
      const objectId = this.validateObjectId(retrievalId, "retrievalId");

      const totalItems = await RetrievalItem.countDocuments({
        retrieval_id: objectId,
      });
      const itemsWithCardInfo = await RetrievalItem.countDocuments({
        retrieval_id: objectId,
        has_card_info: true,
      });
      const itemsWithPaymentInfo = await RetrievalItem.countDocuments({
        retrieval_id: objectId,
        has_payment_info: true,
      });

      const completionPercentage =
        totalItems > 0
          ? Math.round(
              ((itemsWithCardInfo + itemsWithPaymentInfo) / (totalItems * 2)) *
                100
            )
          : 0;

      return {
        totalItems,
        itemsWithCardInfo,
        itemsWithPaymentInfo,
        completionPercentage,
      };
    } catch (error) {
      console.error(`Error getting retrieval progress: ${error}`);
      return {
        totalItems: 0,
        itemsWithCardInfo: 0,
        itemsWithPaymentInfo: 0,
        completionPercentage: 0,
      };
    }
  }

  /**
   * Update retrieval item with card info
   */
  async updateRetrievalItemCardInfo(
    retrievalId: string,
    reservationId: string,
    cardInfo: CardInfo
  ): Promise<IRetrievalItem | null> {
    try {
      const retrievalObjectId = this.validateObjectId(
        retrievalId,
        "retrievalId"
      );

      const result = await RetrievalItem.findOneAndUpdate(
        {
          retrieval_id: retrievalObjectId,
          reservation_id: reservationId,
        },
        {
          has_card_info: true,
          card_info: cardInfo,
          updatedAt: new Date(),
        },
        { new: true }
      );

      return result;
    } catch (error) {
      console.error(`Error updating retrieval item card info: ${error}`);
      return null;
    }
  }

  /**
   * Check if any card info was saved for a retrieval
   */
  async hasAnyCardInfo(retrievalId: string): Promise<{
    hasCardInfo: boolean;
    totalBookings: number;
    bookingsWithCardInfo: number;
  }> {
    try {
      const retrievalObjectId = this.validateObjectId(
        retrievalId,
        "retrievalId"
      );

      const totalBookings = await RetrievalItem.countDocuments({
        retrieval_id: retrievalObjectId,
      });

      const bookingsWithCardInfo = await RetrievalItem.countDocuments({
        retrieval_id: retrievalObjectId,
        has_card_info: true,
      });

      return {
        hasCardInfo: bookingsWithCardInfo > 0,
        totalBookings,
        bookingsWithCardInfo,
      };
    } catch (error) {
      console.error(`Error checking card info for retrieval: ${error}`);
      return {
        hasCardInfo: false,
        totalBookings: 0,
        bookingsWithCardInfo: 0,
      };
    }
  }
}

// Export singleton instance
export const retrievalService = new RetrievalService();

// Re-export failed-reason helpers for convenience
export {
  FAILED_REASON,
  getFailedReasonForUser,
  hasFailedReasonCode,
  inferAgodaOtpFailedReasonCode,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "../common/failed-reason.js";
