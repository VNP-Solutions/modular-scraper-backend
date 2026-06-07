import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { isMainThread } from "worker_threads";
import {
  isAuditSmsConfigured,
  sendAuditStartedSms,
} from "../common/audit-ready-sms.js";
import { emailNotifier } from "../common/email-notifier.js";
import createError from "../common/error.js";
import { setCurrentWorkerId } from "../common/log-helper.js";
import { getDefaultOtpPhoneForGroupedRequest } from "../common/job-phone-store.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { JobType, WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { JobStatus } from "../models/job.model.js";
import { ScheduledJob } from "../models/scheduled-job.model.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { propertyCredentialsService as propertyPasswordUpdateService } from "../services/property-credentials.service.js";
import { jobService } from "../services/job.service.js";
import cookieStorageRoutes from "../routes/shared/cookie-storage.routes.js";

// Ensure main thread ID is set for API routes and system tasks
if (isMainThread) {
  setCurrentWorkerId("Thread-1");
}

const app = express();

app.set("trust proxy", true);

app.use("/webhook", bodyParser.raw({ type: "*/*" }));
app.use(bodyParser.json());
app.use(cors());

// Swagger UI
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    explorer: true,
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Module Scrapper API Documentation",
  })
);

// Logger middleware
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(
      req.method,
      req.hostname,
      req.path,
      res.statusCode,
      res.statusMessage,
      new Date(Date.now())
    );
  });
  next();
});

app.get("/", (req, res, next) => {
  try {
    res
      .status(200)
      .json({ messge: "Connection established on booking-thread branch" });
  } catch (err: any) {
    next(createError(err.status, err.message));
  }
});

app.get("/auth", getAccess as any);

app.get("/oauth2callback", getOauth2Callback as any);

