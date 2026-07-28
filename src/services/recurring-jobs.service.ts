import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { OTAProvider } from "../models/job.model.js";
import { jobService } from "./job.service.js";

function toOtaType(provider: OTAProvider | string): string {
  return String(provider).toLowerCase();
}

/**
 * Notify DBMS that a recurring historical run completed for the given date range.
 * Failures are logged only; they do not fail the job.
 */
export async function updateHistoricalRunDate(
  jobId: string,
  options?: { startDate?: string; endDate?: string }
): Promise<void> {
  const baseUrl = process.env.DBMS_BACKEND_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    await dualLogInfo(
      "DBMS_BACKEND_URL not configured, skipping update-historical-run-date",
      { jobId }
    );
    return;
  }

  const job = await jobService.getJobById(jobId);
  if (!job) {
    await dualLogInfo("update-historical-run-date: skip, job not found", {
      jobId,
    });
    return;
  }

  const property = await jobService.getPropertyForJob(jobId);
  const parentId = property?.parent_id?.trim();
  if (!parentId) {
    await dualLogInfo(
      "update-historical-run-date: skip, property.parent_id missing",
      { jobId }
    );
    return;
  }

  const startDate = (options?.startDate ?? job.start_date)?.trim();
  const endDate = (options?.endDate ?? job.end_date)?.trim();
  if (!startDate || !endDate) {
    await dualLogInfo(
      "update-historical-run-date: skip, start_date or end_date missing",
      { jobId, startDate, endDate }
    );
    return;
  }

  const payload = {
    parent_id: parentId,
    ota_type: toOtaType(job.ota_provider),
    start_date: startDate,
    end_date: endDate,
  };

  try {
    const response = await fetch(
      `${baseUrl}/api/external/recurring-jobs/update-historical-run-date`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (response.ok) {
      await dualLogInfo("update-historical-run-date: success", {
        jobId,
        parentId,
        ota_type: payload.ota_type,
        start_date: startDate,
        end_date: endDate,
      });
      return;
    }

    const responseText = await response.text().catch(() => "");
    await dualLogError(
      `update-historical-run-date: request failed (${response.status})`,
      new Error(responseText || response.statusText),
      { jobId, parentId, status: response.status }
    );
  } catch (error) {
    await dualLogError(
      `update-historical-run-date: request error for ${jobId}`,
      error,
      { jobId, parentId }
    );
  }
}
