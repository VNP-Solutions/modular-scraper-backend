import express from "express";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  getCurrentJobLogger,
  initializeJobLogging,
} from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import main from "../../main.js";
import { JobStatus } from "../../models/job.model.js";
import reservation from "../../reservation/reservation.js";
import { propertyCredentialsService } from "../../services/job-credentials.service.js";
import { jobQueueUrlService } from "../../services/job-queue-url.service.js";
import { jobService } from "../../services/job.service.js";

const router = express.Router();

/**
 * @swagger
 * /api/expedia/rerun-failed-job:
 *   post:
 *     tags:
 *       - Expedia Jobs
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
router.post("/rerun-failed-job", (async (
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
 *       - Expedia Jobs
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
router.post("/property-run-job", (async (
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
 *       - Expedia Jobs
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
router.post("/reservation-run-job", (async (
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

export default router;
