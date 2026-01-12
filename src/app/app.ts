import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { isMainThread } from "worker_threads";
import { emailNotifier } from "../common/email-notifier.js";
import createError from "../common/error.js";
import { setCurrentWorkerId } from "../common/log-helper.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { JobType, WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { JobStatus } from "../models/job.model.js";
import { ScheduledJob } from "../models/scheduled-job.model.js";
// import {
//   CronConfig,
//   ScheduleType,
//   TimeUnit,
//   bookingTrustCron,
// } from "../services/booking-trust-cron.service.js";
// import { bookingTrustScheduler } from "../services/booking-trust-scheduler.service.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";

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

// API to resume scraping
app.post("/api/scraping/resume", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId, startDate, endDate, ota_provider, scraping_mode } = req.body;

    if (!jobId || !ota_provider) {
      return res.status(400).json({
        status: 400,
        message:
          "jobId, startDate, endDate, and ota_provider are required in request body",
      });
    }

    // Normalize ota_provider to handle case sensitivity and whitespace
    const normalizedOtaProvider = ota_provider.toString().trim();
    console.log(
      `Resume job - Original ota_provider: '${ota_provider}', Normalized: '${normalizedOtaProvider}'`
    );
    console.log(
      `Resume job - scraping_mode: '${scraping_mode || "undefined"}'`
    );

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

    // Check if job exists and is in stopped status
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    if (job.job_status !== JobStatus.Stopped) {
      return res.status(400).json({
        status: 400,
        message: `Job is not in Stopped status. Current status: ${job.job_status}`,
        currentStatus: job.job_status,
      });
    }

    // First, update job status to Pending to prepare for resume
    console.log(`Updating job ${jobId} status from Stopped to Pending`);
    const updatedJob = await jobService.updateJobStatus(
      jobId,
      JobStatus.Pending
    );

    if (!updatedJob) {
      return res.status(500).json({
        status: 500,
        message: `Failed to update job ${jobId} status to Pending`,
        jobId: jobId,
      });
    }

    // Determine job type based on OTA provider and prepare worker job data
    let workerJobData: WorkerJobData | undefined;

    if (normalizedOtaProvider === "Booking") {
      // Get Expedia credentials and data
      const jobData = await jobService.getBookingIdFromJob(jobId);

      if (!jobData || !jobData.bookingId) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is 0.`,
        });
      }

      if (!jobData.bookingUsername || !jobData.bookingPassword) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
        });
      }

      const { bookingId, bookingUsername, bookingPassword } = jobData;

      // Determine jobType based on scraping_mode
      let jobType: JobType = JobType.BookingRun;

      workerJobData = {
        jobType,
        jobId,
        startDate,
        endDate,
        bookingId,
        user_email: bookingUsername,
        user_password: bookingPassword,
      };
    } else {
      return res.status(400).json({
        status: 400,
        message: `Unsupported OTA provider: ${normalizedOtaProvider}. Supported values are: 'Booking'`,
      });
    }

    // Verify workerJobData was properly initialized
    if (!workerJobData) {
      console.error(
        `Failed to initialize workerJobData for job ${jobId} with ota_provider: ${normalizedOtaProvider}`
      );
      return res.status(500).json({
        status: 500,
        message: `Failed to initialize job data for OTA provider: ${normalizedOtaProvider}`,
        jobId: jobId,
      });
    }

    // Verify jobType is set
    if (!workerJobData.jobType) {
      console.error(
        `workerJobData.jobType is undefined for job ${jobId}. Full object:`,
        JSON.stringify(workerJobData, null, 2)
      );
      return res.status(500).json({
        status: 500,
        message: `Job type not properly set for job ${jobId}`,
        jobId: jobId,
      });
    }

    console.log(
      `Resuming stopped job ${jobId} with ${normalizedOtaProvider} using scraping_mode: ${
        scraping_mode || "undefined"
      }`
    );

    // Debug: Log the complete workerJobData object before sending to worker
    console.log(
      `Worker job data for ${jobId}:`,
      JSON.stringify(workerJobData, null, 2)
    );

    // Execute job in worker thread
    try {
      console.log(`Submitting resumed job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Job resume execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for resumed job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Worker execution failed for resumed job",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error resuming job:", err);

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
      message: "Error resuming job",
      error: err.message,
    });
  }
}) as any);

