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
  AgodaCaseItem,
  IAgodaCaseItem,
} from "../models/agoda-case-item.model.js";
import { JobItem } from "../models/job-item.model.js";
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

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function usableGuestName(name?: string | null): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "—") return undefined;
  return trimmed;
}

function toAgodaCaseItemDate(date?: Date | string | null): string | undefined {
  if (!date) return undefined;

  const formatUtcDate = (value: Date): string | undefined => {
    if (isNaN(value.getTime())) return undefined;
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    const year = value.getUTCFullYear();
    return `${month}/${day}/${year}`;
  };

  if (date instanceof Date) {
    return formatUtcDate(date);
  }

  const trimmed = String(date).trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
  }

  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const month = usMatch[1].padStart(2, "0");
    const day = usMatch[2].padStart(2, "0");
    return `${month}/${day}/${usMatch[3]}`;
  }

  const parsed = new Date(trimmed);
  return formatUtcDate(parsed);
}

function toAmountString(value?: number | string | null): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") {
    if (isNaN(value)) return undefined;
    return value.toFixed(2);
  }
  const trimmed = String(value).trim();
  return trimmed || undefined;
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
   * After a reservation card scrape, persist VCC + stay/charge fields on AgodaCaseItem.
   */
  async updateAgodaCaseItemFromCardScrape(
    retrievalId: string,
    reservationId: string,
    cardInfo: CardInfo
  ): Promise<IAgodaCaseItem | null> {
    try {
      const retrievalObjectId = this.validateObjectId(
        retrievalId,
        "retrievalId"
      );

      const [retrieval, retrievalItem, existingCaseItem] = await Promise.all([
        Retrieval.findById(retrievalObjectId),
        RetrievalItem.findOne({
          retrieval_id: retrievalObjectId,
          reservation_id: reservationId,
        }),
        AgodaCaseItem.findOne({
          retrieval_id: retrievalObjectId,
          reservation_id: reservationId,
        }),
      ]);

      let jobItem = null;
      const jobItemFilter: Record<string, unknown> = {
        reservation_id: reservationId,
      };
      if (retrieval?.property_id) {
        jobItemFilter.property_id = retrieval.property_id;
      }
      jobItem = await JobItem.findOne(jobItemFilter).sort({ createdAt: -1 });

      const guestName = firstNonEmpty(
        usableGuestName(retrievalItem?.guest_name),
        jobItem?.guest_name,
        existingCaseItem?.guest_name
      );
      const checkIn = firstNonEmpty(
        toAgodaCaseItemDate(retrievalItem?.check_in_date),
        toAgodaCaseItemDate(jobItem?.check_in_date),
        toAgodaCaseItemDate(existingCaseItem?.check_in)
      );
      const checkOut = firstNonEmpty(
        toAgodaCaseItemDate(retrievalItem?.check_out_date),
        toAgodaCaseItemDate(jobItem?.check_out_date),
        toAgodaCaseItemDate(existingCaseItem?.check_out)
      );
      const amountToCharge = firstNonEmpty(
        toAmountString(jobItem?.payment_info?.amount_to_charge_or_refund),
        toAmountString(
          retrievalItem?.payment_info?.amount_to_charge_or_refund
        ),
        existingCaseItem?.amount_to_charge,
        existingCaseItem?.amount
      );
      const currency = firstNonEmpty(
        jobItem?.payment_info?.amount_to_charge_or_refund_currency,
        retrievalItem?.payment_info?.amount_to_charge_or_refund_currency,
        existingCaseItem?.currency
      );

      const setFields: Record<string, unknown> = {
        vcc_card_number: cardInfo.card_number,
        card_expire: cardInfo.expiry_date,
        retrival_status: "confirmed",
        charge_status: "ready_to_charge",
        is_missing: false,
      };
      if (cardInfo.cvv) setFields.card_cvv = cardInfo.cvv;
      if (guestName) setFields.guest_name = guestName;
      if (checkIn) setFields.check_in = checkIn;
      if (checkOut) setFields.check_out = checkOut;
      if (amountToCharge) setFields.amount_to_charge = amountToCharge;
      if (currency) setFields.currency = currency;

      const setOnInsert: Record<string, unknown> = {
        reservation_id: reservationId,
        retrieval_id: retrievalObjectId,
      };
      if (retrieval?.property_id) setOnInsert.property_id = retrieval.property_id;
      if (retrieval?.batch_id) setOnInsert.batch_id = retrieval.batch_id;
      if (retrieval?.portfolio_id)
        setOnInsert.portfolio_id = retrieval.portfolio_id;

      const result = await AgodaCaseItem.findOneAndUpdate(
        {
          retrieval_id: retrievalObjectId,
          reservation_id: reservationId,
        },
        {
          $set: setFields,
          $setOnInsert: setOnInsert,
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      return result;
    } catch (error) {
      console.error(
        `Error updating AgodaCaseItem from card scrape: ${error}`
      );
      return null;
    }
  }

  /**
   * Update retrieval item with guest name and stay dates (partial update, like card info).
   * Does not upsert; returns null if the item does not exist.
   */
  async updateRetrievalItemGuestAndDates(
    retrievalId: string,
    reservationId: string,
    data: {
      guest_name: string;
      check_in_date: Date;
      check_out_date: Date;
      room_type?: string;
      reservation_status?: string;
    }
  ): Promise<IRetrievalItem | null> {
    try {
      const retrievalObjectId = this.validateObjectId(
        retrievalId,
        "retrievalId"
      );

      const updateFields: Record<string, unknown> = {
        guest_name: data.guest_name,
        check_in_date: data.check_in_date,
        check_out_date: data.check_out_date,
        updatedAt: new Date(),
      };
      if (data.room_type !== undefined) updateFields.room_type = data.room_type;
      if (data.reservation_status !== undefined)
        updateFields.reservation_status = data.reservation_status;

      const result = await RetrievalItem.findOneAndUpdate(
        {
          retrieval_id: retrievalObjectId,
          reservation_id: reservationId,
        },
        updateFields,
        { new: true }
      );

      return result;
    } catch (error) {
      console.error(
        `Error updating retrieval item guest and dates: ${error}`
      );
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
