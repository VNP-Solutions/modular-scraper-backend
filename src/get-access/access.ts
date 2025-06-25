import { Request, Response } from "express";
import fs from "fs";
import { getAuthUrl, oauth2Client } from "../config/google-config.js";

export async function getAccess(req: Request, res: Response) {
  try {
    const authUrl = getAuthUrl();
    res.redirect(authUrl);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
}

export async function getOauth2Callback(req: Request, res: Response) {
  try {
    const code = req.query.code;
    if (!code) {
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
      res.status(500).send("Error retrieving access token: " + error.message);
    }
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
}
