import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import {
  scrapeAgodaSupportEmail,
  scrapeSupportEmailsForJobs,
} from "../agoda/support-email/support-email-scraper.js";
import createError from "../common/error.js";
import {
  getAcceptLanguage,
  getBrightDataSessionId,
  getTimezone,
  getWindowSize,
} from "../common/job-isolation.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import {
  CaseStatus,
  JobStatus,
  REPLY_DEADLINE_HOURS,
  ReplyStatus,
} from "../models/job.model.js";
import { ScheduledJob } from "../models/scheduled-job.model.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";
import {
  retrievalService,
  type CollectRetrievalInput,
} from "../services/retrieval.service.js";
import { supportEmailService } from "../services/support-email.service.js";

const app = express();

app.set("trust proxy", true);

app.use("/webhook", bodyParser.raw({ type: "*/*" }));
// app.use(bodyParser.raw({ type: '*/*' }))
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

// * Logger middleware
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

/**
 * @swagger
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: Health check endpoint
 *     description: Check if the server is running and accessible
 *     responses:
 *       200:
 *         description: Server is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 messge:
 *                   type: string
 *                   example: "Connection established"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// ? API to check connection to servers (health api)
app.get("/", (req, res, next) => {
  try {
    res.status(200).json({
      messge: "Connection established on agoda-thread-proxy branch",
    });
  } catch (err: any) {
    next(createError(err.status, err.message));
  }
});

/**
 * @swagger
 * /auth:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Initiate OAuth authentication
 *     description: Start the OAuth authentication flow for accessing Expedia services
 *     responses:
 *       200:
 *         description: Authentication flow initiated
 *       500:
 *         description: Authentication error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// ~ Router starts here
app.get("/auth", getAccess as any);

/**
 * @swagger
 * /oauth2callback:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: OAuth callback endpoint
 *     description: Handle OAuth callback after user authentication
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from OAuth provider
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter for security
 *     responses:
 *       200:
 *         description: OAuth callback processed successfully
 *       400:
 *         description: Invalid OAuth callback parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get("/oauth2callback", getOauth2Callback as any);

/**
 * @swagger
 * /api/scraping/status:
 *   get:
 *     tags:
 *       - Scraping Control
 *     summary: Get current scraping status
 *     description: Retrieve the current state and progress of scraping operations
 *     responses:
 *       200:
 *         description: Scraping status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping status retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error retrieving scraping status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/scraping/pause:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Pause current scraping job
 *     description: Gracefully pause the currently running scraping job. The current operation will complete before pausing.
 *     responses:
 *       200:
 *         description: Scraping paused successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping paused successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       400:
 *         description: Cannot pause scraping - no active job running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "Cannot pause scraping - no active scraping job running"
 *       500:
 *         description: Error pausing scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/scraping/resume:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Resume stopped scraping job
 *     description: Resume a stopped scraping job with the specified parameters. The job must be in 'Stopped' status to be resumed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jobId
 *               - startDate
 *               - endDate
 *               - ota_provider
 *             properties:
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the stopped job to resume
 *                 example: "507f1f77bcf86cd799439011"
 *               startDate:
 *                 type: string
 *                 description: Start date for scraping (MM/DD/YYYY format)
 *                 example: "01/01/2024"
 *               endDate:
 *                 type: string
 *                 description: End date for scraping (MM/DD/YYYY format)
 *                 example: "01/31/2024"
 *               ota_provider:
 *                 type: string
 *                 enum: [Expedia, Agoda]
 *                 description: OTA provider to use for scraping
 *                 example: "Expedia"
 *               scraping_mode:
 *                 type: string
 *                 enum: [expedia, graphql]
 *                 description: Optional. Scraping mode for Expedia jobs only (ignored for Agoda). Defaults to "expedia" if not provided. Use "graphql" for GraphQL-based scraping or "expedia" for traditional DOM scraping.
 *                 example: "expedia"
 *     responses:
 *       200:
 *         description: Job resumed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Job resumed successfully"
 *                 jobId:
 *                   type: string
 *                   example: "507f1f77bcf86cd799439011"
 *                 finalStatus:
 *                   type: string
 *                   example: "Completed"
 *       400:
 *         description: Invalid request or job not in stopped status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "Job is not in Stopped status. Current status: Running"
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Job not found"
 *       500:
 *         description: Error resuming job
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to resume stopped scraping job
app.post("/api/scraping/resume", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId, startDate, endDate, ota_provider, scraping_mode } = req.body;

    if (!jobId || !startDate || !endDate || !ota_provider) {
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

    if (normalizedOtaProvider === "Expedia") {
      // Get Expedia credentials and data
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

      // Determine jobType based on scraping_mode
      let jobType: "property-run" | "graphql-run";
      if (scraping_mode === "graphql") {
        jobType = "graphql-run";
      } else {
        // Default to property-run for "expedia" mode or undefined
        jobType = "property-run";
      }

      console.log(
        `Using jobType: '${jobType}' for scraping_mode: '${
          scraping_mode || "undefined"
        }'`
      );

      workerJobData = {
        jobType,
        jobId,
        startDate,
        endDate,
        expediaId,
        user_email,
        user_password,
      };
    } else if (normalizedOtaProvider === "Agoda") {
      // Get Agoda credentials and data (scraping_mode is ignored for Agoda)
      const propertyData = await jobService.getAgodaIdFromJob(jobId);
      const propertyCredentials =
        await propertyCredentialsService.getCredentialsByJobId(jobId);

      if (!propertyData || !propertyData.agodaId) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`,
        });
      }

      if (
        !propertyCredentials?.agodaUsername ||
        !propertyCredentials?.agodaPassword
      ) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}. Property may not have agodaUsername or agodaPassword assigned.`,
        });
      }

      const { agodaId } = propertyData;
      const { agodaUsername, agodaPassword } = propertyCredentials;

      workerJobData = {
        jobType: "agoda-property-run",
        jobId,
        startDate,
        endDate,
        agodaId,
        agodaUsername,
        agodaPassword,
      };
    } else {
      return res.status(400).json({
        status: 400,
        message: `Unsupported OTA provider: ${normalizedOtaProvider}. Supported values are: 'Expedia', 'Agoda'`,
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

/**
 * @swagger
 * /api/scraping/stop:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Stop specific scraping job
 *     description: Stop a specific running scraping job by job ID. The job will be terminated and marked as stopped.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jobId
 *             properties:
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the job to stop
 *                 example: "507f1f77bcf86cd799439011"
 *     responses:
 *       200:
 *         description: Job stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Job stopped successfully"
 *                 jobId:
 *                   type: string
 *                   example: "507f1f77bcf86cd799439011"
 *                 finalStatus:
 *                   type: string
 *                   example: "Stopped"
 *       400:
 *         description: Missing jobId or invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "jobId is required in request body"
 *       404:
 *         description: Job not found or not currently running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Job not found or not currently running"
 *       500:
 *         description: Error stopping job
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to stop specific scraping job
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

/**
 * @swagger
 * /api/expedia/rerun-failed-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Rerun failed or partial failed job
 *     description: Rerun a job that has failed or partially completed. This endpoint supports both Expedia and Agoda jobs based on the ota_provider field. It specifically handles jobs with Failed or Partial status and resets them to run again. For Expedia jobs, you can also specify scraping_mode to choose between traditional DOM scraping or GraphQL-based scraping.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *               - jobId
 *               - ota_provider
 *             properties:
 *               startDate:
 *                 type: string
 *                 description: Start date for scraping (MM/DD/YYYY format)
 *                 example: "01/01/2024"
 *               endDate:
 *                 type: string
 *                 description: End date for scraping (MM/DD/YYYY format)
 *                 example: "01/31/2024"
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the failed/partial job to rerun
 *                 example: "507f1f77bcf86cd799439011"
 *               ota_provider:
 *                 type: string
 *                 enum: [Expedia, Agoda]
 *                 description: OTA provider to use for scraping
 *                 example: "Expedia"
 *               scraping_mode:
 *                 type: string
 *                 enum: [expedia, graphql]
 *                 description: Optional. Scraping mode for Expedia jobs only (ignored for Agoda). Defaults to "expedia" if not provided. Use "graphql" for GraphQL-based scraping or "expedia" for traditional DOM scraping.
 *                 example: "expedia"
 *     responses:
 *       200:
 *         description: Failed/partial job rerun completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Failed job rerun completed successfully"
 *                 jobId:
 *                   type: string
 *                   example: "507f1f77bcf86cd799439011"
 *                 originalStatus:
 *                   type: string
 *                   example: "Failed"
 *                 finalStatus:
 *                   type: string
 *                   example: "Completed"
 *                 progress:
 *                   type: object
 *                   properties:
 *                     totalItems:
 *                       type: integer
 *                       example: 150
 *                     itemsWithCardInfo:
 *                       type: integer
 *                       example: 140
 *                     itemsWithPaymentInfo:
 *                       type: integer
 *                       example: 135
 *                     completionPercentage:
 *                       type: integer
 *                       example: 90
 *       400:
 *         description: Invalid request or job not eligible for rerun
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "Job is not in Failed or Partial status. Current status: Completed"
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Job with ID 507f1f77bcf86cd799439011 not found"
 *       500:
 *         description: Error processing job rerun
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/expedia/rerun-failed-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { startDate, endDate, jobId, ota_provider, scraping_mode } = req.body;

    // Validate required parameters
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
    if (!ota_provider) {
      return res.status(400).json({
        status: 400,
        message: "ota_provider is required in request body",
      });
    }

    // Normalize ota_provider to handle case sensitivity and whitespace
    const normalizedOtaProvider = ota_provider.toString().trim();
    console.log(
      `Rerun failed job - Original ota_provider: '${ota_provider}', Normalized: '${normalizedOtaProvider}'`
    );
    console.log(
      `Rerun failed job - scraping_mode: '${scraping_mode || "undefined"}'`
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

    // First, update job status to Pending to prepare for rerun
    console.log(
      `Updating job ${jobId} status from ${originalStatus} to Pending`
    );
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

    // Prepare worker job data based on OTA provider
    let workerJobData: WorkerJobData | undefined;

    if (normalizedOtaProvider === "Expedia") {
      // Get Expedia credentials and data
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
          message: `Cannot retrieve valid Expedia credentials for job ${jobId}. Property may not have credentials assigned.`,
        });
      }

      const { expediaId, user_email, user_password } = jobData;

      // Determine jobType based on scraping_mode
      let jobType: "rerun-failed" | "graphql-run";
      if (scraping_mode === "graphql") {
        jobType = "graphql-run";
      } else {
        // Default to rerun-failed for "expedia" mode or undefined
        jobType = "rerun-failed";
      }

      console.log(
        `Using jobType: '${jobType}' for scraping_mode: '${
          scraping_mode || "undefined"
        }'`
      );

      console.log(
        `Rerunning failed/partial job ${jobId} with expedia_id: ${expediaId}`
      );

      workerJobData = {
        jobType,
        jobId,
        startDate,
        endDate,
        expediaId,
        user_email,
        user_password,
        originalStatus,
      };
    } else if (normalizedOtaProvider === "Agoda") {
      // Get Agoda credentials and data (scraping_mode is ignored for Agoda)
      const propertyData = await jobService.getAgodaIdFromJob(jobId);
      const propertyCredentials =
        await propertyCredentialsService.getCredentialsByJobId(jobId);

      if (!propertyData || !propertyData.agodaId) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`,
        });
      }

      if (
        !propertyCredentials?.agodaUsername ||
        !propertyCredentials?.agodaPassword
      ) {
        return res.status(400).json({
          status: 400,
          message: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}. Property may not have agodaUsername or agodaPassword assigned.`,
        });
      }

      const { agodaId } = propertyData;
      const { agodaUsername, agodaPassword } = propertyCredentials;

      console.log(
        `Rerunning failed/partial Agoda job ${jobId} with agoda_id: ${agodaId}`
      );

      workerJobData = {
        jobType: "agoda-rerun-failed",
        jobId,
        startDate,
        endDate,
        agodaId,
        agodaUsername,
        agodaPassword,
        originalStatus,
      };
    } else {
      return res.status(400).json({
        status: 400,
        message: `Unsupported OTA provider: ${normalizedOtaProvider}. Supported values are: 'Expedia', 'Agoda'`,
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
      `Rerunning failed/partial job ${jobId} with ${normalizedOtaProvider} using scraping_mode: ${
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

/**
 * @swagger
 * /api/expedia/property-run-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Start property scraping job
 *     description: Start a new property scraping job for the specified property ID, date range, and job ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *               - jobId
 *             properties:
 *               startDate:
 *                 type: string
 *                 description: Start date for scraping (MM/DD/YYYY format)
 *                 example: "01/01/2024"
 *               endDate:
 *                 type: string
 *                 description: End date for scraping (MM/DD/YYYY format)
 *                 example: "01/31/2024"
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the job to run. The job's property must have a valid expedia_id (not "0")
 *                 example: "507f1f77bcf86cd799439011"
 *     responses:
 *       200:
 *         description: Property scraping job completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Property search completed successfully"
 *                 propertyId:
 *                   type: string
 *                   example: "12345"
 *                 jobId:
 *                   type: string
 *                   example: "job_12345_1703123456789"
 *       400:
 *         description: Missing required parameters in request body
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "startDate and endDate are required in request body"
 *                   enum:
 *                     - "startDate and endDate are required in request body"
 *                     - "jobId is required in request body"
 *       409:
 *         description: Scraping job already running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 409
 *                 message:
 *                   type: string
 *                   example: "Scraping job is already running"
 *                 currentState:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error processing property search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
      jobType: "property-run",
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

/**
 * @swagger
 * /api/expedia/reservation-run-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Start reservation scraping job
 *     description: Start a new reservation scraping job for the specified reservations
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reservations
 *             properties:
 *               reservations:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/Reservation'
 *                 description: Array of reservations to scrape
 *                 example:
 *                   - reservationId: "RES123"
 *                     propertyId: "PROP456"
 *                   - reservationId: "RES124"
 *                     propertyId: "PROP457"
 *     responses:
 *       200:
 *         description: Reservation scraping job completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Reservation search completed successfully"
 *                 reservations:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Reservation'
 *                 jobId:
 *                   type: string
 *                   example: "reservation_job_1703123456789"
 *       400:
 *         description: Missing or invalid reservations array
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "reservations array is required"
 *       409:
 *         description: Scraping job already running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 409
 *                 message:
 *                   type: string
 *                   example: "Scraping job is already running"
 *                 currentState:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error processing reservation search
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
      jobType: "reservation-run",
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

/**
 * @swagger
 * /api/jobs/{jobId}/progress:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job progress
 *     description: Get detailed progress information for a specific job including scraped data statistics
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get progress for
 *         example: "507f1f77bcf86cd799439011"
 *     responses:
 *       200:
 *         description: Job progress retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Job progress retrieved successfully"
 *                 job:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                     property_name:
 *                       type: string
 *                     portfolio_name:
 *                       type: string
 *                 progress:
 *                   type: object
 *                   properties:
 *                     totalItems:
 *                       type: integer
 *                     itemsWithCardInfo:
 *                       type: integer
 *                     itemsWithPaymentInfo:
 *                       type: integer
 *                     completionPercentage:
 *                       type: integer
 *       404:
 *         description: Job not found
 *       500:
 *         description: Server error
 */
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

