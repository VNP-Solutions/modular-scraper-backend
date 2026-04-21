import mongoose, { Document, Schema, Types } from "mongoose";

export interface MoneyAmount {
  amount?: number;
  currency?: string;
}

export interface Authorization {
  dateTime?: Date;
  status?: string;
  authCode?: string | null;
  declineCode?: string | null;
  responseDescription?: string | null;
  amount?: MoneyAmount;
}

export interface ICardActivity extends Document {
  _id: Types.ObjectId;
  job_item_id: Types.ObjectId;
  job_id?: Types.ObjectId;
  property_id?: Types.ObjectId;
  reservation_id?: string;
  totalSettlementAmount?: MoneyAmount;
  authorizations?: Authorization[];
  createdAt: Date;
  updatedAt: Date;
}

const MoneyAmountSchema = new Schema<MoneyAmount>(
  {
    amount: {
      type: Number,
      required: false,
    },
    currency: {
      type: String,
      required: false,
    },
  },
  { _id: false }
);

const AuthorizationSchema = new Schema<Authorization>(
  {
    dateTime: {
      type: Date,
      required: false,
    },
    status: {
      type: String,
      required: false,
    },
    authCode: {
      type: String,
      required: false,
      default: null,
    },
    declineCode: {
      type: String,
      required: false,
      default: null,
    },
    responseDescription: {
      type: String,
      required: false,
      default: null,
    },
    amount: {
      type: MoneyAmountSchema,
      required: false,
    },
  },
  { _id: false }
);

const CardActivitySchema = new Schema<ICardActivity>(
  {
    job_item_id: {
      type: Schema.Types.ObjectId,
      ref: "JobItem",
      required: true,
    },
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      required: false,
    },
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: false,
    },
    reservation_id: {
      type: String,
      required: false,
    },
    totalSettlementAmount: {
      type: MoneyAmountSchema,
      required: false,
    },
    authorizations: {
      type: [AuthorizationSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "card_activities",
  }
);

CardActivitySchema.index({ job_item_id: 1 }, { unique: true });
CardActivitySchema.index({ job_id: 1 });
CardActivitySchema.index({ property_id: 1 });
CardActivitySchema.index({ reservation_id: 1 });

export const CardActivity = mongoose.model<ICardActivity>(
  "CardActivity",
  CardActivitySchema
);