// Test endpoint for CAPTCHA email notification
app.get("/test-captcha-email", async (req, res) => {
  try {
    const testData = {
      jobId: "test-captcha-job-123",
      jobName: "Booking.com CAPTCHA Test",
      propertyName: "Test Hotel Property",
      expediaId: "TEST123",
      errorMessage:
        "CAPTCHA detected during Booking.com login - Manual intervention required",
      errorDetails: {
        sessionUrl: "https://chrome.browserless.io/session/test-session-id",
        currentUrl: "https://admin.booking.com/signin",
        timestamp: new Date().toISOString(),
        instructions:
          "Please visit the session URL to solve the CAPTCHA. The system will automatically detect when solved.",
      },
      timestamp: new Date(),
      stage: "Login - CAPTCHA Challenge",
    };

    const recipients = process.env.CAPTCHA_RECIPIENTS
      ? process.env.CAPTCHA_RECIPIENTS.split(",").map((email) => email.trim())
      : ["admin@vnpsolutions.com", "developer@vnpsolutions.com"];

    await emailNotifier.sendErrorEmail(recipients, testData);

    res.json({
      success: true,
      message: "CAPTCHA test email sent successfully!",
      recipients: recipients,
      mailhogUrl: "http://localhost:8025",
    });
  } catch (error: any) {
    console.error("Email test error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Test endpoint for password update and email notification
app.post("/test-password-update", (async (req: any, res: any) => {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: "jobId is required in request body",
      });
    }

    // Test the password update logic (read-only - just fetches data without actually updating)
    const updateResult = await propertyPasswordUpdateService.updateBookingPasswordByJobId(
      jobId,
      "TestPassword123!" // This will be encrypted and stored
    );

    if (!updateResult.success) {
      return res.status(400).json({
        success: false,
        message: "Failed to update password",
        result: updateResult,
      });
    }

    res.json({
      success: true,
      message: "Password update test completed!",
      data: {
        totalPropertiesUpdated: updateResult.totalUpdated,
        username: updateResult.username,
        affectedProperties: updateResult.affectedProperties,
        propertyNames: updateResult.affectedProperties.map((p: any) => p.propertyName),
      },
      note: "Check the logs for detailed information about property name resolution",
    });
  } catch (error: any) {
    console.error("Password update test error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
}) as any);

// API to get scraping status
app.get(
  "/api/scraping/status",
  (req: express.Request, res: express.Response) => {
    try {
      const state = scrapingStateManager.getState();
      res.status(200).json({
        status: 200,
        message: "Scraping status retrieved successfully",
        data: state,
      });
    } catch (err: any) {
      console.error("Error getting scraping status:", err);
      res.status(500).json({
        status: 500,
        message: "Error retrieving scraping status",
        error: err.message,
      });
    }
  }
);

// API to pause scraping
app.post(
  "/api/scraping/pause",
  (req: express.Request, res: express.Response) => {
    try {
      const success = scrapingStateManager.pauseScraping();

      if (success) {
        res.status(200).json({
          status: 200,
          message: "Scraping paused successfully",
          data: scrapingStateManager.getState(),
        });
      } else {
        res.status(400).json({
          status: 400,
          message: "Cannot pause scraping - no active scraping job running",
        });
      }
    } catch (err: any) {
      console.error("Error pausing scraping:", err);
      res.status(500).json({
        status: 500,
        message: "Error pausing scraping",
        error: err.message,
      });
    }
  }
);

app.post("/api/booking/property-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.body;

    // Validate required parameters
    if (!jobId) {
      return res.status(400).json({
        status: 400,
        message: "jobId required in request body",
      });
    }

    // 1. Validate job exists and can be run
    const validation = await jobService.validateJob(jobId);

    if (!validation.exists) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    if (!validation.canRun) {
      return res.status(409).json({
        status: 409,
        message: `Job ${jobId} is not in a runnable state. Current status: ${validation.job?.job_status}`,
        currentState: validation.job,
      });
    }

    // 2. Get booking_id from job's property
    console.log(
      `Getting booking_id and job details for booking job ${jobId}...`
    );
    const jobData = await jobService.getBookingIdFromJob(jobId);
    const bookingCredentials =
      await propertyCredentialsService.getBookingCredentialsFromJob(jobId);

    if (!jobData || !jobData.bookingId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
      });
    }

    if (
      !bookingCredentials?.bookingUsername ||
      !bookingCredentials?.bookingPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid bookingUsername or bookingPassword for job ${jobId}. Property may not have booking credentials assigned.`,
      });
    }

    if (!jobData.propertyId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
      });
    }

    const { bookingId, portfolioId, propertyId } = jobData;
    const { bookingUsername, bookingPassword } = bookingCredentials;

    console.log(`Using booking_id: ${bookingId} for booking scraping`);

    // 3. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: JobType.BookingRun,
      jobId,
      portfolioId,
      propertyId,
      bookingId,
      user_email: bookingUsername,
      user_password: bookingPassword,
    };

    // 4. Execute job in worker thread
    try {
      console.log(`Submitting booking job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Booking job execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for booking job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Worker execution failed for booking job",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/booking/run-job:", err);

    // Ensure job is marked as failed
    try {
      if (req.body.jobId) {
        await progressManager.handleJobError(req.body.jobId, err);
      }
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }

    res.status(500).json({
      status: 500,
      message: "Error processing booking job",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/booking/bulk-property-run-job:
 *   post:
 *     tags:
 *       - Booking Jobs
 *     summary: Bulk start booking scraping jobs
 *     description: |
 *       Starts multiple booking scraping jobs.
 *       Jobs are submitted asynchronously and the worker pool handles OTP checking and queueing automatically.
 *       Invalid jobs are reported in the response but do not prevent valid jobs from being processed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - job_ids
 *             properties:
 *               job_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["6892f4bf9df8bc296bdcdff0", "6892f4bf9df8bc296bdcdff1"]
 *                 description: Array of job IDs to process
 *               scheduler_id:
 *                 type: string
 *                 description: Optional scheduler ID to update with invalid job IDs
 *                 example: "6892f4bf9df8bc296bdcdff2"
 *     responses:
 *       200:
 *         description: Jobs submitted successfully, with details on valid and invalid jobs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                 message:
 *                   type: string
 *                 results:
 *                   type: object
 *                   properties:
 *                     submitted:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           status: { type: string, enum: ["submitted", "failed"] }
 *                     invalid:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           reason: { type: string }
 *                           currentStatus: { type: string }
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           error: { type: string }
 *       400:
 *         description: Missing required parameters in request body
 *       500:
 *         description: Error processing bulk booking run jobs
 */
app.post("/api/booking/bulk-property-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids, scheduler_id } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message:
          "job_ids array is required and must contain at least one job ID",
      });
    }

    // Check if worker threads are available
    if (
      !otpAwareWorkerPool.hasAvailableWorkers() &&
      otpAwareWorkerPool.isQueueFull()
    ) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: otpAwareWorkerPool.getStatus(),
      });
    }

    // Validate all jobs exist and can be run
    const jobValidations = await Promise.all(
      job_ids.map(async (jobId: string) => {
        const validation = await jobService.validateJob(jobId);
        return { jobId, validation };
      })
    );

    // Separate valid and invalid jobs
    const validJobs = jobValidations.filter(
      (j) => j.validation.exists && j.validation.canRun
    );
    const invalidJobs = jobValidations.filter(
      (j) => !j.validation.exists || !j.validation.canRun
    );

    // Get job data for valid jobs only
    const jobsData = await Promise.all(
      validJobs.map(async ({ jobId }) => {
        try {
          const jobData = await jobService.getBookingIdFromJob(jobId);
          const bookingCredentials =
            await propertyCredentialsService.getBookingCredentialsFromJob(
              jobId
            );

          if (!jobData || !jobData.bookingId) {
            return {
              jobId,
              error: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
            };
          }

          if (
            !bookingCredentials?.bookingUsername ||
            !bookingCredentials?.bookingPassword
          ) {
            return {
              jobId,
              error: `Cannot retrieve valid bookingUsername or bookingPassword for job ${jobId}. Property may not have booking credentials assigned.`,
            };
          }

          if (!jobData.propertyId) {
            return {
              jobId,
              error: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
            };
          }

          return { jobId, jobData, bookingCredentials };
        } catch (error) {
          return {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    // Separate jobs with valid data from those with errors
    const validJobsData = jobsData.filter(
      (
        j
      ): j is {
        jobId: string;
        jobData: any;
        bookingCredentials: any;
      } => !("error" in j)
    );
    const jobsWithErrors = jobsData.filter((j) => "error" in j);

    // Submit all jobs asynchronously without waiting - fire and forget
    const results: {
      submitted: Array<{ jobId: string; status: string; data?: any }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = {
      submitted: [],
      invalid: [],
      errors: [],
    };

    // Add invalid jobs to results
    invalidJobs.forEach(({ jobId, validation }) => {
      results.invalid.push({
        jobId,
        reason: !validation.exists
          ? "Job not found"
          : "Job is not in a runnable state",
        currentStatus: validation.job?.job_status || undefined,
      });
    });

    // Add jobs with errors to results
    jobsWithErrors.forEach((job) => {
      if ("error" in job && job.error) {
        results.errors.push({
          jobId: job.jobId,
          error: job.error,
        });
      }
    });

    // Submit valid jobs without awaiting - they run in the background
    validJobsData.forEach((job) => {
      const { bookingId, portfolioId, propertyId } = job.jobData;
      const { bookingUsername, bookingPassword } = job.bookingCredentials;

      const workerJobData: WorkerJobData = {
        jobType: JobType.BookingRun,
        jobId: job.jobId,
        portfolioId,
        propertyId,
        bookingId,
        user_email: bookingUsername,
        user_password: bookingPassword,
      };

      // executeJob will automatically:
      // - Run immediately if OTP and worker available
      // - Queue and set InQueue status if OTP occupied or no worker available
      // Fire and forget - don't wait for completion
      otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
        console.error(`Error submitting booking job ${job.jobId}:`, error);
        // Update job status to Failed if submission fails
        try {
          await jobService.updateJobStatus(job.jobId, JobStatus.Failed);
        } catch (statusError) {
          console.error(
            `Error updating job ${job.jobId} status to Failed:`,
            statusError
          );
        }
      });

      results.submitted.push({
        jobId: job.jobId,
        status: "submitted",
      });
    });

    // Update scheduled job comment with invalid job IDs if scheduler_id is provided
    if (scheduler_id) {
      try {
        const invalidJobIds = [
          ...results.invalid.map((j) => j.jobId),
          ...results.errors.map((j) => j.jobId),
        ];

        if (invalidJobIds.length > 0) {
          const invalidJobIdsString = invalidJobIds.join(", ");
          const scheduledJob = await ScheduledJob.findById(scheduler_id);

          if (scheduledJob) {
            const existingComment = scheduledJob.comment || "";
            const newComment = existingComment
              ? `${existingComment}\nInvalid job IDs: ${invalidJobIdsString}`
              : `Invalid job IDs: ${invalidJobIdsString}`;

            await ScheduledJob.findByIdAndUpdate(scheduler_id, {
              comment: newComment,
            });
            console.log(
              `Updated scheduled job ${scheduler_id} comment with invalid job IDs`
            );
          } else {
            console.warn(
              `Scheduled job ${scheduler_id} not found, skipping comment update`
            );
          }
        }
      } catch (schedulerError) {
        console.error(
          `Error updating scheduled job ${scheduler_id} comment:`,
          schedulerError
        );
        // Don't fail the request if scheduler update fails
      }
    }

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${results.submitted.length} submitted, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results,
    });
  } catch (err: any) {
    console.error("Error in /api/booking/bulk-property-run-job:", err);

    res.status(500).json({
      status: 500,
      message: "Error processing bulk booking run jobs",
      error: err.message,
    });
  }
}) as any);

