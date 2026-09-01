import mongoose, { Document, Schema, Types } from "mongoose";
import { OTAProvider } from "./job.model.js";

/**
 * Batch container for retrievals, owned by the retrieval backend (Prisma) and
 * shared through the same MongoDB. Field names follow that project's mapping:
 * the OTA provider is stored as `OTA`, not `ota_provider`.
 */
export interface IParentRetrieval extends Document {
  _id: Types.ObjectId;
  name: string;
  OTA?: OTAProvider;
  is_archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ParentRetrievalSchema = new Schema<IParentRetrieval>(
  {
    name: { type: String, required: true },
    OTA: {
      type: String,
      enum: Object.values(OTAProvider),
      required: false,
    },
    is_archived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: "parent_retrievals",
  },
);

export const ParentRetrieval = mongoose.model<IParentRetrieval>(
  "ParentRetrieval",
  ParentRetrievalSchema,
);
