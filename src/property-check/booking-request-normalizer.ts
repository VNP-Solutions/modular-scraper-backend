import mongoose from "mongoose";
import { BookingPropertyToCheck } from "./booking-property-check.js";

export interface NormalizedBookingCheckRequest {
  booking_ids: BookingPropertyToCheck[];
  property_ids: string[];
}

export type NormalizeResult =
  | { ok: true; data: NormalizedBookingCheckRequest }
  | { ok: false; message: string };

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
 * Normalizes check-properties body shapes into `{ _id, booking_id }[]`.
 *
 * Accepts either a `booking_ids` array or a single `property_id` +
 * `booking_id` pair.
 */
export function normalizeBookingCheckRequest(body: any): NormalizeResult {
  let rawList: unknown[] | undefined;

  if (Array.isArray(body?.booking_ids) && body.booking_ids.length > 0) {
    rawList = body.booking_ids;
  } else if (
    body?.property_id !== undefined &&
    body?.booking_id !== undefined
  ) {
    rawList = [{ property_id: body.property_id, booking_id: body.booking_id }];
  }

  if (!rawList || rawList.length === 0) {
    return {
      ok: false,
      message:
        "booking_ids must be a non-empty array of { _id, booking_id } objects (or send property_id + booking_id for a single property)",
    };
  }

  const booking_ids: BookingPropertyToCheck[] = [];

  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        message:
          "Each booking_ids entry must be an object with _id and booking_id",
      };
    }

    const record = entry as Record<string, unknown>;
    const _id = readPropertyId(record);
    const booking_id = record.booking_id;

    if (_id === undefined || booking_id === undefined) {
      return {
        ok: false,
        message:
          "Each entry must include property _id (or property_id) and booking_id",
      };
    }

    if (!isValidObjectId(_id)) {
      return {
        ok: false,
        message: `Invalid property _id: ${_id}`,
      };
    }

    const normalizedBookingId = String(booking_id).trim();
    if (!normalizedBookingId || normalizedBookingId === "0") {
      return {
        ok: false,
        message: `Invalid booking_id for property ${_id}: ${String(booking_id)}`,
      };
    }

    booking_ids.push({ _id, booking_id: normalizedBookingId });
  }

  return {
    ok: true,
    data: {
      booking_ids,
      property_ids: booking_ids.map((p) => p._id),
    },
  };
}
