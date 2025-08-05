import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { oauth2Client } from "../config/google-config.js";

dotenv.config();

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

export async function getVerificationCode(): Promise<string | null> {
  try {
    const credentialsLoaded = await loadCredentials();
    if (!credentialsLoaded) {
      throw new Error(
        "Failed to load Gmail credentials. Please complete authentication setup first."
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    if (!res.data.messages) {
      await dualLogInfo("No new emails found.");
      return null;
    }

    for (const msg of res.data.messages) {
      if (!msg.id) {
        continue;
      }

      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
      });

      const body = email.data.snippet || "";
      await dualLogInfo("Email body:", body);
      const codeMatch = body.match(/\b\d{6,10}\b/);
      await dualLogInfo("Code match:", codeMatch);

      if (codeMatch) {
        return codeMatch[0];
      }
    }

    await dualLogInfo("No verification code found in recent emails.");
    return null;
  } catch (error: any) {
    await dualLogError("Error fetching emails:", error.message);
    return null;
  }
}