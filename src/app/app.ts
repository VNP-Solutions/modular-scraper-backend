import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import createError from "../common/error.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { workerPool } from "../common/worker-pool.js";
import { JobType, WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { Job, JobStatus } from "../models/job.model.js";
import { jobService } from "../services/job.service.js";
import { bookingTrustScheduler } from "../services/booking-trust-scheduler.service.js";
import { bookingTrustCron } from "../services/booking-trust-cron.service.js";
import { emailNotifier } from "../common/email-notifier.js";

// Import route modules
import authRoutes from "../routes/shared/auth.routes.js";
import healthRoutes from "../routes/shared/health.routes.js";

// Expedia-specific routes
import expediarJobsRoutes from "../routes/expedia/jobs.routes.js";
import expediarScrapingControlRoutes from "../routes/expedia/scraping-control.routes.js";
import expediarScrapingRoutes from "../routes/expedia/scraping.routes.js";

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
      .json({ messge: "Connection established on time-gap3 branch" });
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
      jobId: 'test-captcha-job-123',
      jobName: 'Booking.com CAPTCHA Test',
      propertyName: 'Test Hotel Property',
      expediaId: 'TEST123',
      errorMessage: 'CAPTCHA detected during Booking.com login - Manual intervention required',
      errorDetails: {
        sessionUrl: 'https://chrome.browserless.io/session/test-session-id',
        currentUrl: 'https://admin.booking.com/signin',
        timestamp: new Date().toISOString(),
        instructions: 'Please visit the session URL to solve the CAPTCHA. The system will automatically detect when solved.',
      },
      timestamp: new Date(),
      stage: 'Login - CAPTCHA Challenge',
    };

    const recipients = ['admin@vnpsolutions.com', 'developer@vnpsolutions.com'];
    
    await emailNotifier.sendErrorEmail(recipients, testData);
    
    res.json({
      success: true,
      message: 'CAPTCHA test email sent successfully!',
      recipients: recipients,
      mailhogUrl: 'http://localhost:8025'
    });
  } catch (error:any) {
    console.error('Email test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
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
app.post(
  "/api/scraping/resume",
  (req: express.Request, res: express.Response) => {
    try {
      const success = scrapingStateManager.resumeScraping();

      if (success) {
        res.status(200).json({
          status: 200,
          message: "Scraping resumed successfully",
          data: scrapingStateManager.getState(),
        });
      } else {
        res.status(400).json({
          status: 400,
          message: "Cannot resume scraping - no paused scraping job found",
        });
      }
    } catch (err: any) {
      console.error("Error resuming scraping:", err);
      res.status(500).json({
        status: 500,
        message: "Error resuming scraping",
        error: err.message,
      });
    }
  }
);

// API to stop scraping
app.post(
  "/api/scraping/stop",
  (req: express.Request, res: express.Response) => {
    try {
      const wasRunning = scrapingStateManager.isRunning();
      scrapingStateManager.stopScraping();

      if (wasRunning) {
        res.status(200).json({
          status: 200,
          message: "Scraping stopped successfully",
          data: scrapingStateManager.getState(),
        });
      } else {
        res.status(200).json({
          status: 200,
          message: "No scraping job was running",
          data: scrapingStateManager.getState(),
        });
      }
    } catch (err: any) {
      console.error("Error stopping scraping:", err);
      res.status(500).json({
        status: 500,
        message: "Error stopping scraping",
        error: err.message,
      });
    }
  }
);

app.post("/api/expedia/rerun-failed-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { startDate, endDate, jobId } = req.body;
// Route registrations
// Health and authentication routes (no prefix)
app.use("/", healthRoutes);
app.use("/", authRoutes);

// API routes (keeping original endpoints)
app.use("/api/scraping", expediarScrapingControlRoutes);
app.use("/api/jobs", expediarJobsRoutes);
app.use("/api/expedia", expediarScrapingRoutes);

// Global error handle middleware
    // Check if worker threads are available
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: workerPool.getStatus(),
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

      const result = await workerPool.executeJob(workerJobData);

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
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: workerPool.getStatus(),
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

      const result = await workerPool.executeJob(workerJobData);

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
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: workerPool.getStatus(),
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

      const result = await workerPool.executeJob(workerJobData);

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

app.post("/api/booking/run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId, startDate, endDate } = req.body;

    // Validate required parameters
    if (!jobId || !startDate || !endDate) {
      return res.status(400).json({
        status: 400,
        message: "jobId, startDate and endDate are required in request body",
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

    // 2. Get booking_id, credentials, and job details from job's property
    console.log(`Getting booking_id and job details for booking job ${jobId}...`);
    const jobData = await jobService.getBookingIdFromJob(jobId);

    if (!jobData || !jobData.bookingId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
      });
    }

    if (!jobData.user_email || !jobData.user_password) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
      });
    }

    if (!jobData.portfolioId || !jobData.propertyId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
      });
    }

    const { bookingId, user_email, user_password, portfolioId, propertyId } = jobData;

    console.log(`Using booking_id: ${bookingId} for booking scraping`);

    // 3. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: JobType.BookingRun,
      jobId,
      portfolioId,
      propertyId,
      startDate,
      endDate,
      bookingId,
      user_email,
      user_password,
    };

    // 4. Execute job in worker thread
    try {
      console.log(`Submitting booking job ${jobId} to worker pool...`);

      const result = await workerPool.executeJob(workerJobData);

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

    // 3. Update job status to Cancelled
    const updatedJob = await jobService.updateJobStatus(jobId, JobStatus.Cancelled);
    if (!updatedJob) {
      return res.status(500).json({
        status: 500,
        message: `Failed to update job ${jobId} status`,
      });
    }

    console.log(`Job ${jobId} has been stopped and marked as Cancelled`);

    res.status(200).json({
      status: 200,
      message: "Booking scraping job stopped successfully",
      jobId,
      finalStatus: JobStatus.Cancelled,
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
    const { jobId, startDate, endDate } = req.body;

    // Validate required parameters
    if (!jobId || !startDate || !endDate) {
      return res.status(400).json({
        status: 400,
        message: "jobId, startDate and endDate are required in request body",
      });
    }

    // Check if worker threads are available
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All server busy, try again",
        workerStatus: workerPool.getStatus(),
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

    if (!jobData || !jobData.bookingId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid booking_id for job ${jobId}. Property may not have booking_id assigned or booking_id is "0".`,
      });
    }

    if (!jobData.user_email || !jobData.user_password) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
      });
    }

    if (!jobData.portfolioId || !jobData.propertyId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid portfolioId or propertyId for job ${jobId}. Job may be missing required references.`,
      });
    }

    const { bookingId, user_email, user_password, portfolioId, propertyId } = jobData;

    console.log(
      `Rerunning failed booking job ${jobId} (attempt ${updatedJob.retries_attempted}/${updatedJob.max_retries}) with booking_id: ${bookingId}`
    );

    // 4. Prepare worker job data for rerun
    const workerJobData: WorkerJobData = {
      jobType: JobType.BookingRerunFailed,
      jobId,
      portfolioId,
      propertyId,
      startDate,
      endDate,
      bookingId,
      user_email,
      user_password,
      originalStatus,
    };

    // 5. Execute job in worker thread
    try {
      console.log(`Submitting booking rerun job ${jobId} to worker pool...`);

      const result = await workerPool.executeJob(workerJobData);

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
      console.error(`Worker error for booking rerun job ${jobId}:`, workerError);

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
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
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

// Test endpoint for multi-platform scraper functionality
app.get("/api/scraping/test-platforms", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { mainMultiPlatform } = await import("../main-multi-platform.js");

    res.status(200).json({
      status: 200,
      message: "Multi-platform scraper test endpoint",
      supportedPlatforms: ['expedia', 'booking'],
      testResults: {
        expedia: "Ready - Uses existing Expedia scraper with multi-platform interface",
        booking: "Ready - Uses new Booking.com scraper with Browserless integration"
      },
      endpoints: {
        expedia: "/api/expedia/property-run-job",
        booking: "/api/booking/run-job"
      },
      note: "Both platforms now use the unified multi-platform scraper system"
    });
  } catch (err: any) {
    res.status(500).json({
      status: 500,
      message: "Error testing multi-platform scraper",
      error: err.message,
    });
  }
}) as any);

