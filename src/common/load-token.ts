import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";

dotenv.config();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const port = process.env.PORT;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

export interface GoogleTokenData {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

// Track last refresh time
let lastRefreshTime: Date | null = null;

/**
 * Original load google auth json file function (maintained for backward compatibility)
 */
function loadToken(tokenPath: string): boolean {
  try {
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
      oauth2Client.setCredentials(token);
      return true;
    }
   } catch (error) {
    console.log(`Token loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
   }
  return false;
}

/**
 * Load Google OAuth2 token with enhanced error handling and validation
 */
export async function loadTokenData(
  tokenPath: string
): Promise<GoogleTokenData | null> {
  try {
    if (!fs.existsSync(tokenPath)) {
      await dualLogWarn(
        `Google OAuth2 token file not found at ${tokenPath}`,
        {}
      );
      return null;
    }

    const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf8"));

    // Validate required fields
    if (!tokenData.access_token) {
      throw new Error("Invalid token data: missing access_token");
    }

    await dualLogInfo("Google OAuth2 token loaded successfully", {
      tokenPath,
      hasRefreshToken: !!tokenData.refresh_token,
      expiryDate: tokenData.expiry_date
        ? new Date(tokenData.expiry_date).toISOString()
        : null,
      scope: tokenData.scope,
    });

    return tokenData;
  } catch (error) {
    await dualLogError("Error loading Google OAuth2 token:", error, {
      tokenPath,
    });
    return null;
  }
}

/**
 * Save Google OAuth2 token to file
 */
export async function saveTokenData(
  tokenPath: string,
  tokenData: GoogleTokenData
): Promise<boolean> {
  try {
    // Save token data with proper formatting
    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));

    await dualLogInfo("Google OAuth2 token saved successfully", {
      tokenPath,
      hasRefreshToken: !!tokenData.refresh_token,
      expiryDate: tokenData.expiry_date
        ? new Date(tokenData.expiry_date).toISOString()
        : null,
    });

    return true;
  } catch (error) {
    await dualLogError("Error saving Google OAuth2 token:", error, {
      tokenPath,
    });
    return false;
  }
}

/**
 * Check if Google OAuth2 token needs refresh (expires within next 5 minutes)
 */
export async function needsTokenRefresh(tokenPath: string): Promise<boolean> {
  try {
    const tokenData = await loadTokenData(tokenPath);
    if (!tokenData || !tokenData.expiry_date) {
      await dualLogWarn("No token data or expiry date found", {});
      return false;
    }

    const now = Date.now();
    const expiryTime = tokenData.expiry_date;
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer

    const needsRefresh = expiryTime - now <= bufferTime;

    await dualLogInfo("Google OAuth2 token refresh check completed", {
      needsRefresh,
      expiryDate: new Date(expiryTime).toISOString(),
      timeUntilExpiry: Math.round((expiryTime - now) / 1000 / 60), // minutes
      bufferMinutes: bufferTime / 1000 / 60,
    });

    return needsRefresh;
  } catch (error) {
    await dualLogError(
      "Error checking if Google OAuth2 token needs refresh:",
      error
    );
    return false;
  }
}

/**
 * Refresh Google OAuth2 access token using refresh token
 */
export async function refreshGoogleToken(tokenPath: string): Promise<boolean> {
  try {
    const tokenData = await loadTokenData(tokenPath);
    if (!tokenData) {
      await dualLogError("No Google OAuth2 token data found for refresh", {});
      return false;
    }

    if (!tokenData.refresh_token) {
      await dualLogError(
        "No refresh token available. Please re-authenticate with offline access.",
        {}
      );
      return false;
    }

    await dualLogInfo("Starting Google OAuth2 token refresh process", {
      hasRefreshToken: !!tokenData.refresh_token,
      currentExpiry: tokenData.expiry_date
        ? new Date(tokenData.expiry_date).toISOString()
        : null,
    });

    // Set current credentials to oauth2Client
    oauth2Client.setCredentials(tokenData);

    // Use Google's OAuth2 client to refresh the access token
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error("Failed to get new access token from Google");
    }

    // Create updated token data
    const updatedTokenData: GoogleTokenData = {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token || tokenData.refresh_token, // Keep existing if not provided
      scope: credentials.scope || tokenData.scope,
      token_type: credentials.token_type || tokenData.token_type || "Bearer",
      expiry_date: credentials.expiry_date || undefined,
    };

    // Save updated token data to file
    const saved = await saveTokenData(tokenPath, updatedTokenData);
    if (!saved) {
      throw new Error("Failed to save refreshed Google OAuth2 token");
    }

    // Update OAuth2 client with new credentials
    oauth2Client.setCredentials(updatedTokenData);

    lastRefreshTime = new Date();

    await dualLogInfo("Google OAuth2 token refresh completed successfully", {
      newExpiry: updatedTokenData.expiry_date
        ? new Date(updatedTokenData.expiry_date).toISOString()
        : null,
      refreshTime: lastRefreshTime.toISOString(),
    });

    return true;
  } catch (error) {
    await dualLogError("Error refreshing Google OAuth2 token:", error);
    return false;
  }
}

/**
 * Auto-refresh Google OAuth2 token if needed (main function to call)
 */
export async function autoRefreshToken(
  tokenPath: string = process.env.TOKEN_PATH || "token.json"
): Promise<boolean> {
  try {
    if (!fs.existsSync(tokenPath)) {
      await dualLogWarn(
        "Google OAuth2 token file does not exist, skipping auto-refresh",
        {
          tokenPath,
        }
      );
      return false;
    }

    const needsRefresh = await needsTokenRefresh(tokenPath);
    if (!needsRefresh) {
      await dualLogInfo("Google OAuth2 token does not need refresh", {
        lastRefreshTime: lastRefreshTime?.toISOString() || null,
      });
      return true;
    }

    await dualLogInfo(
      "Google OAuth2 token needs refresh, starting auto-refresh process",
      {}
    );
    return await refreshGoogleToken(tokenPath);
  } catch (error) {
    await dualLogError("Error in auto-refresh Google OAuth2 token:", error);
    return false;
  }
}

/**
 * Load Google OAuth2 credentials and set them on oauth2Client with auto-refresh
 */
export async function loadAndSetCredentials(
  tokenPath: string = process.env.TOKEN_PATH || "token.json"
): Promise<boolean> {
  try {
    // First try to auto-refresh if needed
    await autoRefreshToken(tokenPath);

    const tokenData = await loadTokenData(tokenPath);
    if (!tokenData) {
      throw new Error(
        `Google OAuth2 token file not found at ${tokenPath}. Please run the authentication setup first.`
      );
    }

    if (!tokenData.refresh_token) {
      throw new Error(
        "No refresh token found. Please re-authenticate with offline access."
      );
    }

    oauth2Client.setCredentials(tokenData);
    await dualLogInfo("Google OAuth2 credentials loaded and set successfully");
    return true;
  } catch (error) {
    await dualLogError(
      "Error loading and setting Google OAuth2 credentials:",
      error
    );
    return false;
  }
}

/**
 * Get token refresh status info
 */
export function getTokenRefreshInfo(): any {
  const tokenPath = process.env.TOKEN_PATH || "token.json";
  return {
    tokenPath,
    lastRefreshTime: lastRefreshTime?.toISOString() || null,
    tokenExists: fs.existsSync(tokenPath),
  };
}

/**
 * Force refresh Google OAuth2 token (for manual/testing purposes)
 */
export async function forceRefreshToken(
  tokenPath: string = process.env.TOKEN_PATH || "token.json"
): Promise<boolean> {
  await dualLogInfo("Forcing Google OAuth2 token refresh", {});
  return await refreshGoogleToken(tokenPath);
}

// Export the oauth2Client for use in other modules
export { oauth2Client };

// Default export maintains backward compatibility
export default loadToken;
