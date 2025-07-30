import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";

dotenv.config();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const port = process.env.PORT;
const REDIRECT_URI = `http://localhost:${port}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

//load google auth json file
function loadToken(tokenPath: string) {
  try {
    if (fs.existsSync(tokenPath) && fs.statSync(tokenPath).isFile()) {
      const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
      oauth2Client.setCredentials(token);
      return true;
    }
  } catch (error) {
    console.log(`Token loading failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  return false;
}

export default loadToken;