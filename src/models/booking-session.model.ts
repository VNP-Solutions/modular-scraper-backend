import mongoose, { Document, Schema, Types } from "mongoose";

// Interface for cookie data
export interface ICookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

// Interface for the BookingSession document
export interface IBookingSession extends Document {
  _id: Types.ObjectId;
  property_id: Types.ObjectId; // Reference to Property
  booking_id: string; // Booking.com property ID
  cookies: ICookie[]; // Array of cookies
  user_agent?: string; // Store user agent for consistency
  
  // Session metadata
  session_valid: boolean;
  last_ping_date?: Date; // Last successful ping
  last_full_login_date?: Date; // Last full login
  session_created_date: Date; // When session was first created
  session_expires_date: Date; // When session expires (7 days from last activity)
  
  // Trust metrics
  trust_score: number; // 0-100
  consecutive_successful_pings: number;
  consecutive_failed_pings: number;
  total_successful_pings: number;
  total_failed_pings: number;
  
  // Performance metrics
  avg_ping_response_time?: number; // milliseconds
  last_ping_response_time?: number; // milliseconds
  
  // Session state
  requires_captcha: boolean;
  requires_2fa: boolean;
  account_locked: boolean;
  
  // Additional data
  last_error?: string;
  metadata?: Record<string, any>; // Flexible field for additional data
  
  createdAt: Date;
  updatedAt: Date;
}

// Cookie Schema
const CookieSchema = new Schema<ICookie>(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
    domain: { type: String, required: true },
    path: { type: String, required: true },
    expires: { type: Number, required: false },
    size: { type: Number, required: false },
    httpOnly: { type: Boolean, default: false },
    secure: { type: Boolean, default: false },
    sameSite: { 
      type: String, 
      enum: ["Strict", "Lax", "None"],
      required: false 
    },
  },
  { _id: false } // Don't create _id for subdocuments
);

// Mongoose Schema for BookingSession
const BookingSessionSchema = new Schema<IBookingSession>(
  {
    property_id: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    booking_id: {
      type: String,
      required: true,
      index: true,
    },
    cookies: {
      type: [CookieSchema],
      default: [],
    },
    user_agent: {
      type: String,
      required: false,
    },
    
    // Session metadata
    session_valid: {
      type: Boolean,
      default: true,
      index: true,
    },
    last_ping_date: {
      type: Date,
      required: false,
      index: true,
    },
    last_full_login_date: {
      type: Date,
      required: false,
    },
    session_created_date: {
      type: Date,
      default: Date.now,
    },
    session_expires_date: {
      type: Date,
      required: true,
      index: true,
    },
    
    // Trust metrics
    trust_score: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      index: true,
    },
    consecutive_successful_pings: {
      type: Number,
      default: 0,
    },
    consecutive_failed_pings: {
      type: Number,
      default: 0,
    },
    total_successful_pings: {
      type: Number,
      default: 0,
    },
    total_failed_pings: {
      type: Number,
      default: 0,
    },
    
    // Performance metrics
    avg_ping_response_time: {
      type: Number,
      required: false,
    },
    last_ping_response_time: {
      type: Number,
      required: false,
    },
    
    // Session state
    requires_captcha: {
      type: Boolean,
      default: false,
    },
    requires_2fa: {
      type: Boolean,
      default: false,
    },
    account_locked: {
      type: Boolean,
      default: false,
    },
    
    // Additional data
    last_error: {
      type: String,
      required: false,
    },
    metadata: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: "booking_sessions",
  }
);

// Indexes for efficient queries
BookingSessionSchema.index({ property_id: 1, session_valid: 1 });
BookingSessionSchema.index({ booking_id: 1, session_valid: 1 });
BookingSessionSchema.index({ trust_score: -1, session_valid: 1 });
BookingSessionSchema.index({ session_expires_date: 1 });
BookingSessionSchema.index({ last_ping_date: 1, trust_score: -1 });

// Compound index for finding sessions that need maintenance
BookingSessionSchema.index({ 
  session_valid: 1, 
  trust_score: 1, 
  last_ping_date: 1 
});

// Instance methods
BookingSessionSchema.methods.isExpired = function(): boolean {
  return this.session_expires_date <= new Date();
};

BookingSessionSchema.methods.needsPing = function(hoursThreshold: number = 6): boolean {
  if (!this.last_ping_date) return true;
  
  const hoursSinceLastPing = (Date.now() - this.last_ping_date.getTime()) / (1000 * 60 * 60);
  return hoursSinceLastPing >= hoursThreshold;
};

BookingSessionSchema.methods.isTrusted = function(minScore: number = 70): boolean {
  return this.trust_score >= minScore && this.session_valid && !this.isExpired();
};

BookingSessionSchema.methods.calculateTrustScore = function(): number {
  // Base score from success rate
  const totalPings = this.total_successful_pings + this.total_failed_pings;
  if (totalPings === 0) return 0;
  
  const successRate = this.total_successful_pings / totalPings;
  let score = successRate * 50; // Max 50 points from success rate
  
  // Bonus for consecutive successes
  score += Math.min(this.consecutive_successful_pings * 5, 30); // Max 30 points
  
  // Penalty for consecutive failures
  score -= this.consecutive_failed_pings * 10;
  
  // Bonus for session age (up to 20 points for sessions > 7 days old)
  const daysSinceCreation = (Date.now() - this.session_created_date.getTime()) / (1000 * 60 * 60 * 24);
  score += Math.min(daysSinceCreation * (20 / 7), 20);
  
  // Penalties for issues
  if (this.requires_captcha) score -= 15;
  if (this.requires_2fa) score -= 5;
  if (this.account_locked) score -= 50;
  
  return Math.max(0, Math.min(100, Math.round(score)));
};

// Pre-save hook to update trust score
BookingSessionSchema.pre("save", function(next) {
  this.trust_score = this.calculateTrustScore();
  next();
});

// Static methods for common queries
BookingSessionSchema.statics.findValidSession = async function(propertyId: string) {
  return this.findOne({
    property_id: propertyId,
    session_valid: true,
    session_expires_date: { $gt: new Date() },
  }).sort({ trust_score: -1 });
};

BookingSessionSchema.statics.findTrustedSessions = async function(minTrustScore: number = 70) {
  return this.find({
    session_valid: true,
    trust_score: { $gte: minTrustScore },
    session_expires_date: { $gt: new Date() },
  }).sort({ trust_score: -1 });
};

BookingSessionSchema.statics.findSessionsNeedingPing = async function(hoursThreshold: number = 6) {
  const thresholdDate = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000);
  
  return this.find({
    session_valid: true,
    session_expires_date: { $gt: new Date() },
    $or: [
      { last_ping_date: { $lt: thresholdDate } },
      { last_ping_date: { $exists: false } },
    ],
  }).sort({ trust_score: -1, last_ping_date: 1 });
};

BookingSessionSchema.statics.cleanupExpiredSessions = async function() {
  const result = await this.deleteMany({
    session_expires_date: { $lte: new Date() },
  });
  return result.deletedCount;
};

export const BookingSession = mongoose.model<IBookingSession>("BookingSession", BookingSessionSchema);