/** One credential group in POST /api/booking/bulk-property-run-job-grouped */
interface BookingBulkCredentialGroup {
  job_ids: string[];
  phone_number?: string | null;
  slot?: number | null;
  booking_username: string;
  booking_password: string;
}

function resolveGroupedCredentialContact(g: BookingBulkCredentialGroup): {
  phone: string;
  port?: string;
} {
  const defPhone = getDefaultOtpPhoneForGroupedRequest();

  const raw = g.phone_number;
  const hasPhone =
    raw != null && typeof raw === "string" && raw.trim() !== "";
  const hasSlot = g.slot != null && typeof g.slot === "number";

  const phone = hasPhone ? raw.trim() : defPhone;
  if (hasSlot) {
    return { phone, port: String(g.slot) };
  }
  return { phone };
}

/**
 * @swagger
 * /api/booking/bulk-property-run-job-grouped:
 *   post:
 *     tags:
 *       - Booking Jobs
 *     summary: Bulk start booking scraping jobs (grouped endpoint)
 *     description: |
 *       Accepts credential_groups (job_ids plus booking_username/booking_password per group, optional phone_number and slot).
 *       Omitted or null phone_number uses OUR_CONTACT (else built-in fallback). Omitted or null slot means no port (single-phone / IFTTT-style OTP path).
 *       Resolved phone/port are passed as selectedContact on each job; worker pool does not overwrite them.
 *       Each credential group is submitted as one booking-run-group job (single browser session: one login, then each property in job_ids order on one worker thread). OTP worker-pool locking is per phone number: different numbers can run on different workers at once; same number is serialized. `slot` is only for OTP/email matching in the worker, not a separate lock lane.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - credential_groups
 *             properties:
 *               credential_groups:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required:
 *                     - job_ids
 *                     - booking_username
 *                     - booking_password
 *                   properties:
 *                     job_ids:
 *                       type: array
 *                       minItems: 1
 *                       items:
 *                         type: string
 *                     phone_number:
 *                       type: string
 *                       nullable: true
 *                     slot:
 *                       type: integer
 *                       nullable: true
 *                     booking_username:
 *                       type: string
 *                     booking_password:
 *                       type: string
 *               scheduler_id:
 *                 type: string
 *                 description: Optional scheduler ID to update with invalid job IDs
 *                 example: "6892f4bf9df8bc296bdcdff2"
 *     responses:
 *       200:
 *         description: Jobs submitted successfully, with details on valid and invalid jobs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                 message:
 *                   type: string
 *                 results:
 *                   type: object
 *                   properties:
 *                     submitted:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           status: { type: string, enum: ["submitted", "failed"] }
 *                     invalid:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           reason: { type: string }
 *                           currentStatus: { type: string }
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId: { type: string }
 *                           error: { type: string }
 *       400:
 *         description: Missing required parameters in request body
 *       500:
 *         description: Error processing bulk booking run jobs
 */
