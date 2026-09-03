import mongoose, { Document, Schema, Types } from "mongoose";

export interface IAgodaCaseItem extends Document {
  _id: Types.ObjectId;
  property_id?: Types.ObjectId;
  batch_id?: Types.ObjectId;
  portfolio_id?: Types.ObjectId;
  retrieval_id?: Types.ObjectId;
  reservation_id?: string;
  guest_name?: string;
  check_in?: string;
  check_out?: string;
  amount?: string;
  currency?: string;
  amount_to_charge?: string;
  charge_status?: string;
  vcc_card_number?: string;
  card_expire?: string;
  card_cvv?: string;
  is_missing: boolean;
  retrival_status?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AgodaCaseItemSchema = new Schema<IAgodaCaseItem>(
  {
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: false,
    },
    batch_id: {
      type: Schema.Types.ObjectId,
      required: false,
    },
    portfolio_id: {
      type: Schema.Types.ObjectId,
      ref: "Portfolio",
      required: false,
    },
    retrieval_id: {
      type: Schema.Types.ObjectId,
      ref: "Retrieval",
      required: false,
    },
    reservation_id: {
      type: String,
      required: false,
    },
    guest_name: {
      type: String,
      required: false,
    },
    check_in: {
      type: String,
      required: false,
    },
    check_out: {
      type: String,
      required: false,
    },
    amount: {
      type: String,
      required: false,
    },
    currency: {
      type: String,
      required: false,
    },
    amount_to_charge: {
      type: String,
      required: false,
    },
    charge_status: {
      type: String,
      required: false,
    },
    vcc_card_number: {
      type: String,
      required: false,
    },
    card_expire: {
      type: String,
      required: false,
    },
    card_cvv: {
      type: String,
      required: false,
    },
    is_missing: {
      type: Boolean,
      default: false,
      required: true,
    },
    retrival_status: {
      type: String,
      required: false,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "agoda_case_items",
  }
);

AgodaCaseItemSchema.index({ property_id: 1 });
AgodaCaseItemSchema.index({ batch_id: 1 });
AgodaCaseItemSchema.index({ portfolio_id: 1 });
AgodaCaseItemSchema.index({ retrieval_id: 1 });
AgodaCaseItemSchema.index({ reservation_id: 1 });
AgodaCaseItemSchema.index({ retrieval_id: 1, reservation_id: 1 });
AgodaCaseItemSchema.index({ charge_status: 1 });
AgodaCaseItemSchema.index({ retrival_status: 1 });
AgodaCaseItemSchema.index({ createdBy: 1 });

export const AgodaCaseItem = mongoose.model<IAgodaCaseItem>(
  "AgodaCaseItem",
  AgodaCaseItemSchema
);
