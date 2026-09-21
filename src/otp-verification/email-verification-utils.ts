import dotenv from "dotenv";
import fs from "fs";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

/**
 * Load stored Gmail OAuth2 credentials (refresh token) from disk and apply
 * them to the shared `oauth2Client`. Used by Trip.com's sign-in and VCC
 * verification flows (`trip-signin-verification.ts` / `trip-vcc-verification.ts`)
 * before any Gmail API call.
 */
export async function loadCredentials(): Promise<boolean> {
  try {
    const tokenPath = process.env.TOKEN_PATH || "token.json";

    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Token file not found at ${tokenPath}. Please run the authentication setup first.`
      );
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));

    if (!token.refresh_token) {
      throw new Error(
        "No refresh token found. Please re-authenticate with offline access."
      );
    }

    oauth2Client.setCredentials(token);
    await dualLogInfo("Gmail credentials loaded successfully");
    return true;
  } catch (error) {
    await dualLogError("Error loading credentials:", error);
    return false;
  }
}
