import express from "express";
import agoda from "../../agoda.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  getCurrentJobLogger,
  initializeJobLogging,
} from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
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
 *             $ref: '#/components/schemas/AgodaPropertyJobRequest'
 *           examples:
 *             standard_job:
 *               summary: Standard monthly scraping job
 *               value:
 *                 startDate: "2024-01-01"
 *                 endDate: "2024-01-31"
 *                 jobId: "507f1f77bcf86cd799439011"
 *             custom_range:
 *               summary: Custom date range
 *               value:
 *                 startDate: "2024-03-15"
 *                 endDate: "2024-04-15"
 *                 jobId: "507f1f77bcf86cd799439012"
 *     responses:
 *       200:
 *         description: Job completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgodaPropertyJobResponse'
 *             examples:
 *               completed_job:
 *                 summary: Successfully completed job
 *                 value:
 *                   status: 200
 *                   message: "Property scraping completed successfully"
 *                   agodaId: "123456"
 *                   jobId: "507f1f77bcf86cd799439011"
 *                   progress:
 *                     totalItems: 150
 *                     itemsWithCardInfo: 150
 *                     itemsWithPaymentInfo: 145
 *                     completionPercentage: 97
 *                   finalStatus: "Completed"
 *                   logInfo:
 *                     logFilePath: "/logs/job_507f1f77bcf86cd799439011_1704067200000.log"
 *                     logEntriesCount: 1247
 *                     note: "Log file uploaded to S3 and deleted locally after job completion"
 *               partial_job:
 *                 summary: Partially completed job
 *                 value:
 *                   status: 200
 *                   message: "Property scraping partial successfully"
 *                   agodaId: "123456"
 *                   jobId: "507f1f77bcf86cd799439011"
 *                   progress:
 *                     totalItems: 150
 *                     itemsWithCardInfo: 120
 *                     itemsWithPaymentInfo: 85
 *                     completionPercentage: 57
 *                   finalStatus: "Partial"
 *                   logInfo:
 *                     logFilePath: "/logs/job_507f1f77bcf86cd799439011_1704067200000.log"
 *                     logEntriesCount: 892
 *                     note: "Log file uploaded to S3 and deleted locally after job completion"
 *       400:
 *         description: Bad request - Invalid input parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missing_dates:
 *                 summary: Missing required date parameters
 *                 value:
 *                   status: 400
 *                   message: "startDate and endDate are required in request body"
 *               missing_job_id:
 *                 summary: Missing job ID
 *                 value:
 *                   status: 400
 *                   message: "jobId is required in request body"
 *               invalid_agoda_id:
 *                 summary: Invalid or missing Agoda ID
 *                 value:
 *                   status: 400
 *                   message: "Cannot retrieve valid agoda_id for job 507f1f77bcf86cd799439011. Property may not have agoda_id assigned or agoda_id is \"0\"."
 *               missing_credentials:
 *                 summary: Missing Agoda credentials
 *                 value:
 *                   status: 400
 *                   message: "Cannot retrieve valid agodaUsername or agodaPassword for job 507f1f77bcf86cd799439011. Property may not have agodaUsername or agodaPassword assigned."
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               status: 404
 *               message: "Job with ID 507f1f77bcf86cd799439011 not found"
 *       409:
 *         description: Job not in runnable state
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ErrorResponse'
 *                 - type: object
 *                   properties:
 *                     currentState:
 *                       type: object
 *                       description: Current job state information
 *             example:
 *               status: 409
 *               message: "Job 507f1f77bcf86cd799439011 is not in a runnable state. Current status: Running"
 *               currentState:
 *                 _id: "507f1f77bcf86cd799439011"
 *                 job_status: "Running"
 *                 property_name: "Sample Hotel"
 *                 createdAt: "2024-01-01T00:00:00.000Z"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               scraping_error:
 *                 summary: Error during scraping process
 *                 value:
 *                   status: 500
 *                   message: "Error processing property search"
 *                   error: "Browser automation failed: Unable to locate sign-in elements"
 *               authentication_error:
 *                 summary: Authentication failure
 *                 value:
 *                   status: 500
 *                   message: "Error processing property search"
 *                   error: "Gmail authentication failed: Invalid credentials"
 *               system_error:
 *                 summary: System resource error
 *                 value:
 *                   status: 500
 *                   message: "Error processing property search"
 *                   error: "Insufficient system resources to complete job"
 *     security: []
 *     x-codeSamples:
 *       - lang: 'curl'
 *         source: |
 *           curl -X POST "http://localhost:3000/api/agoda/property-run-job" \
 *             -H "Content-Type: application/json" \
 *             -d '{
 *               "startDate": "2024-01-01",
 *               "endDate": "2024-01-31",
 *               "jobId": "507f1f77bcf86cd799439011"
 *             }'
 *       - lang: 'JavaScript'
 *         source: |
 *           const response = await fetch('/api/agoda/property-run-job', {
 *             method: 'POST',
 *             headers: {
 *               'Content-Type': 'application/json',
 *             },
 *             body: JSON.stringify({
 *               startDate: '2024-01-01',
 *               endDate: '2024-01-31',
 *               jobId: '507f1f77bcf86cd799439011'
 *             })
 *           });
 *           const result = await response.json();
 *       - lang: 'Python'
 *         source: |
 *           import requests
 *
 *           response = requests.post(
 *               'http://localhost:3000/api/agoda/property-run-job',
 *               json={
 *                   'startDate': '2024-01-01',
 *                   'endDate': '2024-01-31',
 *                   'jobId': '507f1f77bcf86cd799439011'
 *               }
 *           )
 *           result = response.json()
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
      agodaId,
      startDate,
      endDate,
    });

    // 6. Start legacy state manager (for existing pause/resume functionality)
    scrapingStateManager.startScraping(agodaId, jobId, startDate, endDate);

    try {
      // 7. Run the main scraping function with agoda_id
      await agoda(
        agodaId,
        startDate,
        endDate,
        jobId,
        agodaUsername,
        agodaPassword
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
        agodaId: agodaId,
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
    console.error("Error in /api/agoda/property-run-job:", err);

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

export default router;
