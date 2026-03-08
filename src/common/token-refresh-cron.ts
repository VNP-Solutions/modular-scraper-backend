import dotenv from "dotenv";
import { schedule, ScheduledTask } from "node-cron";
import { forceRefreshToken } from "./load-token.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";

dotenv.config();

let cronTask: ScheduledTask | null = null;
let isRefreshing = false;

/**
 * Runs the token refresh logic.
 * Uses a lock to prevent overlapping executions if a refresh takes too long.
 */
async function runTokenRefresh(): Promise<void> {
  if (isRefreshing) {
    await dualLogWarn(
      "Token refresh already in progress, skipping this tick",
      {}
    );
    return;
  }

  isRefreshing = true;
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";
    await dualLogInfo("Cron: starting scheduled Google OAuth2 token refresh", {
      tokenPath,
      time: new Date().toISOString(),
    });

    const success = await forceRefreshToken(tokenPath);

    if (success) {
      await dualLogInfo(
        "Cron: Google OAuth2 token refreshed successfully",
        { time: new Date().toISOString() }
      );
    } else {
      await dualLogWarn(
        "Cron: Google OAuth2 token refresh returned false — token may be missing or refresh_token unavailable",
        { time: new Date().toISOString() }
      );
    }
  } catch (error) {
    await dualLogError(
      "Cron: unexpected error during scheduled token refresh",
      error,
      { time: new Date().toISOString() }
    );
  } finally {
    isRefreshing = false;
  }
}

/**
 * Starts the every-2-hour Google OAuth2 token refresh cron job.
 * Runs at minute 0 of every 2nd hour: 00:00, 02:00, 04:00 … 22:00.
 * Also performs an immediate refresh on startup so the token is fresh right away.
 */
export function startTokenRefreshCron(): void {
  if (cronTask) {
    dualLogWarn("Token refresh cron is already running", {});
    return;
  }

  // Run once immediately on startup
  runTokenRefresh().catch((err) =>
    dualLogError("Cron: initial token refresh failed", err, {})
  );

  // Schedule: every 2 hours (0 */2 * * *)
  cronTask = schedule("0 */2 * * *", runTokenRefresh, {
    timezone: "UTC",
  });

  dualLogInfo(
    "Token refresh cron job started — runs every 2 hours (0 */2 * * * UTC)",
    {}
  );
}

/**
 * Stops the cron job (used during graceful shutdown).
 */
export function stopTokenRefreshCron(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    dualLogInfo("Token refresh cron job stopped", {});
  }
}