app.post("/api/booking/bulk-property-run-job-grouped", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { credential_groups, scheduler_id } = req.body;

    if (
      !credential_groups ||
      !Array.isArray(credential_groups) ||
      credential_groups.length === 0
    ) {
      return res.status(400).json({
        status: 400,
        message:
          "credential_groups is required and must be a non-empty array",
      });
    }

    for (let i = 0; i < credential_groups.length; i++) {
      const g = credential_groups[i];
      if (!g || typeof g !== "object") {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}] must be an object`,
        });
      }
      if (!Array.isArray(g.job_ids) || g.job_ids.length === 0) {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].job_ids must be a non-empty array`,
        });
      }
      const badJobId = g.job_ids.find(
        (id: unknown) => typeof id !== "string" || id.trim() === ""
      );
      if (badJobId !== undefined) {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].job_ids must contain only non-empty strings`,
        });
      }
      if (
        typeof g.booking_username !== "string" ||
        g.booking_username.trim() === ""
      ) {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].booking_username is required`,
        });
      }
      if (typeof g.booking_password !== "string") {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].booking_password must be a string`,
        });
      }
      if (
        g.phone_number !== null &&
        g.phone_number !== undefined &&
        typeof g.phone_number !== "string"
      ) {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].phone_number must be a string or null`,
        });
      }
      if (
        g.slot !== null &&
        g.slot !== undefined &&
        typeof g.slot !== "number"
      ) {
        return res.status(400).json({
          status: 400,
          message: `credential_groups[${i}].slot must be a number or null`,
        });
      }
    }

    const groups = credential_groups as BookingBulkCredentialGroup[];
    const phoneKeyForGroup = (g: BookingBulkCredentialGroup): string => {
      const c = resolveGroupedCredentialContact(g);
      return c.phone;
    };
    const phoneUsage = new Map<string, number>();
    for (const g of groups) {
      const k = phoneKeyForGroup(g);
      phoneUsage.set(k, (phoneUsage.get(k) ?? 0) + 1);
    }
    for (const [phoneKey, n] of phoneUsage) {
      if (n > 1) {
        console.warn(
          `[bulk-property-run-job-grouped] ${n} credential_groups share the same phone (${phoneKey}). OTP is locked per phone — extra groups for that number queue until the lane is free, even if other workers are idle.`
        );
      }
    }

    const jobIdToSelectedContact = new Map<
      string,
      { phone: string; port?: string }
    >();
    for (const g of groups) {
      const contact = resolveGroupedCredentialContact(g);
      for (const id of g.job_ids) {
        jobIdToSelectedContact.set(id, contact);
      }
    }

    const job_ids = groups.flatMap((g) => g.job_ids);

    // Check if worker threads are available
    if (
      !otpAwareWorkerPool.hasAvailableWorkers() &&
      otpAwareWorkerPool.isQueueFull()
    ) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: otpAwareWorkerPool.getStatus(),
      });
    }

    // Validate all jobs exist and can be run
    const jobValidations = await Promise.all(
      job_ids.map(async (jobId: string) => {
        const validation = await jobService.validateJob(jobId);
        return { jobId, validation };
      })
    );

    // Separate valid and invalid jobs
    const validJobs = jobValidations.filter(
      (j) => j.validation.exists && j.validation.canRun
    );
    const invalidJobs = jobValidations.filter(
      (j) => !j.validation.exists || !j.validation.canRun
    );

    // Get job data for valid jobs only (credentials come from credential_groups, not DB)
    const jobsData = await Promise.all(
      validJobs.map(async ({ jobId }) => {
        try {
          const jobData = await jobService.getBookingIdFromJob(jobId);
          const bookingCredentials =
            await propertyCredentialsService.getBookingCredentialsFromJob(
              jobId
            );

          if (!jobData || !jobData.bookingId) {
            return {
              jobId,
              error: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
            };
          }

          if (!jobData.propertyId) {
            return {
              jobId,
              error: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
            };
          }

          return { jobId, jobData, bookingCredentials };
        } catch (error) {
          return {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    // Separate jobs with valid data from those with errors
    const validJobsData = jobsData.filter(
      (
        j
      ): j is {
        jobId: string;
        jobData: any;
        bookingCredentials: any;
      } => !("error" in j)
    );
    const jobsWithErrors = jobsData.filter((j) => "error" in j);

    // Submit all jobs asynchronously without waiting - fire and forget
    const results: {
      submitted: Array<{ jobId: string; status: string; data?: any }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = {
      submitted: [],
      invalid: [],
      errors: [],
    };

    // Add invalid jobs to results
    invalidJobs.forEach(({ jobId, validation }) => {
      results.invalid.push({
        jobId,
        reason: !validation.exists
          ? "Job not found"
          : "Job is not in a runnable state",
        currentStatus: validation.job?.job_status || undefined,
      });
    });

    // Add jobs with errors to results
    jobsWithErrors.forEach((job) => {
      if ("error" in job && job.error) {
        results.errors.push({
          jobId: job.jobId,
          error: job.error,
        });
      }
    });

    // Same group runs on one worker (one executeJob); totalWorkers parallel feeders pull from a FIFO with a mutex.
    // No pinnedWorkerId: any idle worker can take the next group when the booking phone slot is free (see otp-aware-worker-pool).
    type ValidJobEntry = (typeof validJobsData)[number];
    const validJobById = new Map(
      validJobsData.map((j) => [j.jobId, j] as const)
    );
    const totalWorkers = Math.max(
      1,
      otpAwareWorkerPool.getStatus().totalWorkers
    );

    type GroupRun = {
      jobs: ValidJobEntry[];
      booking_username: string;
      booking_password: string;
    };
    const groupRuns: GroupRun[] = [];
    for (const g of groups) {
      const jobsInGroup = g.job_ids
        .map((id: string) => validJobById.get(id))
        .filter((j): j is ValidJobEntry => j != null);
      if (jobsInGroup.length > 0) {
        groupRuns.push({
          jobs: jobsInGroup,
          booking_username: g.booking_username.trim(),
          booking_password: g.booking_password,
        });
      }
    }

    for (const run of groupRuns) {
      for (const job of run.jobs) {
        results.submitted.push({
          jobId: job.jobId,
          status: "submitted",
        });
      }
    }

    // Best-effort "Audit started" SMS for each submitted job (does not block worker submit).
    if (isAuditSmsConfigured()) {
      for (const { jobId } of validJobsData) {
        try {
          const jobDoc = await jobService.getJobById(jobId);
          const reportPhone = jobDoc?.phone_number_for_report?.trim();
          if (reportPhone) {
            await sendAuditStartedSms(reportPhone, jobId);
            console.log(`Audit SMS: audit-started message sent for ${jobId}`);
          } else {
            console.log(
              `Audit SMS: skip (no phone_number_for_report on job) for ${jobId}`
            );
          }
        } catch (smsError) {
          console.error(
            `Audit SMS: audit-started send failed for ${jobId}`,
            smsError
          );
        }
      }
    } else {
      console.log(
        "Audit SMS: skip (neither Ejoin nor Twilio + DEMO_WEBSITE_URL configured)"
      );
    }

    let nextGroupIndex = 0;
    let groupTakeChain: Promise<void> = Promise.resolve();
    const takeNextGroup = async (): Promise<GroupRun | null> => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const prev = groupTakeChain;
      groupTakeChain = prev.then(() => gate);
      await prev;
      try {
        if (nextGroupIndex >= groupRuns.length) {
          return null;
        }
        const run = groupRuns[nextGroupIndex];
        nextGroupIndex += 1;
        return run;
      } finally {
        release();
      }
    };

    const runPipeline = async () => {
      for (;;) {
        const run = await takeNextGroup();
        if (!run) {
          break;
        }
        const jobsInGroup = run.jobs;
        const leaseJobId = jobsInGroup[0].jobId;
        const selectedContact = jobIdToSelectedContact.get(leaseJobId);
        const workerJobData: WorkerJobData = {
          jobType: JobType.BookingRunGroup,
          jobId: leaseJobId,
          user_email: run.booking_username,
          user_password: run.booking_password,
          bookingGroup: jobsInGroup.map((j) => ({
            jobId: j.jobId,
            portfolioId: j.jobData.portfolioId,
            propertyId: j.jobData.propertyId,
            bookingId: j.jobData.bookingId,
          })),
          ...(selectedContact ? { selectedContact } : {}),
        };

        try {
          await otpAwareWorkerPool.executeJob(workerJobData);
        } catch (error) {
          console.error(
            `Error submitting booking group (lease ${leaseJobId}):`,
            error
          );
          for (const j of jobsInGroup) {
            try {
              await jobService.updateJobStatus(j.jobId, JobStatus.Failed);
            } catch (statusError) {
              console.error(
                `Error updating job ${j.jobId} status to Failed:`,
                statusError
              );
            }
          }
        }
      }
    };

    void (async () => {
      await Promise.all(
        Array.from({ length: totalWorkers }, () => runPipeline())
      );
    })();

    // Update scheduled job comment with invalid job IDs if scheduler_id is provided
    if (scheduler_id) {
      try {
        const invalidJobIds = [
          ...results.invalid.map((j) => j.jobId),
          ...results.errors.map((j) => j.jobId),
        ];

        if (invalidJobIds.length > 0) {
          const invalidJobIdsString = invalidJobIds.join(", ");
          const scheduledJob = await ScheduledJob.findById(scheduler_id);

          if (scheduledJob) {
            const existingComment = scheduledJob.comment || "";
            const newComment = existingComment
              ? `${existingComment}\nInvalid job IDs: ${invalidJobIdsString}`
              : `Invalid job IDs: ${invalidJobIdsString}`;

            await ScheduledJob.findByIdAndUpdate(scheduler_id, {
              comment: newComment,
            });
            console.log(
              `Updated scheduled job ${scheduler_id} comment with invalid job IDs`
            );
          } else {
            console.warn(
              `Scheduled job ${scheduler_id} not found, skipping comment update`
            );
          }
        }
      } catch (schedulerError) {
        console.error(
          `Error updating scheduled job ${scheduler_id} comment:`,
          schedulerError
        );
        // Don't fail the request if scheduler update fails
      }
    }

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${results.submitted.length} submitted, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results,
    });
  } catch (err: any) {
    console.error("Error in /api/booking/bulk-property-run-job-grouped:", err);

    res.status(500).json({
      status: 500,
      message: "Error processing bulk booking run jobs",
      error: err.message,
    });
  }
}) as any);

