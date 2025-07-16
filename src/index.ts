import dotenv from "dotenv";
import mongoose from "mongoose";
import open from "open";
import app from "./app/app.js";
import loadToken from "./common/load-token.js";
import { jobQueueUrlService } from "./services/job-queue-url.service.js";
dotenv.config();

const port: number = parseInt(process.env.PORT || "3000");

// * MongoDB connection function
const connectDB = async (): Promise<void> => {
  try {
    const DATABASE_URI = process.env.DATABASE_URI;

    if (!DATABASE_URI) {
      throw new Error("DATABASE_URI environment variable is not defined");
    }

    await mongoose.connect(DATABASE_URI);
    console.log("Connected to MongoDB successfully");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
};

// * Initialize job queue URLs on startup
const initializeJobQueueUrls = async (): Promise<void> => {
  try {
    console.log("Initializing job queue URLs...");

    // Show URL statistics (URLs are managed by another project)
    const stats = await jobQueueUrlService.getUrlStatistics();
    console.log("Job Queue URL Statistics:", stats);

    console.log(
      "✅ URL status monitoring initialized. URLs are managed by another project."
    );
  } catch (err) {
    console.error("Error initializing job queue URLs:", err);
    // Don't exit the process, as this is not critical for server startup
  }
};

// * MongoDB disconnection function
const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  } catch (err) {
    console.error("Error disconnecting from MongoDB:", err);
  }
};

// * Server listening port functionality
app.listen(port, async () => {
  try {
    await connectDB();

    // Initialize job queue URLs after database connection
    await initializeJobQueueUrls();

    if (!loadToken(process.env.TOKEN_PATH || "token.json")) {
      console.log("Opening browser for authentication...");
      open(`http://localhost:${port}/auth`);
    }
    console.log(`Server is listening on port ${port}`);
  } catch (err) {
    console.log("Server cannot be connected because of the error:");
    console.log(err);
    process.exit(1);
  }
});

// * Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT. Graceful shutdown...");
  await disconnectDB();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM. Graceful shutdown...");
  await disconnectDB();
  process.exit(0);
});
