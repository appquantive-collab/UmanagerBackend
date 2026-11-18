import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { askQuestionSchema, sendMessageSchema } from "./ai-chat.schemas";
import { sendPlanError } from "../billing/subscription.service";
import { z } from "zod";
import { AiChatNotConfiguredError, askBusinessQuestion, confirmAction, confirmStep, dismissAction, dismissStep, listMessages, sendMessage } from "./ai-chat.service";
import { StepError } from "./workflow";
import { AiBusyError } from "../../config/groq";
import { recordAudit } from "../audit/audit.service";

export const aiChatRouter = Router();

aiChatRouter.use(requireAuth, requireTenant);

aiChatRouter.get("/messages", async (req, res) => {
  const messages = await listMessages(req.auth!.tenantId!);
  res.json(messages);
});

aiChatRouter.post("/messages", async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await sendMessage(req.auth!.tenantId!, req.auth!.userId, req.auth!.role, parsed.data.content, parsed.data.language);
    if (result.audit) void recordAudit(req, result.audit.action, result.audit.summary, result.audit.entityId, result.audit.amount);
    res.status(201).json(result);
  } catch (err) {
    if (sendPlanError(res, err)) return;
    if (err instanceof AiChatNotConfiguredError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof AiBusyError) return res.status(503).json({ error: err.message, code: "AI_BUSY" });
    console.error("[ai-chat] send failed:", (err as Error).message);
    res.status(502).json({ error: "Munshi AI could not answer right now. Please try again." });
  }
});

aiChatRouter.post("/messages/:id/confirm", async (req, res) => {
  try {
    const message = await confirmAction(req.auth!.tenantId!, req.auth!.userId, req.params.id);
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

aiChatRouter.post("/messages/:id/dismiss", async (req, res) => {
  try {
    const message = await dismissAction(req.auth!.tenantId!, req.params.id);
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Workflow steps: confirm (optionally with edited details, or "go ahead anyway" after a stock/credit warning) or skip.
const confirmStepSchema = z.object({ payload: z.record(z.string(), z.unknown()).optional(), force: z.boolean().optional() });

function sendStepError(res: import("express").Response, err: unknown) {
  if (sendPlanError(res, err)) return;
  if (err instanceof StepError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  console.error("[ai-chat] step failed:", (err as Error).message);
  return res.status(400).json({ error: (err as Error).message });
}

aiChatRouter.post("/messages/:id/steps/:stepId/confirm", async (req, res) => {
  const parsed = confirmStepSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { message, audit } = await confirmStep(req.auth!.tenantId!, req.auth!.userId, req.auth!.role, req.params.id, req.params.stepId, parsed.data);
    if (audit) void recordAudit(req, audit.action, audit.summary, audit.entityId, audit.amount);
    res.json(message);
  } catch (err) {
    sendStepError(res, err);
  }
});

aiChatRouter.post("/messages/:id/steps/:stepId/dismiss", async (req, res) => {
  try {
    res.json(await dismissStep(req.auth!.tenantId!, req.params.id, req.params.stepId));
  } catch (err) {
    sendStepError(res, err);
  }
});

// AI search: a quick, stateless question about the business (see askBusinessQuestion).
aiChatRouter.post("/ask", async (req, res) => {
  const parsed = askQuestionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const answer = await askBusinessQuestion(req.auth!.tenantId!, parsed.data.question, parsed.data.language);
    res.json({ answer });
  } catch (err) {
    if (sendPlanError(res, err)) return;
    if (err instanceof AiChatNotConfiguredError) return res.status(503).json({ error: err.message });
    if (err instanceof AiBusyError) return res.status(503).json({ error: err.message, code: "AI_BUSY" });
    console.error("[ai-chat] ask failed:", (err as Error).message);
    res.status(502).json({ error: "Munshi AI could not answer right now. Please try again." });
  }
});
