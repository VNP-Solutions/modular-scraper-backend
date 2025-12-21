import mongoose, { Types } from "mongoose";
import { DbEntry, IDbEntry } from "../models/db-entry.model.js";

export interface CreateDbEntryInput {
  job_id: string;
  property_name: string;
  property_id: string;
  db_data_id: string;
  reservation_id: string;
  invoice_id: string;
  guest_name: string;
  check_in_date: Date | string;
  check_out_date: Date | string;
  previously_paid_amount: number;
  previously_paid_amount_currency: string;
  maximum_billable_amount: number;
  maximum_billable_amount_currency: string;
  requested_booking_amount: number;
  requested_taxes: number;
  requested_total: number;
  requested_total_currency: string;
}

export class DbEntryService {
  /**
   * Create a new DB entry record
   */
  async createDbEntry(data: CreateDbEntryInput): Promise<IDbEntry> {
    // Parse dates if they are strings
    const parseDate = (date: Date | string): Date => {
      if (date instanceof Date) return date;
      if (typeof date === "string") {
        // Handle different date formats
        const parsed = new Date(date);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
      }
      return new Date();
    };

    const dbEntry = new DbEntry({
      job_id: new mongoose.Types.ObjectId(data.job_id),
      property_name: data.property_name,
      property_id: data.property_id,
      db_data_id: new mongoose.Types.ObjectId(data.db_data_id),
      reservation_id: data.reservation_id,
      invoice_id: data.invoice_id,
      guest_name: data.guest_name,
      check_in_date: parseDate(data.check_in_date),
      check_out_date: parseDate(data.check_out_date),
      previously_paid_amount: data.previously_paid_amount,
      previously_paid_amount_currency: data.previously_paid_amount_currency,
      maximum_billable_amount: data.maximum_billable_amount,
      maximum_billable_amount_currency: data.maximum_billable_amount_currency,
      requested_booking_amount: data.requested_booking_amount,
      requested_taxes: data.requested_taxes,
      requested_total: data.requested_total,
      requested_total_currency: data.requested_total_currency,
    });

    return await dbEntry.save();
  }

  /**
   * Create multiple DB entry records in bulk
   */
  async createDbEntries(entries: CreateDbEntryInput[]): Promise<IDbEntry[]> {
    const parseDate = (date: Date | string): Date => {
      if (date instanceof Date) return date;
      if (typeof date === "string") {
        const parsed = new Date(date);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
      }
      return new Date();
    };

    const dbEntries = entries.map((data) => ({
      job_id: new mongoose.Types.ObjectId(data.job_id),
      property_name: data.property_name,
      property_id: data.property_id,
      db_data_id: new mongoose.Types.ObjectId(data.db_data_id),
      reservation_id: data.reservation_id,
      invoice_id: data.invoice_id,
      guest_name: data.guest_name,
      check_in_date: parseDate(data.check_in_date),
      check_out_date: parseDate(data.check_out_date),
      previously_paid_amount: data.previously_paid_amount,
      previously_paid_amount_currency: data.previously_paid_amount_currency,
      maximum_billable_amount: data.maximum_billable_amount,
      maximum_billable_amount_currency: data.maximum_billable_amount_currency,
      requested_booking_amount: data.requested_booking_amount,
      requested_taxes: data.requested_taxes,
      requested_total: data.requested_total,
      requested_total_currency: data.requested_total_currency,
    }));

    return await DbEntry.insertMany(dbEntries);
  }

  /**
   * Get all DB entry records for a specific db_data_id
   */
  async getDbEntriesByDbDataId(dbDataId: string): Promise<IDbEntry[]> {
    return await DbEntry.find({
      db_data_id: new Types.ObjectId(dbDataId),
    })
      .sort({ created_at: -1 })
      .exec();
  }

  /**
   * Get all DB entry records for a specific job
   */
  async getDbEntriesByJobId(jobId: string): Promise<IDbEntry[]> {
    return await DbEntry.find({ job_id: new Types.ObjectId(jobId) })
      .sort({ created_at: -1 })
      .exec();
  }

  /**
   * Get a specific DB entry record by ID
   */
  async getDbEntryById(id: string): Promise<IDbEntry | null> {
    return await DbEntry.findById(id).exec();
  }

  /**
   * Delete a DB entry record
   */
  async deleteDbEntry(id: string): Promise<boolean> {
    const result = await DbEntry.findByIdAndDelete(id).exec();
    return result !== null;
  }
}

// Export singleton instance
export const dbEntryService = new DbEntryService();
