import fs from "fs";
import path from "path";
import type { Page } from "puppeteer";
import { dualLogInfo, dualLogWarn } from "./log-helper.js";

/**
 * Simple file-based cookie persistence so Akamai / bot-manager sessions
 * (_abck, bm_sz, ak_bmsc, etc.) survive across runs. Passing a known-good
 * session cookie dramatically lowers the chance of being challenged.
 */

const COOKIE_DIR = path.resolve(process.cwd(), ".cookies");

function cookiePath(key: string) {
  return path.join(COOKIE_DIR, `${key}.json`);
}

export async function saveCookies(page: Page, key: string): Promise<void> {
  try {
    if (!fs.existsSync(COOKIE_DIR)) {
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
    }
    const cookies = await page.cookies();
    fs.writeFileSync(cookiePath(key), JSON.stringify(cookies, null, 2));
    await dualLogInfo(`Saved ${cookies.length} cookies for key=${key}`);
  } catch (err: any) {
    await dualLogWarn(`Failed to save cookies for key=${key}: ${err.message}`);
  }
}

export async function loadCookies(page: Page, key: string): Promise<boolean> {
  try {
    const file = cookiePath(key);
    if (!fs.existsSync(file)) return false;

    const raw = fs.readFileSync(file, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;

    // Filter out cookies that have already expired
    const now = Math.floor(Date.now() / 1000);
    const valid = cookies.filter(
      (c: any) => !c.expires || c.expires === -1 || c.expires > now
    );

    if (valid.length === 0) return false;

    await page.setCookie(...valid);
    await dualLogInfo(`Restored ${valid.length} cookies for key=${key}`);
    return true;
  } catch (err: any) {
    await dualLogWarn(`Failed to load cookies for key=${key}: ${err.message}`);
    return false;
  }
}

export function clearCookies(key: string): void {
  try {
    const file = cookiePath(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
