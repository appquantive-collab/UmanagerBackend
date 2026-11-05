import { Schema, model, Types } from "mongoose";

// One record per phone number: the latest login code (hashed, never stored in
// plain text) plus the counters used to rate-limit sends and guesses.
export interface PhoneOtpDocument {
  _id: Types.ObjectId;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  sendCount: number;
  windowStartedAt: Date;
  lastSentAt: Date;
}

const phoneOtpSchema = new Schema<PhoneOtpDocument>({
  phone: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  sendCount: { type: Number, default: 0 },
  windowStartedAt: { type: Date, required: true },
  lastSentAt: { type: Date, required: true },
});

phoneOtpSchema.index({ lastSentAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const PhoneOtp = model<PhoneOtpDocument>("PhoneOtp", phoneOtpSchema);
