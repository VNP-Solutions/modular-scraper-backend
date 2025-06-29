import dotenv from "dotenv";
import mongoose from "mongoose";
import open from "open";
import app from "./app/app.js";
import loadToken from "./common/load-token.js";
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

// * Server listening port functionality
app.listen(port, async () => {
  try {
    await connectDB();

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
