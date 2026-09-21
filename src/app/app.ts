import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { isMainThread } from "worker_threads";
import createError from "../common/error.js";
import { setCurrentWorkerId } from "../common/log-helper.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { JobType } from "../common/worker-types.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { jobService } from "../services/job.service.js";
import { otpStatusService } from "../services/otp-status.service.js";
import { OtpPlatform } from "../models/otp-status.model.js";
import cookieStorageRoutes from "../routes/shared/cookie-storage.routes.js";
import { TripScraper } from "../scrapers/trip-scraper.js";

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
      .json({ messge: "Connection established" });
  } catch (err: any) {
    next(createError(err.status, err.message));
  }
});

app.get("/auth", getAccess as any);

app.get("/oauth2callback", getOauth2Callback as any);

/**
 * @swagger
 * /api/trip/test-run:
 *   post:
 *     tags:
 *       - Trip.com Testing
 *     summary: Test the full Trip.com login -> verification -> property search flow
 *     description: >
 *       Standalone test endpoint for exercising the full Trip.com scraper
 *       flow (login, identity verification with SMS->email mode switch and
 *       magic-link fallback across candidate emails, and group property
 *       search with fuzzy name matching) without requiring a Job document
 *       or a stored PropertyCredentials record — pass everything directly
 *       in the body. Runs a real (headed in dev) browser against the live
 *       Trip.com site with the credentials provided. Can take several
 *       minutes end-to-end when identity verification is triggered (the
 *       real flow waits ~90s+ for the verification email to arrive before
 *       polling Gmail).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *               - propertyName
 *             properties:
 *               username:
 *                 type: string
 *                 description: Trip.com eBooking username
 *                 example: "EstorilVNP"
 *               password:
 *                 type: string
 *                 description: Trip.com eBooking password
 *                 example: "Kirat@2026"
 *               propertyName:
 *                 type: string
 *                 description: Human-readable property name to search for on the group dashboard
 *                 example: "Aldhafra, a Vignette Collection"
 *               endDate:
 *                 type: string
 *                 description: >
 *                   Optional. MM/DD/YYYY. If provided, after landing on the
 *                   property dashboard the scraper navigates to the VCC
 *                   settlement page and queries `queryVccOrder` across
 *                   1-month chunks covering the 180 days ending on this date.
 *                 example: "09/21/2026"
 *               tripVccPassword:
 *                 type: string
 *                 description: >
 *                   Optional. If the summed VCC balance across all queried
 *                   orders exceeds 100 (in the orders' own currency), each
 *                   qualifying order's `vcc-details` page is opened using
 *                   this password. Skipped entirely if not provided.
 *     responses:
 *       200:
 *         description: Test run completed successfully (login + verification + property search all succeeded)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 testRunId:
 *                   type: string
 *                   example: "trip_test_1758452345123"
 *                 propertyName:
 *                   type: string
 *                   example: "Aldhafra, a Vignette Collection"
 *                 data:
 *                   type: object
 *                   description: Scrape result data (structure is still evolving)
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 screenshots:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Missing required fields in request body
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
 *                   example: "username, password, and propertyName are all required in the request body"
 *       500:
 *         description: Test run failed (login, verification, or property search failed)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 testRunId:
 *                   type: string
 *                 propertyName:
 *                   type: string
 *                 error:
 *                   type: string
 *                 screenshots:
 *                   type: array
 *                   items:
 *                     type: string
 */
app.post("/api/trip/test-run", (async (req: any, res: any) => {
  const { username, password, propertyName, endDate, tripVccPassword } =
    req.body || {};

  if (!username || !password || !propertyName) {
    return res.status(400).json({
      success: false,
      message:
        "username, password, and propertyName are all required in the request body",
    });
  }

  const testRunId = `trip_test_${Date.now()}`;
  console.log(
    `[trip-test-run] Starting test run ${testRunId} for property "${propertyName}"`
  );

  // Local-only run state (no DB) so BaseScraper's "scraping stopped" checks
  // don't immediately abort the flow.
  scrapingStateManager.startScraping(propertyName, testRunId);

  const scraper = new TripScraper();

  try {
    // Deliberately not passing jobId/propertyIdForDb — this keeps the whole
    // run DB-free (no Job document needed). BaseScraper handles a missing
    // jobId gracefully throughout (screenshots still upload to S3 under a
    // generic key; job-status DB writes are skipped entirely).
    const result = await scraper.executeScraping({
      propertyId: propertyName,
      credentials: { email: username, password },
      endDate,
      tripVccPassword,
    });

    console.log(
      `[trip-test-run] Test run ${testRunId} finished with success=${result.success}`
    );

    res.status(result.success ? 200 : 500).json({
      success: result.success,
      testRunId,
      propertyName,
      data: result.data,
      error: result.error,
      screenshots: result.screenshots,
    });
  } catch (error: any) {
    console.error(`[trip-test-run] Test run ${testRunId} threw:`, error);
    res.status(500).json({
      success: false,
      testRunId,
      propertyName,
      error: error?.message || "Unknown error",
    });
  } finally {
    scrapingStateManager.stopScraping();
  }
}) as any);

