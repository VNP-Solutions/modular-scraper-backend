import dotenv from "dotenv";
import mongoose from "mongoose";
import open from "open";
import app from "./app/app.js";
import { loadAndSetCredentials } from "./common/load-token.js";
import { otpAwareWorkerPool } from "./common/otp-aware-worker-pool.js";
import {
  startTokenRefreshCron,
  stopTokenRefreshCron,
} from "./common/token-refresh-cron.js";
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

// * MongoDB disconnection function
const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  } catch (err) {
    console.error("Error disconnecting from MongoDB:", err);
  }
};

// * Graceful shutdown function
const gracefulShutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  try {
    // Stop token refresh cron first
    console.log("Stopping token refresh cron job...");
    stopTokenRefreshCron();

    // Shutdown worker pool first
    console.log("Shutting down OTP-aware worker pool...");
    await otpAwareWorkerPool.shutdown();

    // Disconnect from database
    console.log("Disconnecting from MongoDB...");
    await disconnectDB();

    console.log("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    console.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
};

// * Setup signal handlers for graceful shutdown
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// * Server listening port functionality
app.listen(port, async () => {
  try {
    await connectDB();

    const tokenPath = process.env.TOKEN_PATH || "token.json";
    const ok = await loadAndSetCredentials(tokenPath);
    if (!ok) {
      console.log("Opening browser for authentication...");
      open(`http://localhost:${port}/auth`);
    }

    // Start the every-2-hour token refresh cron job
    startTokenRefreshCron();

    console.log(`Server is listening on port ${port}`);
    console.log(
      `OTP-aware worker pool initialized with ${
        otpAwareWorkerPool.getStatus().totalWorkers
      } workers`
    );
  } catch (err) {
    console.log("Server cannot be connected because of the error:");
    console.log(err);
    process.exit(1);
  }
});

// * Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
  console.error("Uncaught Exception:", error);
  await gracefulShutdown("uncaughtException");
});

// * Handle unhandled promise rejections
process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  await gracefulShutdown("unhandledRejection");
});
