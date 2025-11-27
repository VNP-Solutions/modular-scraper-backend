import mongoose, { Types } from "mongoose";
import { DbData, IDbData } from "../models/db-data.model.js";

export interface CreateDbDataInput {
  job_id: string;
  property_name: string;
  property_id: string;
  date_range: {
    start_date: string;
    end_date: string;
  };
  gearbox_queue_ids: string[];
  total_invoice_amount: number;
  total_invoice_amount_currency?: string;
}

export class DbDataService {
  /**
   * Create a new DB data record
   */
  async createDbData(data: CreateDbDataInput): Promise<IDbData> {
    const dbData = new DbData({
      job_id: new mongoose.Types.ObjectId(data.job_id),
      property_name: data.property_name,
      property_id: data.property_id,
      date_range: {
        start_date: data.date_range.start_date,
        end_date: data.date_range.end_date,
      },
      gearbox_queue_ids: data.gearbox_queue_ids,
      total_invoice_amount: data.total_invoice_amount,
      total_invoice_amount_currency: data.total_invoice_amount_currency,
    });

    return await dbData.save();
  }

  /**
   * Get all DB data records for a specific job
   */
  async getDbDataByJobId(jobId: string): Promise<IDbData[]> {
    return await DbData.find({ job_id: new Types.ObjectId(jobId) })
      .sort({ created_at: -1 })
      .exec();
  }

  /**
   * Get all DB data records for a specific property
   */
  async getDbDataByPropertyId(propertyId: string): Promise<IDbData[]> {
    return await DbData.find({ property_id: propertyId })
      .sort({ created_at: -1 })
      .exec();
  }

  /**
   * Get a specific DB data record by ID
   */
  async getDbDataById(id: string): Promise<IDbData | null> {
    return await DbData.findById(id).exec();
  }

  /**
   * Update Gearbox Queue IDs for a specific record
   */
  async updateGearboxQueueIds(
    id: string,
    gearboxQueueIds: string[]
  ): Promise<IDbData | null> {
    return await DbData.findByIdAndUpdate(
      id,
      { $set: { gearbox_queue_ids: gearboxQueueIds } },
      { new: true }
    ).exec();
  }

  /**
   * Add Gearbox Queue IDs to an existing record
   */
  async addGearboxQueueIds(
    id: string,
    gearboxQueueIds: string[]
  ): Promise<IDbData | null> {
    return await DbData.findByIdAndUpdate(
      id,
      { $push: { gearbox_queue_ids: { $each: gearboxQueueIds } } },
      { new: true }
    ).exec();
  }

  /**
   * Delete a DB data record
   */
  async deleteDbData(id: string): Promise<boolean> {
    const result = await DbData.findByIdAndDelete(id).exec();
    return result !== null;
  }

  /**
   * Get all DB data records with pagination
   */
  async getDbDataWithPagination(
    page: number = 1,
    limit: number = 10
  ): Promise<{ data: IDbData[]; total: number; page: number; pages: number }> {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      DbData.find().sort({ created_at: -1 }).skip(skip).limit(limit).exec(),
      DbData.countDocuments(),
    ]);

    return {
      data,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get DB data records by date range
   */
  async getDbDataByDateRange(
    startDate: string,
    endDate: string
  ): Promise<IDbData[]> {
    return await DbData.find({
      "date_range.start_date": { $gte: startDate },
      "date_range.end_date": { $lte: endDate },
    })
      .sort({ created_at: -1 })
      .exec();
  }

  /**
   * Get statistics for a job
   */
  async getJobStatistics(jobId: string): Promise<{
    totalRecords: number;
    totalGearboxIds: number;
    dateRanges: Array<{ start_date: string; end_date: string }>;
  }> {
    const records = await this.getDbDataByJobId(jobId);

    const totalGearboxIds = records.reduce(
      (sum, record) => sum + record.gearbox_queue_ids.length,
      0
    );

    const dateRanges = records.map((record) => ({
      start_date: record.date_range.start_date,
      end_date: record.date_range.end_date,
    }));

    return {
      totalRecords: records.length,
      totalGearboxIds,
      dateRanges,
    };
  }
}

// Export singleton instance
export const dbDataService = new DbDataService();
