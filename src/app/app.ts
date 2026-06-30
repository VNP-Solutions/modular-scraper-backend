import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import createError from "../common/error.js";
import {
  getAcceptLanguage,
  getBrightDataSessionId,
  getTimezone,
  getWindowSize,
} from "../common/job-isolation.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { progressManager } from "../common/progress-manager.js";
import { WorkerJobData } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";

const app = express();

app.set("trust proxy", true);
app.use(bodyParser.json());
app.use(cors());

app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    explorer: true,
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Agoda Property Check API",
  })
);

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
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Server is running
 */
app.get("/", (_req, res, next) => {
  try {
    res.status(200).json({ message: "Connection established" });
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
 *     summary: Initiate Gmail OAuth (required for Agoda login emails)
 */
app.get("/auth", getAccess as any);

/**
 * @swagger
 * /oauth2callback:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Gmail OAuth callback
 */
app.get("/oauth2callback", getOauth2Callback as any);

/**
 * @swagger
 * /api/agoda/property-run-job:
 *   post:
 *     tags:
 *       - Agoda
 *     summary: Run Agoda login + property check job
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
 *                 example: "01/01/2025"
 *               endDate:
 *                 type: string
 *                 example: "01/31/2025"
 *               jobId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Job completed or queued
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

    const propertyData = await jobService.getAgodaIdFromJob(jobId);
    const propertyCredentials =
      await propertyCredentialsService.getCredentialsByJobId(jobId);

    if (!propertyData?.agodaId) {
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
        message: `Cannot retrieve valid agodaUsername or agodaPassword for job ${jobId}.`,
      });
    }

    const { agodaId } = propertyData;
    const { agodaUsername, agodaPassword } = propertyCredentials;

    const workerJobData: WorkerJobData = {
      jobType: "agoda-property-run",
      jobId,
      startDate,
      endDate,
      agodaId,
      agodaUsername,
      agodaPassword,
      brightDataSessionId: getBrightDataSessionId(jobId),
      windowSize: getWindowSize(jobId),
      timezone: getTimezone(jobId),
      acceptLanguage: getAcceptLanguage(jobId),
    };

    const result = await otpAwareWorkerPool.executeJob(workerJobData);

    if (result.success) {
      return res.status(200).json(result.data);
    }

    return res.status(500).json({
      status: 500,
      message: "Agoda job execution failed",
      error: result.error,
      jobId: result.jobId,
    });
  } catch (err: any) {
    console.error("Error in /api/agoda/property-run-job:", err);

    try {
      if (req.body?.jobId) {
        await progressManager.handleJobError(req.body.jobId, err);
      }
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }

    res.status(500).json({
      status: 500,
      message: "Error processing Agoda property check",
      error: err.message,
    });
  }
}) as any);

app.use((err: any, _req: any, res: any, next: any) => {
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
