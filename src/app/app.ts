import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { isMainThread } from "worker_threads";
import { triggerDbmsOtaCheckLambda } from "../common/dbms-notifier.js";
import createError from "../common/error.js";
import { getFailedReasonForUser } from "../common/failed-reason.js";
import { setCurrentWorkerId } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { specs, swaggerUi } from "../config/swagger.js";
import { getAccess, getOauth2Callback } from "../get-access/access.js";
import { checkBookingProperties } from "../property-check/booking-property-check.js";
import { normalizeBookingCheckRequest } from "../property-check/booking-request-normalizer.js";

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
    customSiteTitle: "Booking Property Check API Documentation",
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
      .json({ messge: "Connection established on booking-property-check branch" });
  } catch (err: any) {
    next(createError(err.status, err.message));
  }
});

// Google OAuth — required so the OTP flow can read Booking.com verification
// codes out of the mailbox.
app.get("/auth", getAccess as any);

app.get("/oauth2callback", getOauth2Callback as any);

app.post("/api/booking/check-properties", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        status: 400,
        message: "username and password are required in request body",
      });
    }

    const normalized = normalizeBookingCheckRequest(req.body);
    if (!normalized.ok) {
      return res.status(400).json({
        status: 400,
        message: normalized.message,
      });
    }

    // Prevent collision with another in-flight check run.
    if (scrapingStateManager.isRunning()) {
      return res.status(409).json({
        status: 409,
        message: "A scraping or property-check operation is already running",
      });
    }

    // This check is time consuming (login + captcha + 2FA + per-property
    // search), so we acknowledge the request immediately and run the work in
    // the background. Results are persisted as DB side-effects
    // (booking_credential_verified / booking_access_level), so the caller does
    // not need them in the response.
    void checkBookingProperties(username, password, normalized.data.booking_ids)
      .then((results) => {
        console.log(
          `booking check-properties completed for ${results.length} property(ies).`
        );
      })
      .catch((err: any) => {
        const message = getFailedReasonForUser(err) || "Login failed";
        console.error(
          "Background booking check-properties failed:",
          message,
          err?.message
        );
      })
      .finally(() => {
        // Searching API finished — ask DBMS to re-trigger its Lambda so the
        // next queued account-group payload (if any) gets processed.
        void triggerDbmsOtaCheckLambda("booking");
      });

    return res.status(200).json({
      status: 200,
      message:
        "Request accepted. Property check is running in the background; results are written to the database.",
    });
  } catch (err: any) {
    console.error("Error in /api/booking/check-properties:", err);
    const message = getFailedReasonForUser(err) || "Login failed";
    return res.status(500).json({
      status: 500,
      message,
      error: err?.message,
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
