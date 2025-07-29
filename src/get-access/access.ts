import { Request, Response } from "express";
import fs from "fs";
import { getAuthUrl, oauth2Client } from "../config/google-config.js";
import { emailNotifier } from "../common/email-notifier.js";

export async function getAccess(req: Request, res: Response) {
  try {
    const authUrl = getAuthUrl();
    res.redirect(authUrl);
  } catch (error: any) {
    console.error("Error getting OAuth access URL:", error);
    
    // Send email notification for OAuth access error
    try {
      await emailNotifier.notifyJobError(
        `oauth_access_${Date.now()}`,
        `Failed to get OAuth access URL: ${error?.message || "OAuth access URL generation failed"}`,
        error,
        {
          stage: "oauth_access_url_generation",
          progressPercentage: 0,
        }
      );
    } catch (emailError) {
      console.error("Failed to send OAuth access error notification:", emailError);
    }
    
    res.status(500).json({ message: error.message });
  }
}

export async function getOauth2Callback(req: Request, res: Response) {
  try {
    const code = req.query.code;
    if (!code) {
      const error = new Error("Authorization code not found");
      
      // Send email notification for missing authorization code
      try {
        await emailNotifier.notifyJobError(
          `oauth_callback_${Date.now()}`,
          "OAuth callback missing authorization code",
          error,
          {
            stage: "oauth_callback_missing_code",
            progressPercentage: 0,
          }
        );
      } catch (emailError) {
        console.error("Failed to send OAuth missing code error notification:", emailError);
      }
      
      return res.status(400).send("Authorization code not found.");
    }
    
    try {
      const { tokens } = await oauth2Client.getToken(code as string);
      oauth2Client.setCredentials(tokens);
      fs.writeFileSync(
        process.env.TOKEN_PATH || "token.json",
        JSON.stringify(tokens)
      );
      res.send("Authentication successful! You can close this window.");
      // res.redirect(process.env.FRONTEND_REDIRECT_URI || 'http://localhost:3000');
    } catch (error: any) {
      console.error("Error retrieving access token:", error);
      
      // Send email notification for token retrieval error
      try {
        await emailNotifier.notifyJobError(
          `oauth_token_${Date.now()}`,
          `Failed to retrieve OAuth access token: ${error?.message || "Token retrieval failed"}`,
          error,
          {
            stage: "oauth_token_retrieval",
            progressPercentage: 0,
          }
        );
      } catch (emailError) {
        console.error("Failed to send OAuth token error notification:", emailError);
      }
      
      res.status(500).send("Error retrieving access token: " + error.message);
    }
  } catch (error: any) {
    console.error("Error in OAuth callback:", error);
    
    // Send email notification for general OAuth callback error
    try {
      await emailNotifier.notifyJobError(
        `oauth_callback_general_${Date.now()}`,
        `OAuth callback failed: ${error?.message || "Unknown OAuth callback error"}`,
        error,
        {
          stage: "oauth_callback_general",
          progressPercentage: 0,
        }
      );
    } catch (emailError) {
      console.error("Failed to send OAuth callback error notification:", emailError);
    }
    
    res.status(500).json({ message: error.message });
  }
}
