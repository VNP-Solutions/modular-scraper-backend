import dotenv from "dotenv";
import mongoose from "mongoose";
import open from "open";
import { isMainThread } from "worker_threads";
import app from "./app/app.js";
import { loadAndSetCredentials } from "./common/load-token.js";
import { setCurrentWorkerId } from "./common/log-helper.js";
import { otpAwareWorkerPool } from "./common/otp-aware-worker-pool.js";
dotenv.config();

// Set main thread ID for system tasks (schedulers, cron, API calls)
if (isMainThread) {
  setCurrentWorkerId("Thread-1");
}

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
    // Shutdown worker pool first
    console.log("Shutting down worker pool...");
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
    console.log(`Server is listening on port ${port}`);
    console.log(
      `Worker pool initialized with ${
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
  console.error("=== UNCAUGHT EXCEPTION DEBUG ===");
  console.error("Error type:", typeof error);
  console.error("Error constructor:", error.constructor.name);
  console.error("Error message:", error.message || "No message available");
  console.error("Error stack:", error.stack || "No stack available");
  console.error("Raw error:", error);
  console.error("Error keys:", Object.keys(error));
  console.error("Error values:", Object.values(error));

  try {
    console.error("Stringified error:", JSON.stringify(error, null, 2));
  } catch (e) {
    console.error("Failed to stringify error:", e);
  }

  console.error("=== END DEBUG ===");
  await gracefulShutdown("uncaughtException");
});

// * Handle unhandled promise rejections
process.on("unhandledRejection", async (reason, promise) => {
  console.error("=== UNHANDLED REJECTION DEBUG ===");
  console.error("Promise:", promise);
  console.error("Reason type:", typeof reason);
  console.error("Reason:", reason);

  if (reason && typeof reason === "object") {
    console.error("Reason constructor:", reason.constructor.name);
    console.error(
      "Reason message:",
      (reason as any).message || "No message available"
    );
    console.error(
      "Reason stack:",
      (reason as any).stack || "No stack available"
    );
  }

  console.error("=== END DEBUG ===");
  await gracefulShutdown("unhandledRejection");
});
