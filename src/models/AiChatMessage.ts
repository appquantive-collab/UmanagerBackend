import { Schema, model, Types } from "mongoose";

export type ChatRole = "user" | "assistant";
export type ActionStatus = "pending" | "confirmed" | "dismissed";

// The closed set of actions the assistant may propose. Each name maps 1:1 to
// a real, already-existing service function — the model can only ever
// trigger something this app already does through its normal UI, never
// arbitrary code or a made-up operation.
export type ActionType = "mark_attendance" | "create_order";

export interface ProposedAction {
  type: ActionType;
  // Freeform per-action-type payload, validated again against a zod schema
  // at confirm-time — never trusted as-is just because the model produced it.
  payload: Record<string, unknown>;
  status: ActionStatus;
  resultSummary?: string;
}

export interface AiChatMessageDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  role: ChatRole;
  content: string;
  proposedAction?: ProposedAction;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const proposedActionSchema = new Schema<ProposedAction>(
  {
    type: { type: String, enum: ["mark_attendance", "create_order"], required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["pending", "confirmed", "dismissed"], default: "pending" },
    resultSummary: { type: String, trim: true },
  },
  { _id: false }
);

const aiChatMessageSchema = new Schema<AiChatMessageDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, trim: true },
    proposedAction: { type: proposedActionSchema },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiChatMessageSchema.index({ tenantId: 1, createdAt: 1 });

export const AiChatMessage = model<AiChatMessageDocument>("AiChatMessage", aiChatMessageSchema);
