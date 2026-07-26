import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { JobStatus, resolveJobOtaProvider } from "../models/job.model.js";
import { Property } from "../models/property.model.js";
import { jobService } from "./job.service.js";

export type DbmsOtaType = "booking" | "expedia" | "agoda";

export interface UpdateHistoricalRunDatePayload {
  parent_id: string;
  ota_type: DbmsOtaType;
  start_date: string;
  end_date: string;
}

export interface UpdatePropertyCredentialsPayload {
  bookingUsername: string;
  bookingPassword: string;
}

/** Format job dates as `YYYY-MM-DD` for the DBMS recurring-jobs API. */
export function toDbmsApiDateString(
  value: Date | string | undefined | null
): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const mo = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  const s = String(value).trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }

  return null;
}

export function toDbmsOtaType(provider: unknown): DbmsOtaType | null {
  const normalized = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "booking" ||
    normalized === "expedia" ||
    normalized === "agoda"
  ) {
    return normalized;
  }
  return null;
}

class DbmsRecurringJobsService {
  private getBaseUrl(): string | null {
    const baseUrl = process.env.DBMS_BACKEND_URL?.trim();
    return baseUrl || null;
  }

  async updateHistoricalRunDate(
    payload: UpdateHistoricalRunDatePayload
  ): Promise<boolean> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      await dualLogInfo(
        "DBMS: update-historical-run-date skipped — DBMS_BACKEND_URL is not configured"
      );
      return false;
    }

    const url = `${baseUrl.replace(/\/$/, "")}/external/recurring-jobs/update-historical-run-date`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseText = await response
          .text()
          .catch(() => "Could not read response");
        await dualLogError("DBMS: update-historical-run-date request failed", {
          status: response.status,
          statusText: response.statusText,
          url,
          payload,
          responseBody: responseText.substring(0, 500),
        });
        return false;
      }

      await dualLogInfo("DBMS: update-historical-run-date succeeded", {
        parent_id: payload.parent_id,
        ota_type: payload.ota_type,
        start_date: payload.start_date,
        end_date: payload.end_date,
      });
      return true;
    } catch (error) {
      await dualLogError("DBMS: update-historical-run-date request error", error, {
        url,
        payload,
      });
      return false;
    }
  }

  async updatePropertyBookingCredentials(
    parentId: string,
    payload: UpdatePropertyCredentialsPayload
  ): Promise<boolean> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      await dualLogInfo(
        "DBMS: update property credentials skipped — DBMS_BACKEND_URL is not configured"
      );
      return false;
    }

    const trimmedParentId = parentId.trim();
    const bookingUsername = payload.bookingUsername?.trim();
    const bookingPassword = payload.bookingPassword;
    if (!trimmedParentId || !bookingUsername || !bookingPassword) {
      await dualLogError(
        "DBMS: update property credentials skipped — missing parent_id, username, or password",
        { parentId: trimmedParentId, hasUsername: !!bookingUsername, hasPassword: !!bookingPassword }
      );
      return false;
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/external/portfolio/property/${encodeURIComponent(trimmedParentId)}/credentials/booking`;

    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          bookingUsername,
          bookingPassword,
        }),
      });

      if (!response.ok) {
        const responseText = await response
          .text()
          .catch(() => "Could not read response");
        await dualLogError("DBMS: update property credentials request failed", {
          status: response.status,
          statusText: response.statusText,
          url,
          parent_id: trimmedParentId,
          bookingUsername,
          responseBody: responseText.substring(0, 500),
        });
        return false;
      }

      await dualLogInfo("DBMS: update property credentials succeeded", {
        parent_id: trimmedParentId,
        bookingUsername,
      });
      return true;
    } catch (error) {
      await dualLogError("DBMS: update property credentials request error", error, {
        url,
        parent_id: trimmedParentId,
        bookingUsername,
      });
      return false;
    }
  }

  /**
   * Push updated Booking credentials to DBMS for each affected property that has parent_id.
   */
  async syncBookingCredentialsForProperties(params: {
    bookingUsername: string;
    bookingPassword: string;
    propertyIds: string[];
  }): Promise<void> {
    if (!this.getBaseUrl()) {
      await dualLogInfo(
        "DBMS: update property credentials skipped — DBMS_BACKEND_URL is not configured"
      );
      return;
    }

    const { bookingUsername, bookingPassword, propertyIds } = params;
    if (!bookingUsername?.trim() || !bookingPassword || propertyIds.length === 0) {
      await dualLogInfo(
        "DBMS: update property credentials skipped — missing username, password, or property ids",
        { propertyCount: propertyIds.length }
      );
      return;
    }

    try {
      const properties = await Property.find({
        _id: { $in: propertyIds },
      })
        .select("_id parent_id property_name")
        .lean();

      const parentIds = new Map<string, string>();
      for (const property of properties) {
        const parentId = property.parent_id?.trim();
        if (!parentId) {
          await dualLogInfo(
            "DBMS: update property credentials skipped — property.parent_id is missing",
            { propertyId: property._id.toString(), propertyName: property.property_name }
          );
          continue;
        }
        parentIds.set(parentId, property._id.toString());
      }

      for (const parentId of parentIds.keys()) {
        await this.updatePropertyBookingCredentials(parentId, {
          bookingUsername,
          bookingPassword,
        });
      }
    } catch (error) {
      await dualLogError("DBMS: update property credentials sync failed", error, {
        propertyIds,
        bookingUsername,
      });
    }
  }

  /**
   * Notify DBMS that a booking job finished its historical date range.
   * Non-blocking for the worker: logs and returns on missing data or API errors.
   */
  async notifyHistoricalRunDateForJob(jobId: string): Promise<void> {
    if (!this.getBaseUrl()) {
      await dualLogInfo(
        `DBMS: update-historical-run-date skipped — DBMS_BACKEND_URL is not configured`,
        { jobId }
      );
      return;
    }

    try {
      const job = await jobService.getJobById(jobId);
      if (!job) {
        await dualLogInfo(
          `DBMS: update-historical-run-date skipped — job not found`,
          { jobId }
        );
        return;
      }

      const uploadable = job.job_status === JobStatus.Completed;
      if (!uploadable) {
        await dualLogInfo(
          `DBMS: update-historical-run-date skipped — job_status is "${String(job.job_status)}", expected Completed`,
          { jobId }
        );
        return;
      }

      const otaType = toDbmsOtaType(resolveJobOtaProvider(job));
      if (!otaType) {
        await dualLogInfo(
          `DBMS: update-historical-run-date skipped — unsupported OTA "${String(resolveJobOtaProvider(job))}"`,
          { jobId }
        );
        return;
      }

      const property = await jobService.getPropertyForJob(jobId);
      const parentId = property?.parent_id?.trim();
      if (!parentId) {
        await dualLogInfo(
          `DBMS: update-historical-run-date skipped — property.parent_id is missing`,
          { jobId, propertyId: property?._id?.toString() }
        );
        return;
      }

      const startDate = toDbmsApiDateString(job.end_date);
      const endDate = toDbmsApiDateString(job.end_date);
      if (!startDate || !endDate) {
        await dualLogInfo(
          `DBMS: update-historical-run-date skipped — missing start_date or end_date`,
          {
            jobId,
            end_date: job.end_date,
            startDate,
            endDate,
          }
        );
        return;
      }

      await this.updateHistoricalRunDate({
        parent_id: parentId,
        ota_type: otaType,
        start_date: startDate,
        end_date: endDate,
      });
    } catch (error) {
      await dualLogError(
        `DBMS: update-historical-run-date failed for job ${jobId}`,
        error,
        { jobId }
      );
    }
  }
}

export const dbmsRecurringJobsService = new DbmsRecurringJobsService();
