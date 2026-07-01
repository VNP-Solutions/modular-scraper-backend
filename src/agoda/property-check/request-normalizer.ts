import mongoose from "mongoose";
import { AgodaPropertyToCheck } from "./property-check.js";

export interface NormalizedAgodaCheckRequest {
  agoda_ids: AgodaPropertyToCheck[];
  /** Property `_id` values from the request (for logging / correlation). */
  property_ids: string[];
  /**
   * Internal worker + OTP session id. Uses the first property `_id` when it is a
   * valid ObjectId so it matches what the caller sent — not a random job id.
   */
  checkSessionId: string;
}

function readPropertyId(entry: Record<string, unknown>): string | undefined {
  const id = entry._id ?? entry.property_id ?? entry.id;
  if (id === undefined || id === null) {
    return undefined;
  }
  return String(id);
}

/**
 * Normalizes check-properties body shapes into `{ _id, agoda_id }[]`.
 * Accepts `_id`, `property_id`, or top-level single-property fields.
 */
export function normalizeAgodaCheckRequest(body: any): {
  ok: true;
  data: NormalizedAgodaCheckRequest;
} | {
  ok: false;
  message: string;
} {
  let rawList: unknown[] | undefined;

  if (Array.isArray(body?.agoda_ids) && body.agoda_ids.length > 0) {
    rawList = body.agoda_ids;
  } else if (body?.property_id !== undefined && body?.agoda_id !== undefined) {
    rawList = [{ property_id: body.property_id, agoda_id: body.agoda_id }];
  }

  if (!rawList || rawList.length === 0) {
    return {
      ok: false,
      message:
        "agoda_ids must be a non-empty array of { _id, agoda_id } objects (or send property_id + agoda_id for a single property)",
    };
  }

  const agoda_ids: AgodaPropertyToCheck[] = [];

  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        message: "Each agoda_ids entry must be an object with _id and agoda_id",
      };
    }

    const record = entry as Record<string, unknown>;
    const _id = readPropertyId(record);
    const agoda_id = record.agoda_id;

    if (_id === undefined || agoda_id === undefined) {
      return {
        ok: false,
        message:
          "Each entry must include property _id (or property_id) and agoda_id",
      };
    }

    if (!mongoose.Types.ObjectId.isValid(_id)) {
      return {
        ok: false,
        message: `Invalid property _id: ${_id}`,
      };
    }

    agoda_ids.push({ _id, agoda_id: agoda_id as string | number });
  }

  const property_ids = agoda_ids.map((p) => p._id);
  const checkSessionId = property_ids[0];

  return {
    ok: true,
    data: { agoda_ids, property_ids, checkSessionId },
  };
}
