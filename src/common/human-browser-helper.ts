import type { Page } from "puppeteer";
import { delay } from "./delay.js";

export function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function randomPause(minMs: number, maxMs: number): Promise<void> {
  await delay(randomBetween(minMs, maxMs));
}

/**
 * Move the cursor through a few random waypoints with small step delays.
 */
export async function simulateHumanMouseMove(page: Page): Promise<void> {
  const viewport = page.viewport();
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 900;

  const waypoints = randomBetween(2, 3);
  let x = randomBetween(60, Math.max(61, width - 60));
  let y = randomBetween(60, Math.max(61, height - 60));

  for (let i = 0; i < waypoints; i++) {
    const targetX = randomBetween(40, Math.max(41, width - 40));
    const targetY = randomBetween(40, Math.max(41, height - 40));
    const moveSteps = randomBetween(8, 16);

    for (let step = 0; step < moveSteps; step++) {
      const t = (step + 1) / moveSteps;
      const nextX = Math.round(x + (targetX - x) * t);
      const nextY = Math.round(y + (targetY - y) * t);
      await page.mouse.move(nextX, nextY);
      await delay(randomBetween(12, 35));
    }

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
        await page.mouse.move(
          box.x + box.width * (0.3 + Math.random() * 0.4),
          box.y + box.height * (0.2 + Math.random() * 0.5),
          { steps: randomBetween(8, 16) }
        );
        await randomPause(300, 700);
      }
    }
  } catch {
    // Non-fatal
  }

  await randomPause(400, 900);
}
