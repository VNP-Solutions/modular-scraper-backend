import dotenv from "dotenv";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import yaml from "yamljs";
import path from "path";
import fs from "fs";

dotenv.config();

const port = process.env.PORT || "3000";
const serverUrl = `http://localhost:${port}`;
const serverUrl2 = "https://modular-api-2.vnpmanage.online";
const serverUrl3 = process.env.SWAGGER_BASE_URL;

// Load external YAML files
function loadYamlDocs() {
  const docsDir = path.resolve("src/docs/");
  const files = fs.readdirSync(docsDir).filter(f => f.endsWith(".yaml"));
  const paths: any = {};
  for (const file of files) {
    const doc = yaml.load(path.join(docsDir, file));
    Object.assign(paths, doc);
  }

  return paths;
}

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Booking Property Check API",
      version: "1.0.0",
      description:
        "API documentation for the Booking.com property access check service",
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
      {
        url: serverUrl3,
        description: "Demo server",
      },
    ],
    components: {
      schemas: {
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
        name: "Booking Jobs",
        description: "Endpoints for checking Booking.com property access",
      },
    ],
    paths: loadYamlDocs(),
  },
  apis: ["./src/app/app.ts"],
};

const specs = swaggerJsdoc(options) as any;

export { specs, swaggerUi };