// API to stop scraping
app.post("/api/scraping/stop", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({
        status: 400,
        message: "jobId is required in request body",
      });
    }

    // Check if job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    // Attempt to stop the job in the worker pool
    const stopSuccess = await otpAwareWorkerPool.stopJob(jobId);

    if (stopSuccess) {
      // Update job status to Stopped in database
      const updatedJob = await jobService.updateJobStatus(
        jobId,
        JobStatus.Stopped
      );

      if (updatedJob) {
        res.status(200).json({
          status: 200,
          message: "Job stopped successfully",
          jobId: jobId,
          finalStatus: "Stopped",
        });
      } else {
        res.status(500).json({
          status: 500,
          message: "Job stopped but failed to update status in database",
          jobId: jobId,
        });
      }
    } else {
      // Job might not be currently running
      res.status(404).json({
        status: 404,
        message: "Job not found or not currently running",
        jobId: jobId,
      });
    }
  } catch (err: any) {
    console.error("Error stopping job:", err);
    res.status(500).json({
      status: 500,
      message: "Error stopping job",
      error: err.message,
    });
  }
}) as any);

app.post("/api/expedia/rerun-failed-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { startDate, endDate, jobId } = req.body;
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

    // 1. Get the job to check its current status
    const job = await jobService.getJobById(jobId);

    if (!job) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    // 2. Check if job is in Failed or Partial status
    if (
      job.job_status !== JobStatus.Failed &&
      job.job_status !== JobStatus.Partial
    ) {
      return res.status(400).json({
        status: 400,
        message: `Job is not in Failed or Partial status. Current status: ${job.job_status}`,
        currentStatus: job.job_status,
      });
    }

    // Store original status for response
    const originalStatus = job.job_status;

    // 3. Get expedia_id and credentials from job's property
    console.log(`Getting expedia_id for job ${jobId}...`);
    const jobData = await jobService.getExpediaIdFromJob(jobId);

    if (!jobData || !jobData.expediaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
      });
    }

    if (!jobData.user_email || !jobData.user_password) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
      });
    }

    const { expediaId, user_email, user_password } = jobData;

    console.log(
      `Rerunning failed/partial job ${jobId} with expedia_id: ${expediaId}`
    );

    // 4. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: JobType.RerunFailed,
      jobId,
      startDate,
      endDate,
      expediaId,
      user_email,
      user_password,
      originalStatus,
    };

    // 5. Execute job in worker thread
    try {
      console.log(`Submitting rerun job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Job rerun execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for rerun job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Worker execution failed for job rerun",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/rerun-failed-job:", err);

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
      message: "Error processing job rerun",
      error: err.message,
    });
  }
}) as any);

app.post("/api/expedia/property-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { startDate, endDate, jobId } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        status: 400,
        message: "startDate and endDate are required in request body",
      });
    }
    if (!jobId) {
      return res.status(400).json({
        status: 400,
        message: "jobId is required in request body",
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

    // 2. Get expedia_id from job's property
    console.log(`Getting expedia_id for job ${jobId}...`);
    const jobData = await jobService.getExpediaIdFromJob(jobId);

    if (!jobData || !jobData.expediaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
      });
    }

    if (!jobData.user_email || !jobData.user_password) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
      });
    }

    const { expediaId, user_email, user_password } = jobData;

    console.log(`Using expedia_id: ${expediaId} for scraping`);

    // 3. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: JobType.PropertyRun,
      jobId,
      startDate,
      endDate,
      expediaId,
      user_email,
      user_password,
    };

    // 4. Execute job in worker thread
    try {
      console.log(`Submitting job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Job execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Worker execution failed",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/property-run-job:", err);

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
      message: "Error processing property search",
      error: err.message,
    });
  }
}) as any);

