import express from "express";
import { dualLogError, finalizeJobLogging } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { workerPool } from "../../common/worker-pool.js";
import { WorkerJobData } from "../../common/worker-types.js";
import { JobStatus } from "../../models/job.model.js";
import { propertyCredentialsService } from "../../services/job-credentials.service.js";
import { jobQueueUrlService } from "../../services/job-queue-url.service.js";
import { jobService } from "../../services/job.service.js";

const router = express.Router();

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
 *       6. **Resource Management**: Manages browser resources and URL queue assignments
 *       7. **Error Handling**: Comprehensive error handling with email notifications
 *       8. **Log Management**: Uploads detailed logs to S3 storage
 *
 *       **Authentication Flow:**
 *       - Automatically retrieves Agoda sign-in links from Gmail
 *       - Handles email-based authentication without manual intervention
 *       - Supports automatic retry mechanisms for failed authentications
 *
 *       **Data Processing:**
 *       - Extracts reservation details, guest information, and payment data
 *       - Validates data completeness and accuracy
 *       - Provides detailed progress metrics including completion percentages
 *
 *       **Job Status Management:**
 *       - `Completed`: All data successfully extracted
 *       - `Partial`: Some data extracted but job incomplete
 *       - `Failed`: Job failed due to errors or authentication issues
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
 *                 example: "01/01/2025"
 *               endDate:
 *                 type: string
 *                 description: End date for scraping (MM/DD/YYYY format)
 *                 example: "01/31/2025"
 *               jobId:
 *                 type: string
 *                 description: MongoDB ObjectId of the job to run
 *                 example: "6892f4bf9df8bc296bdcdff0"
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
 *                     itemsWithCardInfo:
 *                       type: integer
 *                       example: 150
 *                     itemsWithPaymentInfo:
 *                       type: integer
 *                       example: 145
 *                     completionPercentage:
 *                       type: integer
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

    // 2. Get agoda_id from job's property
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

    // 3. Check if worker threads are available
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All workers busy, try again",
        workerStatus: workerPool.getStatus(),
      });
    }

    // 4. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: "agoda-property-run",
      jobId,
      startDate,
      endDate,
      agodaId,
      agodaUsername,
      agodaPassword,
    };

    // 5. Execute job in worker thread
    try {
      console.log(`Submitting Agoda job ${jobId} to worker pool...`);

      const result = await workerPool.executeJob(workerJobData);

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

    // Send email notification for API error// Ensure job is marked as failed and state manager is stopped
    try {
      if (req.body.jobId) {
        await dualLogError(
          `Agoda property run job ${req.body.jobId} failed`,
          err,
          {
            jobId: req.body.jobId,
          }
        );
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
      message: "Error processing Agoda property search",
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
 *     description: Rerun an Agoda job that has failed or partially completed. This endpoint specifically handles jobs with Failed or Partial status and resets them to run again.
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
 *       400:
 *         description: Invalid request or job not eligible for rerun
 *       404:
 *         description: Job not found
 *       500:
 *         description: Error processing job rerun
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

    // Check if worker threads are available
    if (!workerPool.hasAvailableWorkers() && workerPool.isQueueFull()) {
      return res.status(200).json({
        status: 200,
        message: "All workers busy, try again",
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

    // 3. Get agoda_id and credentials from job's property
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
        message: `Cannot retrieve valid Agoda credentials for job ${jobId}. Property may not have credentials assigned.`,
      });
    }

    const { agodaId } = propertyData;
    const { agodaUsername, agodaPassword } = propertyCredentials;

    console.log(
      `Rerunning failed/partial Agoda job ${jobId} with agoda_id: ${agodaId}`
    );

    // 4. Prepare worker job data
    const workerJobData: WorkerJobData = {
      jobType: "agoda-rerun-failed",
      jobId,
      startDate,
      endDate,
      agodaId,
      agodaUsername,
      agodaPassword,
      originalStatus,
    };

    // 5. Execute job in worker thread
    try {
      console.log(`Submitting Agoda rerun job ${jobId} to worker pool...`);

      const result = await workerPool.executeJob(workerJobData);

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
      console.error(`Agoda Worker error for rerun job ${jobId}:`, workerError);

      // Ensure job is marked as failed
      try {
        await progressManager.handleJobError(jobId, workerError);
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }

      return res.status(500).json({
        status: 500,
        message: "Agoda Worker execution failed for job rerun",
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
        await dualLogError(`Agoda rerun job ${req.body.jobId} failed`, err, {
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
      message: "Error processing Agoda job rerun",
      error: err.message,
    });
  }
}) as any);

export default router;
