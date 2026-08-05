import mongoose from "mongoose";
import { Property } from "../models/property.model.js";

export type OtaPlatform = "expedia" | "agoda" | "booking";

export type OtaVerificationPatch = {
  credential_verified?: boolean;
  access_level?: boolean;
};

function credentialField(platform: OtaPlatform): string {
  return `${platform}_credential_verified`;
}

function accessField(platform: OtaPlatform): string {
  return `${platform}_access_level`;
}

function buildSetPayload(
  platform: OtaPlatform,
  fields: OtaVerificationPatch
): Record<string, boolean> | null {
  const $set: Record<string, boolean> = {};

  if (fields.credential_verified !== undefined) {
    $set[credentialField(platform)] = fields.credential_verified;
  }
  if (fields.access_level !== undefined) {
    $set[accessField(platform)] = fields.access_level;
  }

  return Object.keys($set).length > 0 ? $set : null;
}

/**
 * Partially updates only the credential/access verification flags for one OTA
 * platform on a property document. Uses the native MongoDB collection with
 * `$set` so no other OTA fields (or any other property fields) are touched.
 */
export async function patchOtaVerificationFields(
  platform: OtaPlatform,
  propertyId: string,
  fields: OtaVerificationPatch
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const $set = buildSetPayload(platform, fields);
  if (!$set) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  const result = await Property.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(propertyId) },
    { $set }
  );

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

/**
 * Same as {@link patchOtaVerificationFields} but for many properties at once.
 */
export async function patchManyOtaVerificationFields(
  platform: OtaPlatform,
  propertyIds: string[],
  fields: OtaVerificationPatch
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const $set = buildSetPayload(platform, fields);
  if (!$set || propertyIds.length === 0) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  const ids = propertyIds.map((id) => new mongoose.Types.ObjectId(id));
  const result = await Property.collection.updateMany(
    { _id: { $in: ids } },
    { $set }
  );

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}