/**
 * @swagger
 * /api/jobs/{jobId}/items:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job items
 *     description: Get scraped reservation data for a specific job
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get items for
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of items to return per page
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: createdAt
 *         description: Field to sort by (e.g., guest_name, reservation_id, createdAt, etc.)
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order (asc or desc)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by guest name or reservation ID (partial match, case-insensitive)
 *       - in: query
 *         name: reasonForCharge
 *         schema:
 *           type: string
 *         description: Filter by reason for charge (partial match, case-insensitive)
 *     responses:
 *       200:
 *         description: Job items retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Job items retrieved successfully"
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       guest_name:
 *                         type: string
 *                       reservation_id:
 *                         type: string
 *                       confirmation_number:
 *                         type: string
 *                       check_in_date:
 *                         type: string
 *                         format: date
 *                       check_out_date:
 *                         type: string
 *                         format: date
 *                       room_type:
 *                         type: string
 *                       booking_amount:
 *                         type: number
 *                       has_card_info:
 *                         type: boolean
 *                       has_payment_info:
 *                         type: boolean
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     totalDocuments:
 *                       type: integer
 *                     currentPage:
 *                       type: integer
 *                     totalPage:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *       404:
 *         description: Job not found
 *       500:
 *         description: Server error
 */
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

/**
 * @swagger
 * /api/jobs/{jobId}/log:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job log link
 *     description: Get the S3 URL for the job's log file
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get log link for
 *     responses:
 *       200:
 *         description: Job log link retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Job log link retrieved successfully"
 *                 job:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                     property_name:
 *                       type: string
 *                     log_link:
 *                       type: string
 *                       description: S3 URL of the job log file
 *       404:
 *         description: Job not found or no log available
 *       500:
 *         description: Server error
 */
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

