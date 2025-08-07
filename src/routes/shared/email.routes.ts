import express from "express";
import { EmailNotifier } from "../../common/email-notifier.js";
import createError from "../../common/error.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";

const router = express.Router();
const emailNotifier = EmailNotifier.getInstance();

/**
 * @swagger
 * components:
 *   schemas:
 *     EmailNotificationRequest:
 *       type: object
 *       required:
 *         - jobId
 *         - errorMessage
 *       properties:
 *         jobId:
 *           type: string
 *           description: The ID of the job that encountered an error
 *           example: "job_12345"
 *         errorMessage:
 *           type: string
 *           description: The error message to include in the notification
 *           example: "Database connection failed"
 *         errorDetails:
 *           type: object
 *           description: Additional error details or stack trace
 *           example: {"stack": "Error: Connection timeout...", "code": "ECONNRESET"}
 *         additionalData:
 *           type: object
 *           properties:
 *             stage:
 *               type: string
 *               description: The stage where the error occurred
 *               example: "data_scraping"
 *             progressPercentage:
 *               type: number
 *               description: Current progress percentage of the job
 *               example: 75.5
 *             lastProcessedDate:
 *               type: string
 *               description: Last successfully processed date
 *               example: "2025-01-03"
 *     EmailNotificationResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         message:
 *           type: string
 *           example: "Email notification sent successfully"
 *         jobId:
 *           type: string
 *           example: "job_12345"
 *         timestamp:
 *           type: string
 *           format: date-time
 *           example: "2025-01-03T10:30:00.000Z"
 */

/**
 * @swagger
 * /api/notifications/email/error:
 *   post:
 *     tags:
 *       - Email Notifications
 *     summary: Send error notification email
 *     description: |
 *       Send an error notification email for a specific job to configured watcher emails.
 *       This endpoint allows other developers to integrate email notifications into their workflows.
 *
 *       **Required parameters:**
 *       - `jobId`: The job ID that encountered an error
 *       - `errorMessage`: Description of the error
 *
 *       **Optional parameters:**
 *       - `errorDetails`: Additional error information (stack trace, error codes, etc.)
 *       - `additionalData`: Extra context including stage, progress, and last processed date
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EmailNotificationRequest'
 *           examples:
 *             basic_error:
 *               summary: Basic error notification
 *               value:
 *                 jobId: "job_12345"
 *                 errorMessage: "Database connection failed"
 *             detailed_error:
 *               summary: Detailed error with context
 *               value:
 *                 jobId: "job_12345"
 *                 errorMessage: "Scraping process failed during data extraction"
 *                 errorDetails:
 *                   stack: "Error: Timeout waiting for element..."
 *                   code: "TIMEOUT_ERROR"
 *                 additionalData:
 *                   stage: "data_scraping"
 *                   progressPercentage: 65.5
 *                   lastProcessedDate: "2025-01-02"
 *             minimal_error:
 *               summary: Minimal required fields only
 *               value:
 *                 jobId: "job_67890"
 *                 errorMessage: "Unknown error occurred"
 *     responses:
 *       200:
 *         description: Email notification sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EmailNotificationResponse'
 *       400:
 *         description: Bad request - missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missing_jobId:
 *                 summary: Missing jobId
 *                 value:
 *                   status: 400
 *                   message: "jobId is required"
 *               missing_errorMessage:
 *                 summary: Missing errorMessage
 *                 value:
 *                   status: 400
 *                   message: "errorMessage is required"
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               status: 404
 *               message: "Job not found with ID: job_12345"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/email/error", async (req, res, next) => {
  try {
    const { jobId, errorMessage, errorDetails, additionalData } = req.body;

    // Validate required fields
    if (!jobId) {
      return next(createError(400, "jobId is required"));
    }

    if (!errorMessage) {
      return next(createError(400, "errorMessage is required"));
    }

    // Validate jobId format (basic string validation)
    if (typeof jobId !== "string" || jobId.trim().length === 0) {
      return next(createError(400, "jobId must be a non-empty string"));
    }

    // Validate errorMessage format
    if (typeof errorMessage !== "string" || errorMessage.trim().length === 0) {
      return next(createError(400, "errorMessage must be a non-empty string"));
    }

    // Log the incoming request
    await dualLogInfo("Email notification API called", {
      jobId,
      errorMessage: errorMessage.substring(0, 100), // Log first 100 chars
      hasErrorDetails: !!errorDetails,
      hasAdditionalData: !!additionalData,
      stage: additionalData?.stage,
      progressPercentage: additionalData?.progressPercentage,
    });

    // Call the email notifier service
    await emailNotifier.notifyJobError(
      jobId,
      errorMessage,
      errorDetails,
      additionalData
    );

    // Return success response
    res.status(200).json({
      success: true,
      message: "Email notification sent successfully",
      jobId,
      timestamp: new Date().toISOString(),
    });

    await dualLogInfo("Email notification sent via API", {
      jobId,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    await dualLogError("Error in email notification API:", error, {
      jobId: req.body?.jobId,
      errorMessage: req.body?.errorMessage,
    });

    // Check if it's a job not found error
    if (error.message && error.message.includes("Job not found")) {
      return next(
        createError(404, `Job not found with ID: ${req.body?.jobId}`)
      );
    }

    // Handle other errors
    next(
      createError(500, error.message || "Failed to send email notification")
    );
  }
});

/**
 * @swagger
 * /api/notifications/email/test:
 *   get:
 *     tags:
 *       - Email Notifications
 *     summary: Test email notification system
 *     description: |
 *       Test endpoint to verify if the email notification system is properly configured.
 *       This endpoint checks if the email transporter is initialized and ready to send emails.
 *     responses:
 *       200:
 *         description: Email system is configured and ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Email notification system is ready"
 *                 configured:
 *                   type: boolean
 *                   example: true
 *       503:
 *         description: Email system is not configured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Email notification system is not configured"
 *                 configured:
 *                   type: boolean
 *                   example: false
 */
router.get("/email/test", async (req, res, next) => {
  try {
    // Check if email transporter is configured
    const isConfigured = (emailNotifier as any).transporter !== null;

    if (isConfigured) {
      res.status(200).json({
        success: true,
        message: "Email notification system is ready",
        configured: true,
      });
    } else {
      res.status(503).json({
        success: false,
        message: "Email notification system is not configured",
        configured: false,
      });
    }
  } catch (error: any) {
    await dualLogError("Error testing email notification system:", error);
    next(createError(500, "Failed to test email notification system"));
  }
});

export default router;