/**
 * @swagger
 * /api/trip/property-run-job:
 *   post:
 *     tags:
 *       - Trip.com Jobs
 *     summary: Run one or more DB-backed Trip.com property scraping jobs (multi-threaded)
 *     description: >
 *       Batch runner for Trip.com jobs that already exist as Job documents.
 *       Takes an array of job IDs and submits each one to the same
 *       OTP-aware worker-thread pool Expedia/Booking use
 *       (`MAX_WORKER_THREADS` concurrent workers, default 3) — jobs run in
 *       true parallel worker threads, not sequentially in this request
 *       handler; anything beyond the pool's worker count is queued
 *       automatically (job status flips to `InQueue`) and picked up as a
 *       worker frees up. For each job, the property name (used for
 *       fuzzy-matching on the group dashboard), Trip.com credentials
 *       (username/password + VCC reveal password), and end date (the job's
 *       own `end_date` field; anchors the 180-day VCC lookback window) are
 *       looked up from the job's own record and its linked
 *       property/credentials records inside the worker — nothing needs to
 *       be passed in per-job beyond the id.
 *
 *       Concurrency note: multiple Trip jobs *can* run at once here (unlike
 *       Booking's phone-number gate, nothing in the pool blocks it), but
 *       every job still shares ONE Gmail inbox for its verification
 *       emails/links. TripScraper itself serializes that specific step via
 *       an internal DB lock (`otp_statuses`, platform `trip.com`) — so
 *       login/property-search/etc. proceed fully in parallel across
 *       worker threads, and only the email-verification step queues up
 *       behind whichever job is actively polling Gmail at that moment.
 *
 *       A failure on one job does not stop the rest of the batch — every
 *       job's own outcome is reported individually in the `results` array.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jobIds
 *             properties:
 *               jobIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: MongoDB ObjectIds of the jobs to run
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *     responses:
 *       200:
 *         description: Every job in the batch completed successfully — see `results` for per-job detail
 *       207:
 *         description: Batch finished but at least one job failed/was skipped — see `results` for per-job status
 *       400:
 *         description: Missing or invalid jobIds in request body
 */
app.post("/api/trip/property-run-job", (async (req: any, res: any) => {
  const { jobIds } = req.body || {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({
      status: 400,
      message: "jobIds (a non-empty array) is required in request body",
    });
  }

  console.log(
    `[trip-property-run-job] Submitting ${jobIds.length} job(s) to the OTP-aware worker pool`
  );

  // Submit every job to the worker pool up-front (not one-at-a-time) so
  // they compete for the pool's worker threads in parallel — the pool
  // itself handles queueing anything beyond MAX_WORKER_THREADS. All
  // per-job validation/lookup/status-update logic lives in
  // ScrapingWorker.handleTripPropertyRun(), run inside the worker thread.
  //
  // `requiresOtp` is intentionally omitted (defaults to false/undefined)
  // — see the swagger description above for why Trip doesn't use the
  // pool's Booking-specific OTP gate.
  const outcomes = await Promise.allSettled(
    jobIds.map((jobId: string) =>
      otpAwareWorkerPool.executeJob({
        jobType: JobType.TripPropertyRun,
        jobId,
      })
    )
  );

  const results = outcomes.map((outcome, index) => {
    const jobId = jobIds[index];

    if (outcome.status === "fulfilled") {
      const response = outcome.value as any;
      return {
        jobId,
        status: 200,
        ...(response?.data || {}),
      };
    }

    const reason: any = outcome.reason;
    console.error(`[trip-property-run-job] Job ${jobId} failed:`, reason);
    return {
      jobId,
      status: 500,
      message: `Job ${jobId} failed`,
      error: reason?.error || reason?.message || String(reason),
    };
  });

  const overallSuccess = results.every((r) => r.status === 200);

  res.status(overallSuccess ? 200 : 207).json({
    status: overallSuccess ? 200 : 207,
    message: overallSuccess
      ? "All Trip.com property jobs completed successfully"
      : "Batch completed with one or more failures — see results for per-job details",
    results,
  });
}) as any);

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

app.get("/api/jobs/:jobId/job-items-file", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({ status: 404, message: "Job not found" });
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

app.get(
  "/api/worker-pool/status",
  (async (req: express.Request, res: express.Response) => {
    try {
      const otpAwareWorkerPoolStatus = otpAwareWorkerPool.getStatus();
      const otpStatus = await otpStatusService.getStatus(OtpPlatform.Trip);

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
  }) as any
);

// Get Trip.com shared-inbox OTP lock status only
app.get("/api/otp/status", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const otpStatus = await otpStatusService.getStatus(OtpPlatform.Trip);

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
}) as any);

app.use("/api/properties", cookieStorageRoutes);

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
  (async (req: express.Request, res: express.Response) => {
    try {
      const status = otpAwareWorkerPool.getStatus();
      const otpStatus = await otpStatusService.getStatus(OtpPlatform.Trip);

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
  }) as any
);

export default app;