app.get(
  "/api/worker-pool/status",
  (req: express.Request, res: express.Response) => {
    try {
      const workerPoolStatus = workerPool.getStatus();

      res.status(200).json({
        status: 200,
        message: "Worker pool status retrieved successfully",
        workerPool: workerPoolStatus,
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

// Booking Trust Scheduler Endpoints

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

// API to get booking trust scheduler status
app.get("/api/booking/trust-scheduler/status", (
  req: express.Request,
  res: express.Response
) => {
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
});

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
    
    const result = await bookingTrustScheduler.verifySpecificProperty(propertyId);
    
    res.status(200).json({
      status: 200,
      message: "Property trust verification completed",
      result,
    });
  } catch (err: any) {
    console.error(`Error in /api/booking/trust-scheduler/verify/${req.params.propertyId}:`, err);
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
    const properties = await bookingTrustScheduler.getPropertiesForTrustVerification();
    
    res.status(200).json({
      status: 200,
      message: "Eligible properties retrieved successfully",
      data: {
        totalProperties: properties.length,
        properties: properties.map(p => ({
          id: p._id,
          property_name: p.property_name,
          booking_id: p.booking_id,
          booking_trusted_status: p.booking_trusted_status,
          booking_last_login: p.booking_last_login,
        })),
      },
    });
  } catch (err: any) {
    console.error("Error in /api/booking/trust-scheduler/eligible-properties:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving eligible properties",
      error: err.message,
    });
  }
}) as any);

// Booking Trust Cron Management Endpoints

// API to get booking trust cron status
app.get("/api/booking/trust-scheduler/cron/status", (
  req: express.Request,
  res: express.Response
) => {
  try {
    const cronStatus = bookingTrustCron.getStatus();
    const schedulerStatus = bookingTrustScheduler.getSchedulerStatus();
    
    res.status(200).json({
      status: 200,
      message: "Trust scheduler cron status retrieved successfully",
      data: {
        cron: cronStatus,
        scheduler: schedulerStatus,
      },
    });
  } catch (err: any) {
    console.error("Error in /api/booking/trust-scheduler/cron/status:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving cron service status",
      error: err.message,
    });
  }
});

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

export default app;
