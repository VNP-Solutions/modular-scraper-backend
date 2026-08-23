import mongoose from "mongoose";
import { Property } from "../models/property.model.js";
import { OtaPlatform } from "./ota-verification-patch.js";

export interface PropertyScreenshotEntry {
  step: string;
  url: string;
  timestamp: string;
  type: "step" | "error";
}

function screenshotField(platform: OtaPlatform): string {
  return `${platform}_screenshot_urls`;
}

function toObjectIds(propertyIds: string[]): mongoose.Types.ObjectId[] {
  const seen = new Set<string>();
  const ids: mongoose.Types.ObjectId[] = [];

  for (const id of propertyIds) {
    if (!id || seen.has(id)) continue;
    if (
      !mongoose.Types.ObjectId.isValid(id) ||
      new mongoose.Types.ObjectId(id).toString() !== id
    ) {
      continue;
    }
    seen.add(id);
    ids.push(new mongoose.Types.ObjectId(id));
  }

  return ids;
}

/**
 * Clears the screenshot list for one OTA platform on the given properties.
 *
 * Called once at the start of a check run so the stored screenshots always
 * describe the latest run rather than accumulating across every run.
 *
 * Uses the native collection with `$set` so no other property fields are
 * touched — same reasoning as `ota-verification-patch`.
 */
export async function clearPropertyScreenshots(
  platform: OtaPlatform,
  propertyIds: string[]
): Promise<void> {
  const ids = toObjectIds(propertyIds);
  if (ids.length === 0) return;

  await Property.collection.updateMany(
    { _id: { $in: ids } },
    { $set: { [screenshotField(platform)]: [] } }
  );
}

/**
 * Appends one screenshot entry to every given property.
 *
 * A single S3 upload is shared by all of them, so an account-level capture
 * (login, OTP) can be recorded against every property in the same check run
 * without re-uploading the image.
 */
export async function addPropertyScreenshot(
  platform: OtaPlatform,
  propertyIds: string[],
  entry: PropertyScreenshotEntry
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const ids = toObjectIds(propertyIds);
  if (ids.length === 0) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  // Computed-key $push needs a cast: the driver's PushOperator type cannot
  // resolve a dynamic field name to its array element type.
  const push = { [screenshotField(platform)]: entry } as Record<string, any>;

  const result = await Property.collection.updateMany(
    { _id: { $in: ids } },
    { $push: push }
  );

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}
