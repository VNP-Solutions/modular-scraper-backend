import { Request, Response } from "express";
import fs from "fs";
import { getAuthUrl, oauth2Client } from "../config/google-config.js";

export async function getAccess(req: Request, res: Response) {
  try {
    const authUrl = getAuthUrl();
    res.redirect(authUrl);
  } catch (error: any) {
    console.error("Error getting OAuth access URL:", error);
    
    // Send email notification for OAuth access error
    try {    } catch (emailError) {
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
      try {      } catch (emailError) {
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
      try {      } catch (emailError) {
        console.error("Failed to send OAuth token error notification:", emailError);
      }
      
      res.status(500).send("Error retrieving access token: " + error.message);
    }
  } catch (error: any) {
    console.error("Error in OAuth callback:", error);
    
    // Send email notification for general OAuth callback error
    try {    } catch (emailError) {
      console.error("Failed to send OAuth callback error notification:", emailError);
    }
    
    res.status(500).json({ message: error.message });
  }
}