app.post("/api/booking/stop-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({
        status: 400,
        message: "Job ID is required",
      });
    }

    // 1. Check if job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    // 2. Stop the scraping state flag so the scraper exits its loop gracefully
    const wasRunning = scrapingStateManager.isRunning();
    if (wasRunning) {
      scrapingStateManager.stopScraping();
      console.log(`Stopping scraping state for booking job ${jobId}`);
    }

    // 3. Force-stop the worker thread and release the phone_number_slots row
    //    held by this job. releaseJobOtpResources inside stopJob calls
    //    phoneNumberSlotService.releaseByJobId(jobId) for Booking job types.
    //    workerStopped=false means the job was not found on any active thread
    //    (already finished or still queued — queued jobs are also removed here).
    const workerStopped = await otpAwareWorkerPool.stopJob(jobId);

    // 4. Delete the job and all its scraped items from the database.
    const { deleted, itemsDeleted } = await jobService.deleteJob(jobId);

    if (!deleted) {
      return res.status(500).json({
        status: 500,
        message: `Worker stopped but failed to delete job ${jobId} from database`,
        jobId,
        workerStopped,
      });
    }

    console.log(
      `Booking job ${jobId} stopped, phone slot released, and deleted (wasRunning=${wasRunning}, workerStopped=${workerStopped}, itemsDeleted=${itemsDeleted})`
    );

    res.status(200).json({
      status: 200,
      message: "Booking scraping job stopped and deleted successfully",
      jobId,
      wasRunning,
      workerStopped,
      itemsDeleted,
    });
  } catch (err: any) {
    console.error("Error in /api/booking/stop-job:", err);
    res.status(500).json({
      status: 500,
      message: "Error stopping booking job",
      error: err.message,
    });
  }
}) as any);

