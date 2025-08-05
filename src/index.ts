import dotenv from "dotenv";
import mongoose from "mongoose";
import open from "open";
import app from "./app/app.js";
import loadToken from "./common/load-token.js";
import { workerPool } from "./common/worker-pool.js";
import { bookingTrustCron } from "./services/booking-trust-cron.service.js";
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
    // Stop booking trust cron scheduler
    console.log("Stopping booking trust scheduler...");
    bookingTrustCron.stop();

    // Shutdown worker pool first
    console.log("Shutting down worker pool...");
    await workerPool.shutdown();

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

    // Start booking trust scheduler after database connection
    console.log("Starting booking trust verification scheduler...");
    bookingTrustCron.start();

    if (!loadToken(process.env.TOKEN_PATH || "token.json")) {
      console.log("Opening browser for authentication...");
      open(`http://localhost:${port}/auth`);
    }
    console.log(`Server is listening on port ${port}`);
    console.log(
      `Worker pool initialized with ${
        workerPool.getStatus().totalWorkers
      } workers`
    );
    console.log("Booking trust verification scheduler started - running every hour");
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
