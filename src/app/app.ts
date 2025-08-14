import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import createError from "../common/error.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  getCurrentJobLogger,
  initializeJobLogging,
} from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import graphqlScraping from "../graphql-backup.js";
import main from "../main.js";
import { JobStatus } from "../models/job.model.js";
import reservation from "../reservation/reservation.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobQueueUrlService } from "../services/job-queue-url.service.js";
import { jobService } from "../services/job.service.js";

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
    res
      .status(200)
      .json({ messge: "Connection established on graphql branch" });
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
 *     summary: Resume paused scraping job
 *     description: Resume a previously paused scraping job from where it left off
 *     responses:
 *       200:
 *         description: Scraping resumed successfully
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
 *                   example: "Scraping resumed successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       400:
 *         description: Cannot resume scraping - no paused job found
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
 *                   example: "Cannot resume scraping - no paused scraping job found"
 *       500:
 *         description: Error resuming scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/scraping/stop:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Stop current scraping job
 *     description: Completely stop the current scraping job. This cannot be resumed and will require starting a new job.
 *     responses:
 *       200:
 *         description: Scraping stopped successfully
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
 *                   example: "Scraping stopped successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error stopping scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/expedia/rerun-failed-job:
 *   post:
 *     tags:
 *       - Scraping Jobs
 *     summary: Rerun failed or partial failed job
 *     description: Rerun a job that has failed or partially completed. This endpoint specifically handles jobs with Failed or Partial status and resets them to run again.
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
 *                 description: MongoDB ObjectId of the failed/partial job to rerun
 *                 example: "507f1f77bcf86cd799439011"
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
    const { startDate, endDate, jobId } = req.body;

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

    // 4. Get expedia_id and credentials from job's property
    console.log(`Getting expedia_id for job ${jobId}...`);
    const jobData = await jobService.getExpediaIdFromJob(jobId);
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!jobData || !jobData.expediaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
      });
    }

    if (
      !propertyCredentials?.expediaUsername ||
      !propertyCredentials?.expediaPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expediaUsername or expediaPassword for job ${jobId}. Property may not have expediaUsername or expediaPassword assigned.`,
      });
    }

    const { expediaId } = jobData;
    const { expediaUsername, expediaPassword } = propertyCredentials;

    console.log(
      `Rerunning failed/partial job ${jobId} with expedia_id: ${expediaId}`
    );

    // 5. Reset job status to Pending, then to Running
    console.log(
      `Resetting job ${jobId} status from ${originalStatus} to Pending...`
    );
    await jobService.updateJobStatus(jobId, JobStatus.Pending);

    console.log(`Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 6. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Starting job rerun for ${jobId}`, {
      jobId,
      originalStatus,
      expediaId,
      startDate,
      endDate,
    });

    // 7. Start legacy state manager (for existing pause/resume functionality)
    scrapingStateManager.startScraping(expediaId, jobId, startDate, endDate);

    try {
      // 8. Run the main scraping function with expedia_id
      await main(
        expediaId,
        startDate,
        endDate,
        jobId,
        expediaUsername,
        expediaPassword
      );

      // 9. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 10. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 11. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 12. Change URL status back to Available (URL assigned by another project)
      await jobQueueUrlService.handleJobCompletion(jobId, finalStatus);

      // 13. Stop legacy state manager
      scrapingStateManager.stopScraping();

      // Get log file information if available
      const logger = getCurrentJobLogger();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : undefined;

      console.log(`✅ Job ${jobId} rerun completed successfully`);

      return res.status(200).json({
        status: 200,
        message: `${originalStatus} job rerun completed successfully`,
        jobId,
        originalStatus,
        finalStatus,
        progress,
        logInfo,
      });
    } catch (error: any) {
      console.error(`❌ Error during job ${jobId} rerun:`, error);
      await dualLogError(`Job ${jobId} rerun failed`, error, { jobId });

      // Update job status to Failed
      await progressManager.handleJobError(jobId, error);

      // Release URL back to Available status on error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        error?.message || "Unknown error"
      );

      // Stop legacy state manager
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status (this ensures log upload even on error)
      await finalizeJobLogging("failed");

      throw error;
    }
  } catch (err: any) {
    console.error("Error in rerun-failed-job API:", err);

    // Try to finalize logging if a jobId was provided and logging was initialized
    try {
      if (req.body.jobId) {
        await dualLogError(`Rerun failed job ${req.body.jobId} error`, err, {
          jobId: req.body.jobId,
        });

        // Release URL back to Available status on outer error
        await jobQueueUrlService.handleJobCompletion(
          req.body.jobId,
          "Failed",
          err?.message || "Unknown error"
        );

        await finalizeJobLogging("failed");
      }
    } catch (logError) {
      console.error("Error finalizing logging:", logError);
    }

    res.status(500).json({
      status: 500,
      message: "Error processing job rerun",
      error: err.message,
    });
  }
}) as express.RequestHandler);

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
app.post("/api/expedia/propertys-run-job", (async (
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
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!jobData || !jobData.expediaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
      });
    }

    if (
      !propertyCredentials?.expediaUsername ||
      !propertyCredentials?.expediaPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expediaUsername or expediaPassword for job ${jobId}. Property may not have expediaUsername or expediaPassword assigned.`,
      });
    }

    const { expediaId } = jobData;
    const { expediaUsername, expediaPassword } = propertyCredentials;

    console.log(`Using expedia_id: ${expediaId} for scraping`);

    // 3. Check if scraping is already running (legacy state manager check)
    // if (scrapingStateManager.isRunning()) {
    //   return res.status(409).json({
    //     status: 409,
    //     message: "Another scraping job is already running",
    //     currentState: scrapingStateManager.getState(),
    //   });
    // }

    // 4. Update job status to Running
    console.log(`Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 5. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Starting property scraping job ${jobId}`, {
      jobId,
      expediaId,
      startDate,
      endDate,
    });

    // 6. Start legacy state manager (for existing pause/resume functionality)
    scrapingStateManager.startScraping(expediaId, jobId, startDate, endDate);

    try {
      // 7. Run the main scraping function with expedia_id
      await main(
        expediaId,
        startDate,
        endDate,
        jobId,
        expediaUsername,
        expediaPassword
      );

      // 8. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 9. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 10. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 11. Change URL status back to Available (URL assigned by another project)
      await jobQueueUrlService.handleJobCompletion(jobId, finalStatus);

      // 12. Stop legacy state manager
      scrapingStateManager.stopScraping();

      // Get log file information if available
      const logger = getCurrentJobLogger();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : null;

      res.status(200).json({
        status: 200,
        message: `Property scraping ${finalStatus.toLowerCase()} successfully`,
        expediaId: expediaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      });
    } catch (scrapingError: any) {
      // Mark job as failed on scraping error
      await dualLogError(`Job ${jobId} failed`, scrapingError, { jobId });

      // Send email notification for scraping errorawait progressManager.handleJobError(jobId, scrapingError);

      // Release URL back to Available status on error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        scrapingError?.message || "Unknown error"
      );

      scrapingStateManager.stopScraping();

      // Finalize logging with failed status (this ensures log upload even on error)
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/property-run-job:", err);

    // Send email notification for API error// Ensure job is marked as failed and state manager is stopped
    try {
      if (req.body.jobId) {
        await dualLogError(`Property run job ${req.body.jobId} failed`, err, {
          jobId: req.body.jobId,
        });
        await progressManager.handleJobError(req.body.jobId, err);

        // Release URL back to Available status on outer error
        await jobQueueUrlService.handleJobCompletion(
          req.body.jobId,
          "Failed",
          err.message
        );

        // Finalize logging to ensure log upload even if error occurs early
        await finalizeJobLogging("failed");
      }
      scrapingStateManager.stopScraping();
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

    // Check if scraping is already running
    // if (scrapingStateManager.isRunning()) {
    //   return res.status(409).json({
    //     status: 409,
    //     message: "Scraping job is already running",
    //     currentState: scrapingStateManager.getState(),
    //   });
    // }

    // Generate job ID and start scraping state for reservations
    const jobId = `reservation_job_${Date.now()}`;

    // Initialize job logging for reservation job
    initializeJobLogging(jobId);
    await dualLogInfo(`Starting reservation scraping job ${jobId}`, {
      jobId,
      reservationCount: reservations.length,
    });

    scrapingStateManager.startScraping("reservations", jobId);

    try {
      await reservation(null, reservations);

      // Mark scraping as completed
      scrapingStateManager.stopScraping();

      // Finalize logging with success status
      await finalizeJobLogging("success");

      res.status(200).json({
        status: 200,
        message: "Reservation search completed successfully",
        reservations: reservations,
        jobId: jobId,
      });
    } catch (reservationError) {
      await dualLogError(`Reservation job ${jobId} failed`, reservationError, {
        jobId,
      });

      // Send email notification for reservation error// Mark scraping as stopped on error
      scrapingStateManager.stopScraping();

      // Finalize logging with failed status
      await finalizeJobLogging("failed");

      throw reservationError;
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/reservation-run-job:", err);

    // Send email notification for reservation API error
    const possibleJobId = `reservation_job_${Date.now()}`; // Try to finalize logging if we can determine the jobId
    try {
      await dualLogError(`Reservation run job error`, err, { possibleJobId });
      await finalizeJobLogging("failed");
    } catch (logError) {
      console.error("Error finalizing logging:", logError);
    }

    // Mark scraping as stopped on error
    scrapingStateManager.stopScraping();
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
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!jobData || !jobData.expediaId) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expedia_id for job ${jobId}. Property may not have expedia_id assigned or expedia_id is "0".`,
      });
    }

    if (
      !propertyCredentials?.expediaUsername ||
      !propertyCredentials?.expediaPassword
    ) {
      return res.status(400).json({
        status: 400,
        message: `Cannot retrieve valid expediaUsername or expediaPassword for job ${jobId}. Property may not have expediaUsername or expediaPassword assigned.`,
      });
    }

    const { expediaId } = jobData;
    const { expediaUsername, expediaPassword } = propertyCredentials;

    console.log(`Using expedia_id: ${expediaId} for scraping`);

    // 3. Check if scraping is already running (legacy state manager check)
    // if (scrapingStateManager.isRunning()) {
    //   return res.status(409).json({
    //     status: 409,
    //     message: "Another scraping job is already running",
    //     currentState: scrapingStateManager.getState(),
    //   });
    // }

    // 4. Update job status to Running
    console.log(`Starting job ${jobId}...`);
    await jobService.startJob(jobId);

    // 5. Initialize job logging
    initializeJobLogging(jobId);
    await dualLogInfo(`Starting property scraping job ${jobId}`, {
      jobId,
      expediaId,
      startDate,
      endDate,
    });

    // 6. Start legacy state manager (for existing pause/resume functionality)
    scrapingStateManager.startScraping(expediaId, jobId, startDate, endDate);

    try {
      // 7. Run the main scraping function with expedia_id
      await graphqlScraping(
        expediaId,
        startDate,
        endDate,
        jobId,
        expediaUsername,
        expediaPassword
      );

      // 8. Get final job statistics
      const progress = await jobService.getJobProgress(jobId);

      // 9. Determine final status based on completion
      let finalStatus = JobStatus.Completed;
      if (progress.totalItems === 0) {
        finalStatus = JobStatus.Failed;
      } else if (progress.completionPercentage < 100) {
        finalStatus = JobStatus.Partial;
      }

      // 10. Update final job status
      await jobService.updateJobStatus(jobId, finalStatus);

      // 11. Change URL status back to Available (URL assigned by another project)
      await jobQueueUrlService.handleJobCompletion(jobId, finalStatus);

      // 12. Stop legacy state manager
      scrapingStateManager.stopScraping();

      // Get log file information if available
      const logger = getCurrentJobLogger();
      const logInfo = logger
        ? {
            logFilePath: logger.getLogFilePath(),
            logEntriesCount: logger.getLogEntriesCount(),
            note: "Log file uploaded to S3 and deleted locally after job completion",
          }
        : null;

      res.status(200).json({
        status: 200,
        message: `Property scraping ${finalStatus.toLowerCase()} successfully`,
        expediaId: expediaId,
        jobId: jobId,
        progress: progress,
        finalStatus: finalStatus,
        logInfo: logInfo,
      });
    } catch (scrapingError: any) {
      // Mark job as failed on scraping error
      await dualLogError(`Job ${jobId} failed`, scrapingError, { jobId });

      // Send email notification for scraping errorawait progressManager.handleJobError(jobId, scrapingError);

      // Release URL back to Available status on error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        scrapingError?.message || "Unknown error"
      );

      scrapingStateManager.stopScraping();

      // Finalize logging with failed status (this ensures log upload even on error)
      await finalizeJobLogging("failed");

      throw scrapingError;
    }
  } catch (err: any) {
    console.error("Error in /api/expedia/property-run-job:", err);

    // Send email notification for API error// Ensure job is marked as failed and state manager is stopped
    try {
      if (req.body.jobId) {
        await dualLogError(`Property run job ${req.body.jobId} failed`, err, {
          jobId: req.body.jobId,
        });
        await progressManager.handleJobError(req.body.jobId, err);

        // Release URL back to Available status on outer error
        await jobQueueUrlService.handleJobCompletion(
          req.body.jobId,
          "Failed",
          err.message
        );

        // Finalize logging to ensure log upload even if error occurs early
        await finalizeJobLogging("failed");
      }
      scrapingStateManager.stopScraping();
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
