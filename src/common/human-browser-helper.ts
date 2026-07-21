import type { Page } from "puppeteer";
import { delay } from "./delay.js";

export function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function randomPause(minMs: number, maxMs: number): Promise<void> {
  await delay(randomBetween(minMs, maxMs));
}

function cubicBezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number
): number {
  const u = 1 - t;
  return (
    u * u * u * p0 +
    3 * u * u * t * p1 +
    3 * u * t * t * p2 +
    t * t * t * p3
  );
}

/**
 * Move mouse along a cubic bezier curve (FWCIM GesturalTelemetryCollector expects curves).
 */
export async function moveMouseBezier(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<void> {
  const cp1x = fromX + randomBetween(-90, 90);
  const cp1y = fromY + randomBetween(-70, 70);
  const cp2x = toX + randomBetween(-90, 90);
  const cp2y = toY + randomBetween(-70, 70);
  const steps = randomBetween(18, 32);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(cubicBezier(t, fromX, cp1x, cp2x, toX));
    const y = Math.round(cubicBezier(t, fromY, cp1y, cp2y, toY));
    await page.mouse.move(x, y);
    await delay(randomBetween(8, 28));
  }
}

/**
 * Type text with variable per-key delays (FWCIM FormInputTelemetryCollector: 50–200ms).
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 0 });
    await delay(randomBetween(50, 200));
  }
}

/**
 * Move the cursor through random waypoints using bezier curves.
 */
export async function simulateHumanMouseMove(page: Page): Promise<void> {
  const viewport = page.viewport();
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 900;

  const waypoints = randomBetween(2, 4);
  let x = randomBetween(60, Math.max(61, width - 60));
  let y = randomBetween(60, Math.max(61, height - 60));

  for (let i = 0; i < waypoints; i++) {
    const targetX = randomBetween(40, Math.max(41, width - 40));
    const targetY = randomBetween(40, Math.max(41, height - 40));
    await moveMouseBezier(page, x, y, targetX, targetY);
    x = targetX;
    y = targetY;
    await randomPause(100, 350);
  }
}

/**
 * Light scroll — a few small steps down, brief pause, scroll back up.
 */
export async function scrollHumanLike(page: Page): Promise<void> {
  const downSteps = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < downSteps; i++) {
    const px = 150 + Math.floor(Math.random() * 200);
    await page.evaluate((y) => window.scrollBy(0, y), px);
    await randomPause(250, 500);
  }

  await randomPause(400, 900);

  const upSteps = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < upSteps; i++) {
    const px = 150 + Math.floor(Math.random() * 200);
    await page.evaluate((y) => window.scrollBy(0, -y), px);
    await randomPause(200, 400);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Scroll down/up in small random steps for a total random duration (defaults
 * to 1–5s). Used to look human while parked on a list page between opening
 * reservation detail tabs.
 */
export async function randomScrollForDuration(
  page: Page,
  minMs: number = 1000,
  maxMs: number = 5000
): Promise<void> {
  const totalMs = randomBetween(minMs, maxMs);
  const start = Date.now();
  let direction = 1;

  while (Date.now() - start < totalMs) {
    const px = 100 + Math.floor(Math.random() * 250);
    try {
      await page.evaluate((y) => window.scrollBy(0, y), px * direction);
    } catch {
      // Page may be mid-navigation or closed — stop scrolling early.
      return;
    }

    // Occasionally reverse so it doesn't scroll only one way.
    if (Math.random() < 0.3) direction *= -1;

    const remaining = totalMs - (Date.now() - start);
    if (remaining <= 0) break;
    await randomPause(200, Math.min(500, Math.max(50, remaining)));
  }
}

/**
 * Quick human-like interaction on the current page: mouse move + scroll + optional
 * hover over the card table. Keeps total extra time modest (~2–4s).
 */
export async function simulateHumanOnPage(page: Page): Promise<void> {
  try {
    await simulateHumanMouseMove(page);
    await scrollHumanLike(page);

    const cardTable = await page.$("table.table-condensed");
    if (cardTable) {
      const box = await cardTable.boundingBox();
      if (box) {
        const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
        const targetY = box.y + box.height * (0.2 + Math.random() * 0.5);
        const viewport = page.viewport();
        const startX = (viewport?.width ?? 1280) / 2;
        const startY = (viewport?.height ?? 900) / 2;
        await moveMouseBezier(page, startX, startY, targetX, targetY);
        await randomPause(300, 700);
      }
    }
  } catch {
    // Non-fatal
  }

  await randomPause(400, 900);
}
