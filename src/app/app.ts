import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { specs, swaggerUi } from "../config/swagger.js";

// Import route modules
import authRoutes from "../routes/shared/auth.routes.js";
import healthRoutes from "../routes/shared/health.routes.js";
import jobsRoutes from "../routes/shared/jobs.routes.js";
import scrapingRoutes from "../routes/shared/scraping.routes.js";

// Expedia-specific routes
import expediarScrapingRoutes from "../routes/expedia/scraping.routes.js";

// Agoda-specific routes
import agodaScrapingRoutes from "../routes/agoda/scraping.routes.js";

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
    customSiteTitle: "Modular Scraper API Documentation",
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

// Route registrations with centralized management

// Health and authentication routes (no prefix)
app.use("/", healthRoutes);
app.use("/", authRoutes);

// Shared API routes
app.use("/api/scraping", scrapingRoutes);
app.use("/api/jobs", jobsRoutes);

// Platform-specific scraping routes
app.use("/api/expedia", expediarScrapingRoutes);
app.use("/api/agoda", agodaScrapingRoutes);

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
