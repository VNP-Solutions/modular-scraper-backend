import type { Page } from "puppeteer";
import { delay } from "./delay.js";

/**
 * Helpers that make Puppeteer behave more like a human so Akamai's behavioral
 * sensor (which feeds the _abck cookie) can collect legitimate-looking events
 * before the login form is submitted.
 */

const rand = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

/** Sleep for a random amount between `min` and `max` ms. */
export const humanDelay = (min = 400, max = 1200) => delay(rand(min, max));

/**
 * Move the mouse along a jittery path to a roughly random point on the
 * viewport. Akamai collects `mousemove` events for bot scoring.
 */
export async function humanMouseWander(page: Page, moves = 6): Promise<void> {
  const viewport = page.viewport() ?? { width: 1280, height: 800 };
  let x = rand(100, viewport.width - 100);
  let y = rand(100, viewport.height - 100);

  for (let i = 0; i < moves; i++) {
    x += rand(-120, 120);
    y += rand(-80, 80);
    x = Math.max(10, Math.min(viewport.width - 10, x));
    y = Math.max(10, Math.min(viewport.height - 10, y));
    await page.mouse.move(x, y, { steps: rand(10, 25) });
    await humanDelay(80, 220);
  }
}

/** Scroll the page in small steps like a real person reading. */
export async function humanScroll(page: Page, totalSteps = 4): Promise<void> {
  for (let i = 0; i < totalSteps; i++) {
    const dy = rand(150, 400);
    await page.evaluate((y) => window.scrollBy(0, y), dy);
    await humanDelay(350, 900);
  }
  // Scroll back up a bit
  await page.evaluate(() => window.scrollBy(0, -200));
  await humanDelay(200, 500);
}

/**
 * Type a string with realistic per-character delays instead of the instant
 * `page.type(selector, text)` firehose which is easy to detect.
 */
export async function humanType(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  await page.focus(selector);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: rand(60, 160) });
  }
}