app.post("/api/expedia/reservation-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const reservations = req.body.reservations as any[];
    if (!reservations || reservations.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "reservations array is required",
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

    // Generate job ID and prepare worker job data
    const jobId = `reservation_job_${Date.now()}`;

    const workerJobData: WorkerJobData = {
      jobType: JobType.ReservationRun,
      jobId,
      reservations,
    };

    // Execute job in worker thread
    try {
      console.log(`Submitting reservation job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Reservation job execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for reservation job ${jobId}:`, workerError);

      return res.status(500).json({
        status: 500,
        message: "Worker execution failed for reservation job",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/reservation-run-job:", err);

    res.status(500).json({
      status: 500,
      message: "Error processing reservation search",
      error: err.message,
    });
  }
}) as any);

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

    // 2. Stop the scraping operation
    const wasRunning = scrapingStateManager.isRunning();
    if (wasRunning) {
      scrapingStateManager.stopScraping();
      console.log(`Stopping scraping for job ${jobId}`);
    }

    // 3. Update job status to Failed
    const updatedJob = await jobService.updateJobStatus(
      jobId,
      JobStatus.Failed
    );
    if (!updatedJob) {
      return res.status(500).json({
        status: 500,
        message: `Failed to update job ${jobId} status`,
      });
    }

    console.log(`Job ${jobId} has been stopped and marked as Failed`);

    res.status(200).json({
      status: 200,
      message: "Booking scraping job stopped successfully",
      jobId,
      finalStatus: JobStatus.Failed,
      wasRunning,
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

// Booking Trust Scheduler Endpoints - COMMENTED OUT (Not needed currently)
/*
// API to run booking trust scheduler manually
app.post("/api/booking/trust-scheduler/run", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const stats = await bookingTrustScheduler.runTrustScheduler();

    res.status(200).json({
      status: 200,
      message: "Booking trust scheduler completed successfully",
      stats,
    });
  } catch (err: any) {
    console.error("Error in /api/booking/trust-scheduler/run:", err);
    res.status(500).json({
      status: 500,
      message: "Error running booking trust scheduler",
      error: err.message,
    });
  }
}) as any);

app.get(
  "/api/booking/trust-scheduler/status",
  (req: express.Request, res: express.Response) => {
    try {
      const status = bookingTrustScheduler.getSchedulerStatus();

      res.status(200).json({
        status: 200,
        message: "Trust scheduler status retrieved successfully",
        data: status,
      });
    } catch (err: any) {
      console.error("Error in /api/booking/trust-scheduler/status:", err);
      res.status(500).json({
        status: 500,
        message: "Error retrieving trust scheduler status",
        error: err.message,
      });
    }
  }
);

// API to manually verify a specific property's trust status
app.post("/api/booking/trust-scheduler/verify/:propertyId", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { propertyId } = req.params;

    if (!propertyId) {
      return res.status(400).json({
        status: 400,
        message: "Property ID is required",
      });
    }

    const result = await bookingTrustScheduler.verifySpecificProperty(
      propertyId
    );

    res.status(200).json({
      status: 200,
      message: "Property trust verification completed",
      result,
    });
  } catch (err: any) {
    console.error(
      `Error in /api/booking/trust-scheduler/verify/${req.params.propertyId}:`,
      err
    );
    res.status(500).json({
      status: 500,
      message: "Error verifying property trust status",
      error: err.message,
    });
  }
}) as any);

// API to get properties eligible for trust verification
app.get("/api/booking/trust-scheduler/eligible-properties", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const properties =
      await bookingTrustScheduler.getPropertiesForTrustVerification();

    res.status(200).json({
      status: 200,
      message: "Eligible properties retrieved successfully",
      data: {
        totalProperties: properties.length,
        properties: properties.map((p) => ({
          id: p._id,
          property_name: p.property_name,
          booking_id: p.booking_id,
          booking_trusted_status: p.booking_trusted_status,
          booking_last_login: p.booking_last_login,
        })),
      },
    });
  } catch (err: any) {
    console.error(
      "Error in /api/booking/trust-scheduler/eligible-properties:",
      err
    );
    res.status(500).json({
      status: 500,
      message: "Error retrieving eligible properties",
      error: err.message,
    });
  }
}) as any);

// Booking Trust Cron Management Endpoints
app.post("/api/booking/trust-scheduler/cron/configuration", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { enabled, schedule, timezone } = req.body;

    // Validate required fields
    if (!schedule || !schedule.type || schedule.value === undefined) {
      return res.status(400).json({
        status: 400,
        message: "Schedule with type and value is required",
      });
    }

    // Validate schedule type
    if (!Object.values(ScheduleType).includes(schedule.type)) {
      return res.status(400).json({
        status: 400,
        message: `Invalid schedule type. Must be one of: ${Object.values(
          ScheduleType
        ).join(", ")}`,
      });
    }

    // Validate unit for interval type
    if (
      schedule.type === ScheduleType.INTERVAL &&
      (!schedule.unit || !Object.values(TimeUnit).includes(schedule.unit))
    ) {
      return res.status(400).json({
        status: 400,
        message: `Invalid unit for interval. Must be one of: ${Object.values(
          TimeUnit
        ).join(", ")}`,
      });
    }

    // Validate specific time format
    if (schedule.type === ScheduleType.SPECIFIC) {
      if (typeof schedule.value !== "string") {
        return res.status(400).json({
          status: 400,
          message: "Specific time must be a string in HH:MM format",
        });
      }
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.value)) {
        return res.status(400).json({
          status: 400,
          message: "Invalid time format. Use HH:MM format (e.g., '09:00')",
        });
      }
    }

    const config: CronConfig = {
      enabled: enabled !== undefined ? enabled : true,
      schedule,
      timezone: timezone || "UTC",
    };

    bookingTrustCron.configure(config);

    res.status(200).json({
      status: 200,
      message: "Cron configuration updated successfully",
      data: config,
    });
  } catch (err: any) {
    res.status(400).json({
      status: 400,
      message: "Error updating configuration",
      error: err.message,
    });
  }
}) as any);

// GET /api/booking/trust-scheduler/cron/configuration
app.get("/api/booking/trust-scheduler/cron/configuration", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const config = bookingTrustCron.getConfiguration();
    res.status(200).json({
      status: 200,
      message: "Cron configuration retrieved successfully",
      data: config,
    });
  } catch (err: any) {
    res.status(500).json({
      status: 500,
      message: "Error retrieving configuration",
      error: err.message,
    });
  }
}) as any);

// POST /api/booking/trust-scheduler/cron/enabled
app.post("/api/booking/trust-scheduler/cron/enabled", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        status: 400,
        message: "Enabled parameter is required and must be a boolean",
      });
    }

    const config = bookingTrustCron.getConfiguration();
    config.enabled = enabled;
    bookingTrustCron.configure(config);

    res.status(200).json({
      status: 200,
      message: `Cron job ${enabled ? "enabled" : "disabled"} successfully`,
      data: {
        enabled: config.enabled,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      status: 500,
      message: "Error updating cron job status",
      error: err.message,
    });
  }
}) as any);

// API to get booking trust cron status
app.get(
  "/api/booking/trust-scheduler/cron/status",
  (req: express.Request, res: express.Response) => {
    try {
      const cronStatus = bookingTrustCron.getStatus();

      res.status(200).json({
        status: 200,
        message: "Trust scheduler cron status retrieved successfully",
        data: cronStatus,
      });
    } catch (err: any) {
      console.error("Error in /api/booking/trust-scheduler/cron/status:", err);
      res.status(500).json({
        status: 500,
        message: "Error retrieving cron service status",
        error: err.message,
      });
    }
  }
);

// API to manually trigger cron verification (for testing)
app.post("/api/booking/trust-scheduler/cron/trigger", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    await bookingTrustCron.runManual();

    res.status(200).json({
      status: 200,
      message: "Manual booking trust verification triggered successfully",
    });
  } catch (err: any) {
    console.error("Error in /api/booking/trust-scheduler/cron/trigger:", err);
    res.status(500).json({
      status: 500,
      message: "Error triggering manual verification",
      error: err.message,
    });
  }
}) as any);
*/

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
