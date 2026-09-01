/**
 * Creates retrievals for bookings the Agoda report says the property can charge
 * itself.
 *
 * When a captured Partner Support reply leaves nothing to reopen, whatever came
 * back as COLLECT is handed to the retrieval backend as work: one parent per
 * API call, one retrieval per property underneath it. Both collections are
 * owned by that project and shared through the same MongoDB, so the field
 * names and the `ObjectId` types have to match what its Prisma client expects.
 */

import { Types } from "mongoose";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import {
  IJob,
  JobStatus,
  OTAProvider,
  PostingType,
} from "../models/job.model.js";
import { ParentRetrieval } from "../models/parent-retrieval.model.js";
import { IRetrieval, Retrieval } from "../models/retrieval.model.js";

/** Defaults the retrieval importer hard-codes; mirrored so rows look native. */
const EXECUTION_TYPE = "retrieval";
const BACKOFF_LENGTH_LOADING = 5000;
const BACKOFF_LENGTH_SELECTOR = 3000;

export interface CollectRetrievalInput {
  job: IJob;
  agodaId: string;
  /** Booking IDs the reopen rules marked COLLECT. */
  reservations: string[];
}

export interface CreatedRetrieval {
  jobId: string;
  agodaId: string;
  retrievalId: string;
  reservationCount: number;
}

export interface CollectRetrievalResult {
  parentRetrievalId: string | null;
  parentRetrievalName: string | null;
  created: CreatedRetrieval[];
  failed: Array<{ jobId: string; error: string }>;
}

function defaultParentName(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `Agoda Collect ${stamp} UTC`;
}

export class RetrievalService {
  /**
   * Writes one parent retrieval and a retrieval per property beneath it.
   *
   * A property whose insert fails is reported and skipped rather than taking
   * the batch down with it, matching how the bulk endpoints behave elsewhere.
   */
  async createCollectRetrievals(
    inputs: CollectRetrievalInput[],
    options: { parentName?: string } = {},
  ): Promise<CollectRetrievalResult> {
    const result: CollectRetrievalResult = {
      parentRetrievalId: null,
      parentRetrievalName: null,
      created: [],
      failed: [],
    };

    const eligible = inputs.filter((input) => input.reservations.length > 0);
    if (eligible.length === 0) return result;

    const parentName = options.parentName ?? defaultParentName(new Date());

    const parent = await ParentRetrieval.create({
      name: parentName,
      OTA: OTAProvider.Agoda,
      is_archived: false,
    });

    result.parentRetrievalId = String(parent._id);
    result.parentRetrievalName = parentName;

    await dualLogInfo(`📦 Created parent retrieval "${parentName}"`, {
      parentRetrievalId: String(parent._id),
      propertyCount: eligible.length,
    });

    for (const input of eligible) {
      const jobId = String(input.job._id);

      try {
        const retrieval = await this.createRetrievalForJob(input, parent._id);

        result.created.push({
          jobId,
          agodaId: input.agodaId,
          retrievalId: String(retrieval._id),
          reservationCount: input.reservations.length,
        });

        await dualLogInfo(
          `🧾 Created retrieval for Agoda ID ${input.agodaId} with ${input.reservations.length} reservation(s)`,
          {
            jobId,
            retrievalId: String(retrieval._id),
            parentRetrievalId: String(parent._id),
          },
        );
      } catch (error: any) {
        await dualLogError(
          `Failed to create retrieval for job ${jobId}:`,
          error,
        );
        result.failed.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    return result;
  }

  private async createRetrievalForJob(
    input: CollectRetrievalInput,
    parentRetrievalId: Types.ObjectId,
  ): Promise<IRetrieval> {
    const { job, reservations } = input;

    return await Retrieval.create({
      name: job.property_name,
      job_status: JobStatus.Pending,

      portfolio_id: job.portfolio_id,
      sub_portfolio_id: job.sub_portfolio_id,
      property_id: job.property_id,
      user_id: job.user_id,
      parent_retrieval_id: parentRetrievalId,

      posting_type: job.posting_type ?? PostingType.OTA,
      portfolio_name: job.portfolio_name,
      sub_portfolio_name: job.sub_portfolio_name,
      property_name: job.property_name,
      OTA: OTAProvider.Agoda,

      // The retrieval run works these out for itself; the importer seeds zeros
      // here too rather than guessing from the report.
      remaining_direct_billed: 0,
      total_collectable: 0,
      total_amount_confirmed: 0,
      execution_type: EXECUTION_TYPE,

      retries_attempted: 0,
      max_retries: 3,
      priority: 0,
      job_backoff_length_loading: BACKOFF_LENGTH_LOADING,
      job_backoff_length_selector: BACKOFF_LENGTH_SELECTOR,

      reservations,
      case_open: false,
      is_archived: false,
    });
  }
}

export const retrievalService = new RetrievalService();
