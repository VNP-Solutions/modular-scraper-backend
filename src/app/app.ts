import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { specs, swaggerUi } from "../config/swagger.js";

// Import route modules
import authRoutes from "../routes/shared/auth.routes.js";
import emailRoutes from "../routes/shared/email.routes.js";
import healthRoutes from "../routes/shared/health.routes.js";

// Expedia-specific routes
import expediarJobsRoutes from "../routes/expedia/jobs.routes.js";
import expediarScrapingControlRoutes from "../routes/expedia/scraping-control.routes.js";
import expediarScrapingRoutes from "../routes/expedia/scraping.routes.js";

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

// Route registrations
// Health and authentication routes (no prefix)
app.use("/", healthRoutes);
app.use("/", authRoutes);

// Email notification routes
app.use("/api/notifications", emailRoutes);

// API routes (keeping original endpoints)
app.use("/api/scraping", expediarScrapingControlRoutes);
app.use("/api/jobs", expediarJobsRoutes);
app.use("/api/expedia", expediarScrapingRoutes);

// Global error handle middleware
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
