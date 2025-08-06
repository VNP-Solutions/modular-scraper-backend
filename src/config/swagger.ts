import dotenv from "dotenv";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

dotenv.config();

const port = process.env.PORT || "3000";
const serverUrl = `http://localhost:${port}`;
const serverUrl2 = "https://modular-api-2.vnpmanage.online";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Module Scrapper API",
      version: "1.0.0",
      description:
        "API documentation for the Expedia property scraping service with pause/resume functionality",
      contact: {
        name: "API Support",
        email: "support@example.com",
      },
    },
    servers: [
      {
        url: serverUrl,
        description: "Local server",
      },
      {
        url: serverUrl2,
        description: "Development server",
      },
    ],
    components: {
      schemas: {
        ScrapingState: {
          type: "object",
          properties: {
            isRunning: {
              type: "boolean",
              description: "Whether a scraping job is currently active",
            },
            isPaused: {
              type: "boolean",
              description: "Whether the current job is paused",
            },
            currentPropertyId: {
              type: "string",
              description: "The property ID being scraped",
            },
            currentJobId: {
              type: "string",
              description: "Unique identifier for the current job",
            },
            startDate: {
              type: "string",
              format: "date",
              description: "Start date for the scraping job",
            },
            endDate: {
              type: "string",
              format: "date",
              description: "End date for the scraping job",
            },
            currentPage: {
              type: "integer",
              description: "Current page being processed",
            },
            totalPages: {
              type: "integer",
              description: "Total number of pages to process",
            },
            processedCount: {
              type: "integer",
              description: "Number of items processed so far",
            },
            totalCount: {
              type: "integer",
              description: "Total number of items to process",
            },
            lastUpdated: {
              type: "string",
              format: "date-time",
              description: "Timestamp of the last state update",
            },
          },
        },
        AgodaPropertyJobRequest: {
          type: "object",
          properties: {
            startDate: {
              type: "string",
              format: "date",
              description: "Start date for the scraping period (YYYY-MM-DD)",
              example: "2024-01-01",
            },
            endDate: {
              type: "string",
              format: "date",
              description: "End date for the scraping period (YYYY-MM-DD)",
              example: "2024-01-31",
            },
            jobId: {
              type: "string",
              description: "Unique identifier for the job to execute",
              example: "507f1f77bcf86cd799439011",
            },
          },
          required: ["startDate", "endDate", "jobId"],
        },
        AgodaPropertyJobResponse: {
          type: "object",
          properties: {
            status: {
              type: "integer",
              description: "HTTP status code",
              example: 200,
            },
            message: {
              type: "string",
              description: "Response message",
              example: "Property scraping completed successfully",
            },
            agodaId: {
              type: "string",
              description: "Agoda property ID that was scraped",
              example: "123456",
            },
            jobId: {
              type: "string",
              description: "Job identifier",
              example: "507f1f77bcf86cd799439011",
            },
            progress: {
              $ref: "#/components/schemas/JobProgress",
            },
            finalStatus: {
              type: "string",
              enum: ["Completed", "Partial", "Failed"],
              description: "Final status of the job execution",
            },
            logInfo: {
              type: "object",
              nullable: true,
              properties: {
                logFilePath: {
                  type: "string",
                  description: "Path to the log file",
                },
                logEntriesCount: {
                  type: "integer",
                  description: "Number of log entries",
                },
                note: {
                  type: "string",
                  description: "Additional information about log handling",
                },
              },
            },
          },
        },
        JobProgress: {
          type: "object",
          properties: {
            totalItems: {
              type: "integer",
              description: "Total number of items to process",
              example: 150,
            },
            itemsWithCardInfo: {
              type: "integer",
              description: "Number of items with card information extracted",
              example: 120,
            },
            itemsWithPaymentInfo: {
              type: "integer",
              description: "Number of items with payment information extracted",
              example: 100,
            },
            completionPercentage: {
              type: "integer",
              description:
                "Completion percentage based on payment info extraction",
              example: 67,
            },
          },
        },
        JobValidation: {
          type: "object",
          properties: {
            exists: {
              type: "boolean",
              description: "Whether the job exists",
            },
            canRun: {
              type: "boolean",
              description: "Whether the job can be executed",
            },
            job: {
              type: "object",
              nullable: true,
              description: "Job object if exists",
            },
          },
        },
        JobStatus: {
          type: "string",
          enum: ["Pending", "Running", "Completed", "Partial", "Failed"],
          description: "Current status of the job",
        },
        ApiResponse: {
          type: "object",
          properties: {
            status: {
              type: "integer",
              description: "HTTP status code",
            },
            message: {
              type: "string",
              description: "Response message",
            },
            data: {
              description: "Response data (varies by endpoint)",
            },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            status: {
              type: "integer",
              description: "HTTP status code",
            },
            message: {
              type: "string",
              description: "Error message",
            },
            error: {
              type: "string",
              description: "Detailed error information",
            },
          },
        },
        Reservation: {
          type: "object",
          properties: {
            reservationId: {
              type: "string",
              description: "Unique reservation identifier",
            },
            propertyId: {
              type: "string",
              description: "Property identifier",
            },
          },
          required: ["reservationId", "propertyId"],
        },
      },
    },
    tags: [
      {
        name: "Health",
        description: "Health check endpoints",
      },
      {
        name: "Authentication",
        description: "Authentication related endpoints",
      },
      {
        name: "Scraping Control",
        description: "Endpoints for controlling scraping operations",
      },
      {
        name: "Scraping Jobs",
        description: "Endpoints for starting scraping jobs",
      },
      {
        name: "Job Monitoring",
        description: "Endpoints for monitoring job progress and results",
      },
      {
        name: "Agoda Scraping",
        description: "Agoda-specific property scraping endpoints",
      },
    ],
  },
  apis: [
    "./src/app/*.ts",
    "./src/routes/**/*.ts", // Include all route files for API documentation
  ],
};

const specs = swaggerJsdoc(options);

export { specs, swaggerUi };