/**
 * @swagger
 * /api/worker-pool/status:
 *   get:
 *     tags:
 *       - Worker Pool
 *     summary: Get worker pool status
 *     description: Get detailed information about the worker pool including available workers, busy workers, and queue status
 *     responses:
 *       200:
 *         description: Worker pool status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Worker pool status retrieved successfully"
 *                 otpAwareWorkerPool:
 *                   type: object
 *                   properties:
 *                     totalWorkers:
 *                       type: integer
 *                       example: 3
 *                     availableWorkers:
 *                       type: integer
 *                       example: 2
 *                     busyWorkers:
 *                       type: integer
 *                       example: 1
 *                     queuedJobs:
 *                       type: integer
 *                       example: 0
 *                     workers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           isAvailable:
 *                             type: boolean
 *                           currentJobId:
 *                             type: string
 *                           startTime:
 *                             type: string
 *                             format: date-time
 *                           lastActivity:
 *                             type: string
 *                             format: date-time
 *       500:
 *         description: Server error
 */
app.get(
  "/api/worker-pool/status",
  (req: express.Request, res: express.Response) => {
    try {
      const otpAwareWorkerPoolStatus = otpAwareWorkerPool.getStatus();

      res.status(200).json({
        status: 200,
        message: "Worker pool status retrieved successfully",
        otpAwareWorkerPool: otpAwareWorkerPoolStatus,
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

/**
 * @swagger
 * /api/expedia/graphql-run-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Start GraphQL-based property scraping job
 *     description: Start a new GraphQL-based property scraping job for the specified property ID, date range, and job ID. This endpoint uses GraphQL queries for more efficient data retrieval compared to traditional DOM scraping.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *               - jobId
 *             properties:
 *               startDate:
 *                 type: string
 *                 description: Start date for scraping (MM/DD/YYYY format)
 *                 example: "01/01/2024"
 *               endDate:
 *                 type: string
 *                 description: End date for scraping (MM/DD/YYYY format)
 *                 example: "01/31/2024"
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the job to run. The job's property must have a valid expedia_id (not "0")
 *                 example: "507f1f77bcf86cd799439011"
 *     responses:
 *       200:
 *         description: GraphQL property scraping job completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Property scraping completed successfully"
 *                   enum:
 *                     - "Property scraping completed successfully"
 *                     - "Property scraping partial successfully"
 *                     - "Property scraping failed successfully"
 *                 expediaId:
 *                   type: string
 *                   description: The Expedia property ID that was scraped
 *                   example: "12345"
 *                 jobId:
 *                   type: string
 *                   description: The job ID that was processed
 *                   example: "507f1f77bcf86cd799439011"
 *                 progress:
 *                   type: object
 *                   description: Final scraping progress statistics
 *                   properties:
 *                     totalItems:
 *                       type: integer
 *                       description: Total number of reservations processed
 *                       example: 150
 *                     itemsWithCardInfo:
 *                       type: integer
 *                       description: Number of reservations with card information scraped
 *                       example: 140
 *                     itemsWithPaymentInfo:
 *                       type: integer
 *                       description: Number of reservations with payment information scraped
 *                       example: 135
 *                     completionPercentage:
 *                       type: integer
 *                       description: Percentage of successful scraping completion
 *                       example: 90
 *                 finalStatus:
 *                   type: string
 *                   enum: [Completed, Partial, Failed]
 *                   description: Final status of the scraping job
 *                   example: "Completed"
 *                 logInfo:
 *                   type: object
 *                   nullable: true
 *                   description: Information about the job log file (if available)
 *                   properties:
 *                     logFilePath:
 *                       type: string
 *                       description: Path to the log file
 *                     logEntriesCount:
 *                       type: integer
 *                       description: Number of log entries
 *                     note:
 *                       type: string
 *                       example: "Log file uploaded to S3 and deleted locally after job completion"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "startDate and endDate are required in request body"
 *                   enum:
 *                     - "startDate and endDate are required in request body"
 *                     - "jobId is required in request body"
 *                     - "Cannot retrieve valid expedia_id for job {jobId}. Property may not have expedia_id assigned or expedia_id is \"0\"."
 *                     - "Cannot retrieve valid expediaUsername or expediaPassword for job {jobId}. Property may not have expediaUsername or expediaPassword assigned."
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Job with ID 507f1f77bcf86cd799439011 not found"
 *       409:
 *         description: Job cannot be run (invalid state)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 409
 *                 message:
 *                   type: string
 *                   example: "Job 507f1f77bcf86cd799439011 is not in a runnable state. Current status: Running"
 *                 currentState:
 *                   type: object
 *                   description: Current job object with status information
 *       500:
 *         description: Internal server error during scraping process
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 500
 *                 message:
 *                   type: string
 *                   example: "Error processing property search"
 *                 error:
 *                   type: string
 *                   description: Detailed error message
 *                   example: "GraphQL query failed: Network timeout"
 */
app.post("/api/expedia/graphql-run-job", (async (
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

    console.log(`Using expedia_id: ${expediaId} for GraphQL scraping`);

    // 3. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: "graphql-run",
      jobId,
      startDate,
      endDate,
      expediaId,
      user_email,
      user_password,
    };

    // 4. Execute job in worker thread
    try {
      console.log(`Submitting GraphQL job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "GraphQL job execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Worker error for GraphQL job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "GraphQL worker execution failed",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/graphql-run-job:", err);

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
      message: "Error processing GraphQL property search",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/property-run-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Execute Agoda property scraping job
 *     description: |
 *       Executes a scraping job for an Agoda property within the specified date range.
 *       This endpoint performs the following operations:
 *
 *       1. **Job Validation**: Validates that the job exists and is in a runnable state
 *       2. **Credential Retrieval**: Gets Agoda credentials and property ID from the job
 *       3. **Authentication**: Uses email-based sign-in link authentication with Agoda
 *       4. **Data Extraction**: Scrapes reservation and payment data from Agoda
 *       5. **Progress Tracking**: Monitors and logs job progress with detailed statistics
 *       6. **Resource Management**: Manages browser resources and worker thread assignments
 *       7. **Error Handling**: Comprehensive error handling with email notifications
 *       8. **Log Management**: Uploads detailed logs to S3 storage
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *               - jobId
 *             properties:
 *               startDate:
 *                 type: string
 *                 format: date
 *                 example: "01/01/2025"
 *                 description: Start date for scraping (MM/DD/YYYY format)
 *               endDate:
 *                 type: string
 *                 format: date
 *                 example: "01/31/2025"
 *                 description: End date for scraping (MM/DD/YYYY format)
 *               jobId:
 *                 type: string
 *                 example: "6892f4bf9df8bc296bdcdff0"
 *                 description: MongoDB ObjectId of the job to execute
 *     responses:
 *       200:
 *         description: Job completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Agoda property scraping completed successfully"
 *                 agodaId:
 *                   type: string
 *                   example: "123456"
 *                 jobId:
 *                   type: string
 *                   example: "507f1f77bcf86cd799439011"
 *                 progress:
 *                   type: object
 *                   properties:
 *                     totalItems:
 *                       type: integer
 *                       example: 150
 *                     completionPercentage:
 *                       type: number
 *                       example: 97
 *                 finalStatus:
 *                   type: string
 *                   example: "Completed"
 *                 logInfo:
 *                   type: object
 *                   properties:
 *                     logFilePath:
 *                       type: string
 *                     logEntriesCount:
 *                       type: integer
 *                     note:
 *                       type: string
 *       400:
 *         description: Bad request - Invalid input parameters
 *       404:
 *         description: Job not found
 *       409:
 *         description: Job not in runnable state
 *       500:
 *         description: Internal server error
 */
app.post("/api/agoda/property-run-job", (async (
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

    // 2. Get agoda_id from job's property and credentials
    console.log(`Getting agoda_id for job ${jobId}...`);
    const propertyData = await jobService.getAgodaIdFromJob(jobId);
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!propertyData || !propertyData.agodaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid agoda_id for job ${jobId}. Property may not have agoda_id assigned or agoda_id is "0".`,
      });
    }

    if (
      !propertyCredentials?.agodaUsername ||
      !propertyCredentials?.agodaPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}. Property may not have agodaUsername or agodaPassword assigned.`,
      });
    }

    const { agodaId } = propertyData;
    const { agodaUsername, agodaPassword } = propertyCredentials;

    console.log(`Using agoda_id: ${agodaId} for scraping`);

    // Generate Bright Data isolation config for this job
    const brightDataSessionId = getBrightDataSessionId(jobId);
    const windowSize = getWindowSize(jobId);
    const timezone = getTimezone(jobId);
    const acceptLanguage = getAcceptLanguage(jobId);

    console.log(
      `Job ${jobId}: brightDataSessionId=${brightDataSessionId}, windowSize=${windowSize.width}x${windowSize.height}, timezone=${timezone}, acceptLanguage=${acceptLanguage}`
    );

    // 3. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: "agoda-property-run",
      jobId,
      startDate,
      endDate,
      agodaId,
      agodaUsername,
      agodaPassword,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    };

    // 4. Execute job in worker thread
    try {
      console.log(`Submitting Agoda job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Agoda job execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Agoda Worker error for job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Agoda Worker execution failed",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/agoda/property-run-job:", err);

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
      message: "Error processing Agoda property search",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/bulk-property-run-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Bulk start Agoda property scraping jobs
 *     description: |
 *       Starts multiple Agoda property scraping jobs asynchronously.
 *       If OTP is available, runs the first job and queues the rest.
 *       If OTP is occupied, queues all jobs.
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
 *                 description: Array of job IDs to process
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *               scheduler_id:
 *                 type: string
 *                 description: Optional scheduler ID to update with invalid job IDs
 *                 example: "507f1f77bcf86cd799439013"
 *     responses:
 *       200:
 *         description: Jobs processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Processed 5 jobs. 3 submitted, 1 invalid, 1 with errors."
 *                 results:
 *                   type: object
 *                   properties:
 *                     submitted:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           status:
 *                             type: string
 *                     invalid:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                           currentStatus:
 *                             type: string
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           error:
 *                             type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/agoda/bulk-property-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids, scheduler_id } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    // Validate all jobs
    const validationResults = await Promise.all(
      job_ids.map(async (jobId: string) => ({
        jobId,
        validation: await jobService.validateJob(jobId),
      }))
    );

    // Separate valid and invalid jobs
    const validJobs = validationResults.filter(
      (result) => result.validation.exists && result.validation.canRun
    );
    const invalidJobs = validationResults.filter(
      (result) => !result.validation.exists || !result.validation.canRun
    );

    // Get job data for valid jobs (including dates from job document)
    const jobsData = await Promise.all(
      validJobs.map(async (result) => {
        try {
          // Get full job document to extract dates
          const job = await jobService.getJobById(result.jobId);
          if (!job) {
            return {
              jobId: result.jobId,
              error: `Job ${result.jobId} not found`,
            };
          }

          // Extract startDate and endDate from job document
          // Assuming these are stored as properties on the job (even if not in schema)
          const startDate =  (job as any).start_date;
          const endDate =  (job as any).end_date;

          if (!startDate || !endDate) {
            return {
              jobId: result.jobId,
              error: `Job ${result.jobId} does not have startDate and endDate assigned`,
            };
          }

          const propertyData = await jobService.getAgodaIdFromJob(result.jobId);
          const propertyCredentials =
            await propertyCredentialsService.getCredentialsByJobId(
              result.jobId
            );

          if (!propertyData || !propertyData.agodaId) {
            return {
              jobId: result.jobId,
              error: `Cannot retrieve valid agoda_id for job ${result.jobId}. Property may not have agoda_id assigned or agoda_id is "0".`,
            };
          }

          if (
            !propertyCredentials?.agodaUsername ||
            !propertyCredentials?.agodaPassword
          ) {
            return {
              jobId: result.jobId,
              error: `Cannot retrieve valid agodaUsername or agodaPassword for job ${result.jobId}. Property may not have agodaUsername or agodaPassword assigned.`,
            };
          }

          return {
            jobId: result.jobId,
            startDate,
            endDate,
            propertyData,
            propertyCredentials,
          };
        } catch (error: any) {
          return {
            jobId: result.jobId,
            error: error.message || String(error),
          };
        }
      })
    );

    // Separate jobs with data and jobs with errors
    const validJobsData = jobsData.filter((job) => {
      return (
        "propertyData" in job &&
        "propertyCredentials" in job &&
        "startDate" in job &&
        "endDate" in job &&
        !("error" in job)
      );
    }) as Array<{
      jobId: string;
      startDate: string;
      endDate: string;
      propertyData: { agodaId: string };
      propertyCredentials: { agodaUsername: string; agodaPassword: string };
    }>;
    const jobsWithErrors = jobsData.filter(
      (job): job is { jobId: string; error: string } => "error" in job
    );

    // Build results
    const results: {
      submitted: Array<{ jobId: string; status: string }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = { submitted: [], invalid: [], errors: [] };

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
        results.errors.push({ jobId: job.jobId, error: job.error });
      }
    });

    // Submit valid jobs without awaiting - they run in the background
    validJobsData.forEach((job) => {
      const agodaId = job.propertyData?.agodaId;
      const agodaUsername = job.propertyCredentials?.agodaUsername;
      const agodaPassword = job.propertyCredentials?.agodaPassword;
      const startDate = job.startDate;
      const endDate = job.endDate;

      if (
        !agodaId ||
        !agodaUsername ||
        !agodaPassword ||
        !startDate ||
        !endDate
      ) {
        console.error(
          `Missing required data for job ${job.jobId}, skipping submission`
        );
        return;
      }

      // Generate Bright Data isolation config for this job
      const brightDataSessionId = getBrightDataSessionId(job.jobId);
      const windowSize = getWindowSize(job.jobId);
      const timezone = getTimezone(job.jobId);
      const acceptLanguage = getAcceptLanguage(job.jobId);

      const workerJobData: WorkerJobData = {
        jobType: "agoda-property-run",
        jobId: job.jobId,
        startDate,
        endDate,
        agodaId,
        agodaUsername,
        agodaPassword,
        brightDataSessionId,
        windowSize,
        timezone,
        acceptLanguage,
      };

      // executeJob will automatically:
      // - Run immediately if OTP and worker available
      // - Queue and set InQueue status if OTP occupied or no worker available
      // Fire and forget - don't wait for completion
      otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
        console.error(`Error submitting Agoda job ${job.jobId}:`, error);
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
          const scheduledJob = await ScheduledJob.findById(scheduler_id);
          if (scheduledJob) {
            const invalidJobIdsStr = invalidJobIds.join(", ");
            const commentPrefix = scheduledJob.comment
              ? `${scheduledJob.comment}\n`
              : "";
            const newComment = `${commentPrefix}Invalid job IDs: ${invalidJobIdsStr}`;

            await ScheduledJob.findByIdAndUpdate(scheduler_id, {
              comment: newComment,
            });
          } else {
            console.warn(
              `ScheduledJob with ID ${scheduler_id} not found, skipping comment update`
            );
          }
        }
      } catch (schedulerError) {
        console.error(`Error updating scheduled job comment:`, schedulerError);
        // Don't fail the request if scheduler update fails
      }
    }

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${results.submitted.length} submitted, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results,
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/bulk-property-run-job:", err);
    res.status(500).json({
      status: 500,
      message: "Error processing bulk Agoda property run jobs",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/support-email-run-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Capture the latest Agoda Partner Support reply and record how it answered
 *     description: |
 *       Fetches the email, deduplicates it, stores it, and sets the job's
 *       `reply_status`. It takes no action on the contents — reopening a case is
 *       `POST /api/agoda/reopen-case-run-job`, and creating retrievals is
 *       `POST /api/agoda/send-to-retrieval`.
 *
 *       `reply_status` is judged from the newest Partner Support reply:
 *
 *       - `RepliedGreen` — Agoda replied and nothing needs reopening, so the balance
 *         is collectable.
 *       - `RepliedRed` — Agoda replied and at least one booking needs the case
 *         reopened.
 *       - `NoReplied` — nothing came back for this run. Whether that is merely early
 *         or actually late is told by `reply_deadline_at`, which every completed
 *         property run sets to its finish time plus 48 hours.
 *
 *       Completing a property run also resets `reply_status` to `NoReplied`, so a
 *       rerun never inherits the previous run's verdict.
 *
 *       For every job ID the property's `agoda_id` is resolved, Gmail is searched for
 *       messages mentioning that Agoda ID, and the newest match is inspected.
 *
 *       Only jobs whose `job_status` is `Completed` are considered — a case only
 *       exists once the property run has finished, so a job in any other status is
 *       reported under `invalid` and no Gmail search is made for it.
 *
 *       The search starts at the job's `updatedAt` rather than a fixed window, so a
 *       run reports what has arrived since the job was last touched. Because writing
 *       `case_status` moves `updatedAt` forward, a message an earlier run already
 *       acted on falls outside the window on the next call.
 *
 *       The message is only parsed when it was sent by `PartnerSupport@agoda.com`.
 *       Parsing extracts the Case ID, property details and the listed reservation IDs,
 *       and downloads any CSV / XLSX attachment into rows.
 *
 *       Attachments are downloaded, parsed into columns and rows, and the original
 *       files archived to S3. The reopen rules run over them only to tell red from
 *       green; nothing is queued or created as a result.
 *
 *       Every parsed email is saved to the `support_emails` collection — subject,
 *       body text, headers, timestamps, and each attachment's columns and S3 link.
 *       Gmail's `message_id` is the deduplication key, so a message seen again is
 *       not stored twice. Each parsed result carries a `storage` object with
 *       `stored`, `duplicate` and `recordId`.
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
 *                 description: Array of job IDs to look up support emails for
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *     responses:
 *       200:
 *         description: Support emails processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Processed 2 jobs. 1 support email(s) captured (1 newly stored, 0 already on record), 2 further conversation message(s) captured, 1 RepliedGreen, 0 RepliedRed, 1 without a Partner Support reply, 0 invalid, 0 with errors."
 *                 results:
 *                   type: object
 *                   properties:
 *                     processed:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           agodaId:
 *                             type: string
 *                           outcome:
 *                             type: object
 *                             description: |
 *                               `status` is one of `parsed`, `not_from_partner_support`
 *                               or `no_email_found`. When `parsed`, an `email` object
 *                               carries the headers, parsed body, attachments and a
 *                               `reopen` summary with `shouldReopen`,
 *                               `reopenBookingIds`, `collectBookingIds` and
 *                               `s3Url`, `s3Key` and `uploadError`. Each attachment also carries
 *                               its own `reopenDecision` with the `collect`, `reopen`
 *                               and `skipped` rows.
 *                     invalid:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                           currentStatus:
 *                             type: string
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           error:
 *                             type: string
 *                     replyStatuses:
 *                       type: array
 *                       description: The reply_status written to each processed job
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           replyStatus:
 *                             type: string
 *                             enum: [NoReplied, RepliedRed, RepliedGreen]
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/agoda/support-email-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    // Capture and classify: fetch, deduplicate, store, and record how Agoda
    // answered on the job. Acting on that answer belongs to
    // /api/agoda/reopen-case-run-job and /api/agoda/send-to-retrieval.
    const results = await scrapeSupportEmailsForJobs(job_ids);

    const replyStatuses: Array<{ jobId: string; replyStatus: ReplyStatus }> = [];

    for (const result of results.processed) {
      // Anything other than a parsed Partner Support reply means Agoda has not
      // answered this run yet; reply_deadline_at is what says whether that is
      // now overdue.
      const replyStatus =
        result.outcome.status !== "parsed"
          ? ReplyStatus.NoReplied
          : result.outcome.email.reopen.shouldReopen &&
              result.outcome.email.reopen.reopenBookingIds.length > 0
            ? ReplyStatus.RepliedRed
            : ReplyStatus.RepliedGreen;

      await jobService.updateJobReplyStatus(result.jobId, replyStatus);
      replyStatuses.push({ jobId: result.jobId, replyStatus });
    }

    const parsed = results.processed.filter(
      (result) => result.outcome.status === "parsed"
    );
    const withoutReply = results.processed.length - parsed.length;
    const newlyStored = parsed.filter(
      (result) =>
        result.outcome.status === "parsed" && result.outcome.storage.stored
    ).length;
    const conversationStored = parsed.reduce(
      (sum, result) =>
        result.outcome.status === "parsed"
          ? sum + result.outcome.storage.conversationStored
          : sum,
      0
    );

    const red = replyStatuses.filter(
      (entry) => entry.replyStatus === ReplyStatus.RepliedRed
    ).length;
    const green = replyStatuses.filter(
      (entry) => entry.replyStatus === ReplyStatus.RepliedGreen
    ).length;

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${parsed.length} support email(s) captured (${newlyStored} newly stored, ${parsed.length - newlyStored} already on record), ${conversationStored} further conversation message(s) captured, ${green} RepliedGreen, ${red} RepliedRed, ${withoutReply} without a Partner Support reply, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results: { ...results, replyStatuses },
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/support-email-run-job:", err);
    res.status(500).json({
      status: 500,
      message: "Error scraping Agoda support emails",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/reopen-case-run-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Ask Agoda to reopen a case for the bookings flagged by the reopen rules
 *     description: |
 *       Re-reads the latest Agoda Partner Support reply for each job and, when the
 *       reopen rules flagged at least one booking as `REOPEN`, submits an Agoda
 *       scraping run to the worker pool.
 *
 *       Only jobs whose `job_status` is `Completed` are considered — a case only
 *       exists once the property run has finished, so a job in any other status is
 *       reported under `invalid` and no Gmail search is made for it.
 *
 *       The Gmail search starts at the job's `updatedAt` rather than a fixed window,
 *       so a run only sees mail that arrived since the job was last touched. Because
 *       writing `case_status` moves `updatedAt` forward, a handled case will report
 *       no new email on the next call rather than acting on the same reply twice.
 *
 *       That run mirrors the property run — browser setup, login with OTP, then the
 *       property page — but skips the date-range booking lookup entirely and goes
 *       straight to Need Help. The flagged booking IDs are written into the request
 *       message from `src/agoda/need-help/reopen-message.txt`; no file is attached.
 *
 *       Jobs are submitted without waiting for them to finish, so the response reports
 *       submission only. Progress is tracked on the job's `case_status` field:
 *       `CaseInQueue` while it waits for a worker or the OTP, `CaseRunning` once the
 *       browser run starts, then `CaseReopen` when the Need Help request goes through
 *       or `ParserCaseReopeningFailed` if it does not. On a failure the explanation is
 *       written to `case_failed_reason`, which is cleared again on the next attempt.
 *       `job_status` is deliberately
 *       left untouched, so the result of the property run that produced the case is
 *       preserved.
 *       `case_open` is still set back to `true` on success.
 *
 *       This endpoint only ever reopens. A job whose bookings are all collectable is
 *       reported under `skipped`; turning those into retrievals is a separate,
 *       explicit call to `POST /api/agoda/send-to-retrieval`.
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
 *                 description: Array of job IDs to evaluate and, where needed, reopen
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *     responses:
 *       200:
 *         description: Jobs evaluated; those needing a reopen were submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Processed 2 jobs. 1 submitted for reopen, 1 skipped, 0 invalid, 0 with errors."
 *                 results:
 *                   type: object
 *                   properties:
 *                     submitted:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           agodaId:
 *                             type: string
 *                           caseId:
 *                             type: string
 *                             nullable: true
 *                           reopenBookingIds:
 *                             type: array
 *                             items:
 *                               type: string
 *                           status:
 *                             type: string
 *                             example: "submitted"
 *                     skipped:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           agodaId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                             example: "No booking needs the case reopened"
 *                     invalid:
 *                       type: array
 *                       description: Jobs rejected before the Gmail search, e.g. not Completed
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                             example: "Job 507f1f77bcf86cd799439011 is Failed; only Completed jobs can be reopened or sent to retrieval."
 *                           currentStatus:
 *                             type: string
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           error:
 *                             type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/agoda/reopen-case-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    const results: {
      submitted: Array<{
        jobId: string;
        agodaId: string;
        caseId: string | null;
        reopenBookingIds: string[];
        status: string;
      }>;
      skipped: Array<{ jobId: string; agodaId?: string; reason: string }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = { submitted: [], skipped: [], invalid: [], errors: [] };

    for (const jobId of job_ids) {
      try {
        const job = await jobService.getJobById(jobId);
        if (!job) {
          results.invalid.push({ jobId, reason: "Job not found" });
          continue;
        }

        // A case only exists if the property run finished, so anything else has
        // nothing to chase with Agoda yet.
        if (job.job_status !== JobStatus.Completed) {
          results.invalid.push({
            jobId,
            reason: `Job ${jobId} is ${job.job_status}; only Completed jobs can be reopened or sent to retrieval.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyData = await jobService.getAgodaIdFromJob(jobId);
        if (!propertyData?.agodaId) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve a valid agoda_id for job ${jobId}. The property may not have agoda_id assigned or it is "0".`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyCredentials =
          await propertyCredentialsService.getCredentialsByJobId(jobId);
        if (
          !propertyCredentials?.agodaUsername ||
          !propertyCredentials?.agodaPassword
        ) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const { agodaId } = propertyData;

        // Only look at mail that landed after the job was last touched, so a
        // run answers "has Agoda replied since?" rather than re-reading a
        // message an earlier run already acted on.
        const since = job.updatedAt;
        const outcome = await scrapeAgodaSupportEmail(agodaId, {
          jobId,
          propertyId: job.property_id?.toString(),
          since,
        });

        if (outcome.status === "no_email_found") {
          results.skipped.push({
            jobId,
            agodaId,
            reason: `No new Agoda email since the job was last updated (${since.toISOString()})`,
          });
          continue;
        }

        if (outcome.status === "not_from_partner_support") {
          results.skipped.push({
            jobId,
            agodaId,
            reason: `Latest email is from ${outcome.from || "an unknown sender"}, not Partner Support`,
          });
          continue;
        }

        const { reopen, body } = outcome.email;
        if (!reopen.shouldReopen || reopen.reopenBookingIds.length === 0) {
          results.skipped.push({
            jobId,
            agodaId,
            reason:
              reopen.collectBookingIds.length > 0
                ? `No booking needs the case reopened; ${reopen.collectBookingIds.length} booking(s) are collectable via POST /api/agoda/send-to-retrieval`
                : "No booking needs the case reopened",
          });
          continue;
        }

        const workerJobData: WorkerJobData = {
          jobType: "agoda-reopen-case",
          jobId,
          agodaId,
          agodaUsername: propertyCredentials.agodaUsername,
          agodaPassword: propertyCredentials.agodaPassword,
          reopenBookingIds: reopen.reopenBookingIds,
          caseId: body.caseId,
          startDate: (job as any).start_date,
          endDate: (job as any).end_date,
          brightDataSessionId: getBrightDataSessionId(jobId),
          windowSize: getWindowSize(jobId),
          timezone: getTimezone(jobId),
          acceptLanguage: getAcceptLanguage(jobId),
        };

        // Fire and forget — the pool runs it now or queues it behind the OTP.
        otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
          console.error(`Error submitting Agoda reopen job ${jobId}:`, error);
          try {
            await jobService.updateJobCaseStatus(
              jobId,
              CaseStatus.ParserCaseReopeningFailed,
              error?.message ||
                "The reopen run could not be submitted. Please try again."
            );
          } catch (statusError) {
            console.error(
              `Error updating case_status for job ${jobId}:`,
              statusError
            );
          }
        });

        results.submitted.push({
          jobId,
          agodaId,
          caseId: body.caseId,
          reopenBookingIds: reopen.reopenBookingIds,
          status: "submitted",
        });
      } catch (error: any) {
        console.error(`Error preparing reopen for job ${jobId}:`, error);
        results.errors.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${results.submitted.length} submitted for reopen, ${results.skipped.length} skipped, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results,
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/reopen-case-run-job:", err);
    res.status(500).json({
      status: 500,
      message: "Error processing Agoda reopen-case jobs",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/reopen-all-reservations-run-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Re-run Need Help for a batch of jobs without re-scraping reservations
 *     description: |
 *       Takes an array of job IDs and starts an Agoda run for each — same
 *       browser setup, login and property page as a bulk property run — but
 *       skips the date-range reservation scrape entirely. Once on the
 *       property page it goes straight to Need Help and re-attaches the CSV
 *       a previous completed run already filed (`need_help_file_url`),
 *       downloaded fresh from S3 for this attempt.
 *
 *       Only jobs that have a `need_help_file_url` on record can be submitted —
 *       that field is only ever set once a property run's Need Help step has
 *       completed successfully. Jobs currently `Running` or `InQueue` are
 *       rejected too, to avoid a second run colliding with one already
 *       in flight.
 *
 *       Jobs are submitted without waiting for them to finish — same
 *       fire-and-forget pattern as the other bulk endpoints. `job_status`
 *       moves to `InQueue` → `Running` → `Completed`/`Failed` like a normal
 *       property run, and `need_help_file_url` is refreshed only if the run
 *       reaches `Completed`.
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
 *                 description: Array of job IDs to re-run Need Help for
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *     responses:
 *       200:
 *         description: Jobs evaluated; valid ones were submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Processed 2 jobs. 1 submitted, 1 invalid, 0 with errors."
 *                 results:
 *                   type: object
 *                   properties:
 *                     submitted:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           agodaId:
 *                             type: string
 *                           status:
 *                             type: string
 *                             example: "submitted"
 *                     invalid:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                           currentStatus:
 *                             type: string
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           error:
 *                             type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/agoda/reopen-all-reservations-run-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    const results: {
      submitted: Array<{ jobId: string; agodaId: string; status: string }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = { submitted: [], invalid: [], errors: [] };

    for (const jobId of job_ids) {
      try {
        const job = await jobService.getJobById(jobId);
        if (!job) {
          results.invalid.push({ jobId, reason: "Job not found" });
          continue;
        }

        if (
          job.job_status === JobStatus.Running ||
          job.job_status === JobStatus.InQueue
        ) {
          results.invalid.push({
            jobId,
            reason: `Job ${jobId} is already ${job.job_status}.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        if (!job.need_help_file_url) {
          results.invalid.push({
            jobId,
            reason: `Job ${jobId} has no need_help_file_url on record — nothing to re-attach. A property run must complete successfully first.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyData = await jobService.getAgodaIdFromJob(jobId);
        if (!propertyData?.agodaId) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve a valid agoda_id for job ${jobId}. The property may not have agoda_id assigned or it is "0".`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyCredentials =
          await propertyCredentialsService.getCredentialsByJobId(jobId);
        if (
          !propertyCredentials?.agodaUsername ||
          !propertyCredentials?.agodaPassword
        ) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const { agodaId } = propertyData;

        const workerJobData: WorkerJobData = {
          jobType: "agoda-reopen-all-reservations",
          jobId,
          agodaId,
          agodaUsername: propertyCredentials.agodaUsername,
          agodaPassword: propertyCredentials.agodaPassword,
          needHelpFileUrl: job.need_help_file_url,
          startDate: (job as any).start_date,
          endDate: (job as any).end_date,
          brightDataSessionId: getBrightDataSessionId(jobId),
          windowSize: getWindowSize(jobId),
          timezone: getTimezone(jobId),
          acceptLanguage: getAcceptLanguage(jobId),
        };

        // Fire and forget — the pool runs it now or queues it behind the OTP.
        otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
          console.error(
            `Error submitting Agoda reopen-all-reservations job ${jobId}:`,
            error
          );
          try {
            await jobService.updateJobStatus(jobId, JobStatus.Failed);
          } catch (statusError) {
            console.error(
              `Error updating job ${jobId} status to Failed:`,
              statusError
            );
          }
        });

        results.submitted.push({
          jobId,
          agodaId,
          status: "submitted",
        });
      } catch (error: any) {
        console.error(
          `Error preparing reopen-all-reservations for job ${jobId}:`,
          error
        );
        results.errors.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${results.submitted.length} submitted, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results,
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/reopen-all-reservations-run-job:", err);
    res.status(500).json({
      status: 500,
      message: "Error processing Agoda reopen-all-reservations jobs",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/send-to-retrieval:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Turn the bookings a property can charge itself into retrievals
 *     description: |
 *       Reads the Agoda Partner Support reply already stored in `support_emails`
 *       and hands the bookings the reopen rules marked `COLLECT` to the retrieval
 *       side. Gmail is not contacted: capturing is
 *       `POST /api/agoda/support-email-run-job`'s job, and this endpoint acts on
 *       what that call stored, so both see the same reply.
 *
 *       Run the capture endpoint first. With no stored reply for the property the
 *       job is skipped rather than treated as having nothing to collect.
 *
 *       Only jobs whose `job_status` is `Completed` are considered, and the reply
 *       must have arrived after that run finished. The cutoff is derived from
 *       `reply_deadline_at` minus the 48-hour grace period rather than from
 *       `updatedAt`, which capturing the email moves past the arrival time. Jobs
 *       completed before `reply_deadline_at` existed have no cutoff, so their
 *       newest stored reply is used.
 *
 *       A job is only sent when nothing on it still needs reopening. If the reply
 *       flags even one booking as `REOPEN` the job is skipped, because the case is
 *       not settled yet — reopen it first, then call this once Agoda has answered.
 *
 *       The call writes one `parent_retrievals` document covering the whole request
 *       and one `retrievals` document per property beneath it, with the collectable
 *       booking IDs in `reservations[]`. Reservation-level `retrieval_items` are not
 *       created; the retrieval run fills those in itself.
 *
 *       Once a job's retrieval is written its `case_status` becomes `CaseClose`,
 *       since nothing on the case is waiting on Agoda any more. A job whose retrieval
 *       could not be written keeps its current `case_status`, so a later call can
 *       retry it. No browser run is involved, so this responds once the writes are
 *       done rather than queueing work.
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
 *                 description: Array of job IDs whose collectable bookings should become retrievals
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *     responses:
 *       200:
 *         description: Jobs evaluated and retrievals written
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Processed 2 jobs. 1 retrieval(s) created covering 3 booking(s), 1 skipped, 0 invalid, 0 with errors."
 *                 results:
 *                   type: object
 *                   properties:
 *                     skipped:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           agodaId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                             example: "2 booking(s) still need the case reopened"
 *                     invalid:
 *                       type: array
 *                       description: Jobs rejected before the stored reply was read, e.g. not Completed
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           reason:
 *                             type: string
 *                           currentStatus:
 *                             type: string
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           jobId:
 *                             type: string
 *                           error:
 *                             type: string
 *                     retrieval:
 *                       type: object
 *                       properties:
 *                         parentRetrievalId:
 *                           type: string
 *                           nullable: true
 *                           description: Null when no job had collectable bookings
 *                         parentRetrievalName:
 *                           type: string
 *                           nullable: true
 *                           example: "Agoda Collect 2026-09-01 06:12 UTC"
 *                         created:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               jobId:
 *                                 type: string
 *                               agodaId:
 *                                 type: string
 *                               retrievalId:
 *                                 type: string
 *                               reservationCount:
 *                                 type: integer
 *                         failed:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               jobId:
 *                                 type: string
 *                               error:
 *                                 type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/agoda/send-to-retrieval", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { job_ids } = req.body;

    if (!job_ids || !Array.isArray(job_ids) || job_ids.length === 0) {
      return res.status(400).json({
        status: 400,
        message: "job_ids array is required and must not be empty",
      });
    }

    const results: {
      skipped: Array<{ jobId: string; agodaId?: string; reason: string }>;
      invalid: Array<{ jobId: string; reason: string; currentStatus?: string }>;
      errors: Array<{ jobId: string; error: string }>;
    } = { skipped: [], invalid: [], errors: [] };

    // Gathered across the loop so the whole call shares one parent retrieval.
    const collectCandidates: CollectRetrievalInput[] = [];

    for (const jobId of job_ids) {
      try {
        const job = await jobService.getJobById(jobId);
        if (!job) {
          results.invalid.push({ jobId, reason: "Job not found" });
          continue;
        }

        if (job.job_status !== JobStatus.Completed) {
          results.invalid.push({
            jobId,
            reason: `Job ${jobId} is ${job.job_status}; only Completed jobs can be sent to retrieval.`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const propertyData = await jobService.getAgodaIdFromJob(jobId);
        if (!propertyData?.agodaId) {
          results.invalid.push({
            jobId,
            reason: `Cannot retrieve a valid agoda_id for job ${jobId}. The property may not have agoda_id assigned or it is "0".`,
            currentStatus: job.job_status,
          });
          continue;
        }

        const { agodaId } = propertyData;

        // `updatedAt` is no use as the cutoff here: capturing the email writes
        // reply_status back to the job and pushes it past the email's arrival.
        // The completion time behind reply_deadline_at is not moved by those
        // writes, so it still marks the run this reply has to be answering.
        const runCompletedAt = job.reply_deadline_at
          ? new Date(
              job.reply_deadline_at.getTime() -
                REPLY_DEADLINE_HOURS * 60 * 60 * 1000
            )
          : null;

        const email = await supportEmailService.findLatestPartnerSupportReply(
          agodaId,
          { since: runCompletedAt }
        );

        if (!email) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: runCompletedAt
              ? `No stored Agoda reply that arrived after the run finished (${runCompletedAt.toISOString()}). Capture it with POST /api/agoda/support-email-run-job first.`
              : "No stored Agoda reply for this property. Capture it with POST /api/agoda/support-email-run-job first.",
          });
          continue;
        }

        // The case has to be settled with Agoda before the balance can be
        // treated as collectable, so anything still needing a reopen waits.
        if (email.should_reopen && email.reopen_booking_ids.length > 0) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: `${email.reopen_booking_ids.length} booking(s) still need the case reopened`,
          });
          continue;
        }

        if (email.collect_booking_ids.length === 0) {
          results.skipped.push({
            jobId,
            agodaId,
            reason: "No collectable booking in the stored reply",
          });
          continue;
        }

        collectCandidates.push({
          job,
          agodaId,
          reservations: email.collect_booking_ids,
        });
      } catch (error: any) {
        console.error(`Error preparing retrieval for job ${jobId}:`, error);
        results.errors.push({
          jobId,
          error: error?.message || String(error),
        });
      }
    }

    const retrieval = await retrievalService.createCollectRetrievals(
      collectCandidates
    );

    // Handing the balance to the retrieval side leaves nothing waiting on
    // Agoda, so the case is done. Jobs whose retrieval failed keep their
    // current case_status so the next call can pick them up again.
    for (const created of retrieval.created) {
      try {
        await jobService.updateJobCaseStatus(
          created.jobId,
          CaseStatus.CaseClose
        );
      } catch (error) {
        console.error(
          `Error setting case_status to CaseClose for job ${created.jobId}:`,
          error
        );
      }
    }

    const bookingsSent = retrieval.created.reduce(
      (sum, entry) => sum + entry.reservationCount,
      0
    );

    return res.status(200).json({
      status: 200,
      message: `Processed ${job_ids.length} jobs. ${retrieval.created.length} retrieval(s) created covering ${bookingsSent} booking(s), ${results.skipped.length} skipped, ${results.invalid.length} invalid, ${results.errors.length} with errors.`,
      results: { ...results, retrieval },
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/send-to-retrieval:", err);
    res.status(500).json({
      status: 500,
      message: "Error sending Agoda bookings to retrieval",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/agoda/rerun-failed-job:
 *   post:
 *     tags:
 *       - Agoda Scraping
 *     summary: Rerun failed or partial Agoda job
 *     description: |
 *       Reruns a failed or partial Agoda scraping job. This endpoint resets the job status
 *       and attempts to complete the scraping process from where it left off.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jobId
 *             properties:
 *               jobId:
 *                 type: string
 *                 example: "6892f4bf9df8bc296bdcdff0"
 *                 description: MongoDB ObjectId of the job to rerun
 *               startDate:
 *                 type: string
 *                 format: date
 *                 example: "01/01/2025"
 *                 description: Optional start date override (MM/DD/YYYY format)
 *               endDate:
 *                 type: string
 *                 format: date
 *                 example: "01/31/2025"
 *                 description: Optional end date override (MM/DD/YYYY format)
 *     responses:
 *       200:
 *         description: Job rerun completed successfully
 *       400:
 *         description: Bad request
 *       404:
 *         description: Job not found
 *       500:
 *         description: Internal server error
 */
app.post("/api/agoda/rerun-failed-job", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId, startDate, endDate } = req.body;

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

    // Validate job exists
    const validation = await jobService.validateJob(jobId);
    if (!validation.exists) {
      return res.status(404).json({
        status: 404,
        message: `Job with ID ${jobId} not found`,
      });
    }

    const job = validation.job;
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: `Job ${jobId} data not found`,
      });
    }

    // Store original status for logging
    const originalStatus = job.job_status;

    console.log(
      `Rerunning failed/partial Agoda job ${jobId} with original status: ${originalStatus}`
    );

    // Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: "agoda-rerun-failed",
      jobId,
      startDate,
      endDate,
      originalStatus,
    };

    // Execute job in worker thread
    try {
      console.log(`Submitting Agoda rerun job ${jobId} to worker pool...`);

      const result = await otpAwareWorkerPool.executeJob(workerJobData);

      if (result.success) {
        return res.status(200).json(result.data);
      } else {
        return res.status(500).json({
          status: 500,
          message: "Agoda job rerun execution failed",
          error: result.error,
          jobId: result.jobId,
        });
      }
    } catch (workerError) {
      console.error(`Agoda rerun worker error for job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Agoda rerun worker execution failed",
        error:
          workerError instanceof Error
            ? workerError.message
            : String(workerError),
        jobId,
      });
    }
  } catch (err: any) {
    console.error("Error in /api/agoda/rerun-failed-job:", err);

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
      message: "Error processing Agoda job rerun",
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
