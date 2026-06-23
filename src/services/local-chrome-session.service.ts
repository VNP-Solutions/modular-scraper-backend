import fs from "fs";
import os from "os";
import path from "path";
import puppeteer, { Browser, LaunchOptions, Page } from "puppeteer";
import { dualLogInfo } from "../common/log-helper.js";

export class LocalChromeSessionService {
  isEnabled(): boolean {
    return process.env.LOCAL_BROWSER === "true";
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Chrome user-data profile directory per Booking login email (cookies, localStorage, etc.).
   */
  getUserDataDirForEmail(email: string): string {
    const baseDir =
      process.env.LOCAL_BROWSER_USER_DATA_DIR?.trim() ||
      path.join(os.homedir(), ".local-chrome-profiles", "booking");

    const safeName = this.normalizeEmail(email).replace(/[^a-z0-9._-]+/g, "_");
    const profileDir = path.join(baseDir, safeName);
    fs.mkdirSync(profileDir, { recursive: true });
    return profileDir;
  }

  getDefaultProfileEmail(): string {
    return (
      process.env.LOCAL_BROWSER_DEFAULT_EMAIL?.trim().toLowerCase() || "default"
    );
  }

  resolveProfileEmail(loginEmail?: string | null): string {
    if (loginEmail?.trim()) {
      return loginEmail.trim();
    }
    return this.getDefaultProfileEmail();
  }

  buildLaunchOptions(userDataDir: string): LaunchOptions {
    const args = [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ];

    const options: LaunchOptions = {
      headless: process.env.LOCAL_BROWSER_HEADLESS === "true",
      defaultViewport: null,
      userDataDir,
      args,
      ignoreDefaultArgs: ["--enable-automation"],
    };

    const executablePath = process.env.LOCAL_CHROME_PATH?.trim();
    if (executablePath) {
      options.executablePath = executablePath;
    } else {
      options.channel = "chrome";
    }

    return options;
  }

  async launchForEmail(loginEmail?: string | null): Promise<{
    browser: Browser;
    page: Page;
    profileEmail: string;
    userDataDir: string;
    reusedProfile: boolean;
  }> {
    const profileEmail = this.resolveProfileEmail(loginEmail);
    const userDataDir = this.getUserDataDirForEmail(profileEmail);
    const reusedProfile = fs.existsSync(path.join(userDataDir, "Default"));

    await dualLogInfo("Launching system Chrome with persisted user profile", {
      profileEmail,
      userDataDir,
      reusedProfile,
      channel: process.env.LOCAL_CHROME_PATH ? "executablePath" : "chrome",
    });

    const browser = await puppeteer.launch(this.buildLaunchOptions(userDataDir));
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    return { browser, page, profileEmail, userDataDir, reusedProfile };
  }
}

export const localChromeSessionService = new LocalChromeSessionService();
