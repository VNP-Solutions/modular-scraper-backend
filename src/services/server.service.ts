import dotenv from "dotenv";
import { Server } from "../models/server.model.js";

dotenv.config();

export class ServerService {
  private serverUrl: string | null = null;

  constructor() {
    this.serverUrl = process.env.MAIN_BACKEND_URL || null;
  }

  /**
   * Find server by URL matching MAIN_BACKEND_URL
   */
  private async findServerByUrl(): Promise<any | null> {
    if (!this.serverUrl) {
      console.log("MAIN_BACKEND_URL not configured, skipping server tracking");
      return null;
    }

    try {
      const server = await Server.findOne({ url: this.serverUrl });
      if (!server) {
        console.log(
          `Server not found for URL: ${this.serverUrl}. Job count tracking disabled.`
        );
        return null;
      }
      return server;
    } catch (error) {
      console.error("Error finding server by URL:", error);
      return null;
    }
  }

  /**
   * Increment job_count when a job starts
   */
  async incrementJobCount(): Promise<void> {
    try {
      const server = await this.findServerByUrl();
      if (!server) return;

      await Server.findByIdAndUpdate(server._id, {
        $inc: { job_count: 1 },
      });

      console.log(
        `✅ Incremented job_count for server: ${server.name} (${server.url})`
      );
    } catch (error) {
      console.error("Error incrementing server job_count:", error);
    }
  }

  /**
   * Decrement job_count when a job completes or fails
   */
  async decrementJobCount(): Promise<void> {
    try {
      const server = await this.findServerByUrl();
      if (!server) return;

      // Ensure job_count doesn't go below 0
      await Server.findOneAndUpdate(
        { _id: server._id, job_count: { $gt: 0 } },
        { $inc: { job_count: -1 } }
      );

      console.log(
        `✅ Decremented job_count for server: ${server.name} (${server.url})`
      );
    } catch (error) {
      console.error("Error decrementing server job_count:", error);
    }
  }

  /**
   * Get current server job count
   */
  async getCurrentJobCount(): Promise<number> {
    try {
      const server = await this.findServerByUrl();
      if (!server) return 0;

      return server.job_count || 0;
    } catch (error) {
      console.error("Error getting current job count:", error);
      return 0;
    }
  }
}

// Export singleton instance
export const serverService = new ServerService();