app.post("/api/booking/rerun-failed-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId, ota_provider } = req.body;

    // Validate required parameters
    if (!jobId || !ota_provider) {
      return res.status(400).json({
        status: 400,
        message: "jobId, ota_provider are required in request body",
      });
    }

    // Check if worker threads are available
    if (
      !otpAwareWorkerPool.hasAvailableWorkers() &&
      otpAwareWorkerPool.isQueueFull()
    ) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: otpAwareWorkerPool.getStatus(),
      });
    }

    // 1. Check if job can be retried
    await jobService.setJobIdForRetryCheck(jobId);

    if (!jobService.canRetry) {
      return res.status(400).json({
        status: 400,
        message: jobService.retryReason,
        jobId,
        currentStatus: jobService.currentJob?.job_status,
        retryAttempts: jobService.currentJob?.retries_attempted,
        maxRetries: jobService.currentJob?.max_retries,
      });
    }

    const job = jobService.currentJob!;
    const originalStatus = job.job_status;

    // 2. Increment retry attempts
    const updatedJob = await jobService.incrementRetryAttempts(jobId);
    if (!updatedJob) {
      return res.status(500).json({
        status: 500,
        message: "Failed to update retry attempts",
      });
    }

    // 3. Get booking_id and credentials from job's property
    console.log(`Getting booking_id for failed job rerun ${jobId}...`);
    const jobData = await jobService.getBookingIdFromJob(jobId);
    const bookingCredentials =
      await propertyCredentialsService.getBookingCredentialsFromJob(jobId);

    if (!jobData || !jobData.bookingId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
      });
    }

    if (
      !bookingCredentials?.bookingUsername ||
      !bookingCredentials?.bookingPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid booking credentials for job ${jobId}. Property may not have booking username or password assigned.`,
      });
    }

    if (!jobData.propertyId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
      });
    }

    const { bookingId, portfolioId, propertyId } = jobData;
    const { bookingUsername, bookingPassword } = bookingCredentials;

    console.log(
      `Rerunning failed booking job ${jobId} (attempt ${updatedJob.retries_attempted}/${updatedJob.max_retries}) with booking_id: ${bookingId}`
    );

    // 4. Prepare worker job data for rerun
    const workerJobData: WorkerJobData = {
      jobType: JobType.BookingRerunFailed,
      jobId,
      portfolioId,
      propertyId,
      bookingId,
      user_email: bookingUsername,
      user_password: bookingPassword,
      originalStatus,
    };

    // 5. Execute job in worker thread
    try {
      console.log(`Submitting booking rerun job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        // Get final progress after rerun
        const progress = await jobService.getJobProgress(jobId);

        // Clean up retry check state
        jobService.clearRetryCheck();

        return res.status(200).json({
          ...result.data,
          originalStatus,
          retryAttempt: updatedJob.retries_attempted,
          progress,
        });
      } else {
        // Clean up retry check state
        jobService.clearRetryCheck();

        return res.status(500).json({
          status: 500,
          message: "Booking job rerun execution failed",
          error: result.error,
          jobId: result.jobId,
          retryAttempt: updatedJob.retries_attempted,
        });
      }
    } catch (workerError) {
      console.error(
        `Worker error for booking rerun job ${jobId}:`,
        workerError
      );

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      // Clean up retry check state
      jobService.clearRetryCheck();
      return res.status(500).json({
        status: 500,
        message: "Worker execution failed for booking job rerun",
        error: workerError instanceof Error ? workerError.message : workerError,
        jobId,
        retryAttempt: updatedJob.retries_attempted,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/booking/rerun-failed-job:", err);

    // Ensure job is marked as failed
    try {
      if (req.body.jobId) {
        await progressManager.handleJobError(req.body.jobId, err);
      }
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }

    res.status(500).json({
      status: 500,
      message: "Error processing booking job rerun",
      error: err.message,
    });
  } finally {
    // Clean up retry check state
    jobService.clearRetryCheck();
  }
}) as any);

