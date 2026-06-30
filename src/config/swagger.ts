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
        "Agoda property check API — login and verify property access",
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
            reservationId: { type: "string" },
            propertyId: { type: "string" },
          },
        },
      },
    },
    tags: [
      { name: "Health", description: "Health check endpoints" },
      { name: "Authentication", description: "Gmail OAuth for Agoda login emails" },
      { name: "Agoda", description: "Agoda property check jobs" },
    ],
  },
  apis: ["./src/app/*.ts"], // Path to the API docs
};

const specs = swaggerJsdoc(options);

export { specs, swaggerUi };
