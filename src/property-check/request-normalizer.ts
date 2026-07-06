import mongoose from "mongoose";
import { PropertyToCheck } from "./property-check.js";

export interface NormalizedExpediaCheckRequest {
  expedia_ids: PropertyToCheck[];
  property_ids: string[];
}

function readPropertyId(entry: Record<string, unknown>): string | undefined {
  const id = entry._id ?? entry.property_id ?? entry.id;
  if (id === undefined || id === null) {
    return undefined;
  }
  return String(id);
}

function isValidObjectId(id: string): boolean {
  return (
    mongoose.Types.ObjectId.isValid(id) &&
    new mongoose.Types.ObjectId(id).toString() === id
  );
}

/**
 * Normalizes check-properties body shapes into `{ _id, expedia_id }[]`.
 */
export function normalizeExpediaCheckRequest(body: any): {
  ok: true;
  data: NormalizedExpediaCheckRequest;
} | {
  ok: false;
  message: string;
} {
  let rawList: unknown[] | undefined;

  if (Array.isArray(body?.expedia_ids) && body.expedia_ids.length > 0) {
    rawList = body.expedia_ids;
  } else if (body?.property_id !== undefined && body?.expedia_id !== undefined) {
    rawList = [{ property_id: body.property_id, expedia_id: body.expedia_id }];
  }

  if (!rawList || rawList.length === 0) {
    return {
      ok: false,
      message:
        "expedia_ids must be a non-empty array of { _id, expedia_id } objects (or send property_id + expedia_id for a single property)",
    };
  }

  const expedia_ids: PropertyToCheck[] = [];

  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        message: "Each expedia_ids entry must be an object with _id and expedia_id",
      };
    }

    const record = entry as Record<string, unknown>;
    const _id = readPropertyId(record);
    const expedia_id = record.expedia_id;

    if (_id === undefined || expedia_id === undefined) {
      return {
        ok: false,
        message:
          "Each entry must include property _id (or property_id) and expedia_id",
      };
    }

    if (!isValidObjectId(_id)) {
      return {
        ok: false,
        message: `Invalid property _id: ${_id}`,
      };
    }

    expedia_ids.push({ _id, expedia_id: expedia_id as string | number });
  }

  return {
    ok: true,
    data: {
      expedia_ids,
      property_ids: expedia_ids.map((p) => p._id),
    },
  };
}