app.get("/api/jobs/:jobId/progress", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    const progress = await jobService.getJobProgress(jobId);
    const items = await jobService.getJobItems(jobId, 10); // Last 10 items

    res.status(200).json({
      status: 200,
      message: "Job progress retrieved successfully",
      job: {
        id: job._id,
        status: job.job_status,
        property_name: job.property_name,
        portfolio_name: job.portfolio_name,
        job_items_file_link: job.job_items_file_link,
      },
      progress: progress,
      recentItems: items,
    });
  } catch (err: any) {
    console.error("Error getting job progress:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job progress",
      error: err.message,
    });
  }
}) as any);

app.get("/api/jobs/:jobId/items", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
      search,
      reasonForCharge,
    } = req.query;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    const result = await jobService.getJobItemsAdvanced({
      jobId,
      page: parseInt(page as string, 10),
      limit: parseInt(limit as string, 10),
      sortBy: sortBy as string,
      sortOrder: (sortOrder as string) === "asc" ? "asc" : "desc",
      search: search as string,
      reasonForCharge: reasonForCharge as string,
    });

    res.status(200).json({
      status: 200,
      message: "Job items retrieved successfully",
      items: result.items,
      metadata: {
        totalDocuments: result.totalDocuments,
        currentPage: result.currentPage,
        totalPage: result.totalPage,
        limit: result.limit,
      },
    });
  } catch (err: any) {
    console.error("Error getting job items:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job items",
      error: err.message,
    });
  }
}) as any);

