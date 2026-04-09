import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import createError from "../common/error.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { brightDataFieldsForExpediaJob } from "../common/job-isolation.js";
import { WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { JobStatus } from "../models/job.model.js";
import { ScheduledJob } from "../models/scheduled-job.model.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import {
  getFailedReasonForUser,
  jobService,
} from "../services/job.service.js";

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
      messge: "Connection established on graphql-agoda-thread branch",
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
        ...brightDataFieldsForExpediaJob(jobId),
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
        ...brightDataFieldsForExpediaJob(jobId),
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
      ...brightDataFieldsForExpediaJob(jobId),
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
 *                     job_items_file_link:
 *                       type: string
 *                       description: URL of exported job_items XLSX when available
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
 *                     job_items_file_link:
 *                       type: string
 *                       description: URL of exported job_items XLSX (e.g. Google Drive)
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

/**
 * @swagger
 * /api/jobs/{jobId}/job-items-file:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job items export file link
 *     description: URL for the XLSX export of job_items (e.g. Google Drive) after a completed job
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Link retrieved successfully
 *       404:
 *         description: Job not found or no export link yet
 */
app.get("/api/jobs/:jobId/job-items-file", (async (
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
      ...brightDataFieldsForExpediaJob(jobId),
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
 * /api/expedia/bulk-property-run-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Bulk start property scraping jobs
 *     description: |
 *       Starts multiple property scraping jobs for the specified date range.
 *       If OTP is available, runs the first job immediately and queues the rest.
 *       If OTP is occupied, queues all jobs.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *               - job_ids
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
 *               job_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["6892f4bf9df8bc296bdcdff0", "6892f4bf9df8bc296bdcdff1"]
 *                 description: Array of job IDs to process
 *               scheduler_id:
 *                 type: string
 *                 example: "6892f4bf9df8bc296bdcdff2"
 *                 description: Optional scheduler ID. If provided, invalid job IDs will be added to the scheduler's comment field
 *     responses:
 *       200:
 *         description: Jobs processed successfully
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
 *                     runImmediately:
 *                       type: array
 *                       items:
 *                         type: object
 *                     queued:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Error processing batch jobs
 */
app.post("/api/expedia/bulk-property-run-job", (async (
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
          const jobData = await jobService.getExpediaIdFromJob(jobId);
          if (!jobData || !jobData.expediaId) {
            return {
              jobId,
              error: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
            };
          }
          if (!jobData.user_email || !jobData.user_password) {
            return {
              jobId,
              error: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
            };
          }
          // Get full job document to extract dates
          const job = await jobService.getJobById(jobId);
          if (!job) {
            return {
              jobId,
              error: `Job ${jobId} not found`,
            };
          }

          // Extract start_date and end_date from job document
          const startDate = (job as any).start_date;
          const endDate = (job as any).end_date;

          if (!startDate || !endDate) {
            return {
              jobId,
              error: `Job ${jobId} does not have start_date and end_date assigned`,
            };
          }

          return { jobId, jobData, startDate, endDate };
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
        startDate: string;
        endDate: string;
      } => !("error" in j) && "startDate" in j && "endDate" in j
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
      const workerJobData: WorkerJobData = {
        jobType: "property-run",
        jobId: job.jobId,
        startDate: job.startDate,
        endDate: job.endDate,
        expediaId: job.jobData.expediaId,
        user_email: job.jobData.user_email,
        user_password: job.jobData.user_password,
        ...brightDataFieldsForExpediaJob(job.jobId),
      };

      // executeJob will automatically:
      // - Run immediately if OTP and worker available
      // - Queue and set InQueue status if OTP occupied or no worker available
      // Fire and forget - don't wait for completion
      otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
        console.error(`Error submitting job ${job.jobId}:`, error);
        // Update job status to Failed if submission fails
        const failedReason = getFailedReasonForUser(
          error,
          "Job submission failed"
        );
        try {
          await jobService.updateJobStatus(
            job.jobId,
            JobStatus.Failed,
            failedReason
          );
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
    console.error("Error in /api/expedia/bulk-property-run-job:", err);

    res.status(500).json({
      status: 500,
      message: "Error processing bulk property run jobs",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/expedia/bulk-graphql-run-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Bulk start GraphQL scraping jobs
 *     description: |
 *       Starts multiple GraphQL scraping jobs. start_date and end_date are taken from each job.
 *       If OTP is available, runs the first job immediately and queues the rest.
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
 *                 example: ["6892f4bf9df8bc296bdcdff0", "6892f4bf9df8bc296bdcdff1"]
 *                 description: Array of job IDs to process (start_date and end_date will be taken from each job)
 *               scheduler_id:
 *                 type: string
 *                 example: "6892f4bf9df8bc296bdcdff2"
 *                 description: Optional scheduler ID. If provided, invalid job IDs will be added to the scheduler's comment field
 *     responses:
 *       200:
 *         description: Jobs processed successfully
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
 *                     runImmediately:
 *                       type: array
 *                       items:
 *                         type: object
 *                     queued:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Error processing batch jobs
 */
app.post("/api/expedia/bulk-graphql-run-job", (async (
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

    // Get job data for valid jobs only (including dates from job document)
    const jobsData = await Promise.all(
      validJobs.map(async ({ jobId }) => {
        try {
          // Get full job document to extract dates
          const job = await jobService.getJobById(jobId);
          if (!job) {
            return {
              jobId,
              error: `Job ${jobId} not found`,
            };
          }

          // Extract start_date and end_date from job document
          const startDate = (job as any).start_date;
          const endDate = (job as any).end_date;

          if (!startDate || !endDate) {
            return {
              jobId,
              error: `Job ${jobId} does not have start_date and end_date assigned`,
            };
          }

          const jobData = await jobService.getExpediaIdFromJob(jobId);
          if (!jobData || !jobData.expediaId) {
            return {
              jobId,
              error: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
            };
          }
          if (!jobData.user_email || !jobData.user_password) {
            return {
              jobId,
              error: `Cannot retrieve valid user_email or user_password for job ${jobId}. Property may not have user_email or user_password assigned.`,
            };
          }
          return {
            jobId,
            jobData,
            startDate,
            endDate,
          };
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
        startDate: string;
        endDate: string;
      } => !("error" in j) && "startDate" in j && "endDate" in j
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
      const workerJobData: WorkerJobData = {
        jobType: "graphql-run",
        jobId: job.jobId,
        startDate: job.startDate,
        endDate: job.endDate,
        expediaId: job.jobData.expediaId,
        user_email: job.jobData.user_email,
        user_password: job.jobData.user_password,
        ...brightDataFieldsForExpediaJob(job.jobId),
      };

      // executeJob will automatically:
      // - Run immediately if OTP and worker available
      // - Queue and set InQueue status if OTP occupied or no worker available
      // Fire and forget - don't wait for completion
      otpAwareWorkerPool.executeJob(workerJobData).catch(async (error) => {
        console.error(`Error submitting GraphQL job ${job.jobId}:`, error);
        // Update job status to Failed if submission fails
        const rawMsg = (error as any)?.message;
        const failedReason =
          typeof rawMsg === "string" && rawMsg.trim()
            ? rawMsg
            : "GraphQL job submission failed";
        try {
          await jobService.updateJobStatus(
            job.jobId,
            JobStatus.Failed,
            failedReason
          );
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
    console.error("Error in /api/expedia/bulk-graphql-run-job:", err);

    res.status(500).json({
      status: 500,
      message: "Error processing bulk GraphQL run jobs",
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