app.get("/api/jobs/:jobId/log", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    if (!job.log_link) {
      return res.status(404).json({
        status: 404,
        message: "No log file available for this job",
      });
    }

    res.status(200).json({
      status: 200,
      message: "Job log link retrieved successfully",
      job: {
        id: job._id,
        status: job.job_status,
        property_name: job.property_name,
        log_link: job.log_link,
        job_items_file_link: job.job_items_file_link,
      },
    });
  } catch (err: any) {
    console.error("Error getting job log link:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job log link",
      error: err.message,
    });
  }
}) as any);

app.get("/api/jobs/:jobId/job-items-file", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({ status: 404, message: "Job not found" });
    }
    if (!job.job_items_file_link) {
      return res.status(404).json({
        status: 404,
        message: "No job items file link available for this job",
      });
    }
    res.status(200).json({
      status: 200,
      message: "Job items file link retrieved successfully",
      job: {
        id: job._id,
        status: job.job_status,
        property_name: job.property_name,
        job_items_file_link: job.job_items_file_link,
      },
    });
  } catch (err: any) {
    console.error("Error getting job items file link:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job items file link",
      error: err.message,
    });
  }
}) as any);

app.get(
  "/api/worker-pool/status",
  (req: express.Request, res: express.Response) => {
    try {
      const otpAwareWorkerPoolStatus = otpAwareWorkerPool.getStatus();
      const otpStatus = otpAwareWorkerPool.getOtpStatus();

      res.status(200).json({
        status: 200,
        message: "Worker pool status retrieved successfully",
        otpAwareWorkerPool: otpAwareWorkerPoolStatus,
        otpStatus: otpStatus,
      });
    } catch (err: any) {
      console.error("Error getting worker pool status:", err);
      res.status(500).json({
        status: 500,
        message: "Error retrieving worker pool status",
        error: err.message,
      });
    }
  }
);

// Get OTP status only
app.get("/api/otp/status", (req: express.Request, res: express.Response) => {
  try {
    const otpStatus = otpAwareWorkerPool.getOtpStatus();

    res.status(200).json({
      status: 200,
      message: "OTP status retrieved successfully",
      otpStatus: otpStatus,
    });
  } catch (err: any) {
    console.error("Error getting OTP status:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving OTP status",
      error: err.message,
    });
  }
});

app.use("/api/properties", cookieStorageRoutes);

// * Global error handle middleware
app.use((err: any, req: any, res: any, next: any) => {
  if (res.headersSent) {
    return next(err);
  }

  const errMessage = err.message || "Something went wrong";
  const errStatus = err.status || 500;
  return res.status(errStatus).json({
    status: errStatus,
    message: errMessage,
  });
});

// Simple worker pool status endpoint
app.get(
  "/api/worker-pool/simple-status",
  (req: express.Request, res: express.Response) => {
    try {
      const status = otpAwareWorkerPool.getStatus();
      const otpStatus = otpAwareWorkerPool.getOtpStatus();

      res.status(200).json({
        status: "OK",
        timestamp: new Date().toISOString(),
        workers: {
          total: status.totalWorkers,
          available: status.availableWorkers,
          busy: status.busyWorkers,
        },
        queue: {
          size: status.queuedJobs,
          canAcceptNewJobs: !otpAwareWorkerPool.isQueueFull(),
        },
        otp: otpStatus,
        message:
          status.availableWorkers > 0
            ? "Ready for new jobs"
            : "All workers busy",
      });
    } catch (error) {
      res.status(500).json({
        status: "ERROR",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default app;
