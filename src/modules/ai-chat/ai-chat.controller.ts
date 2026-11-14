import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { askQuestionSchema, sendMessageSchema } from "./ai-chat.schemas";
import { sendPlanError } from "../billing/subscription.service";
import { AiChatNotConfiguredError, askBusinessQuestion, confirmAction, dismissAction, listMessages, sendMessage } from "./ai-chat.service";

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
    const result = await sendMessage(req.auth!.tenantId!, req.auth!.userId, parsed.data.content, parsed.data.language);
    res.status(201).json(result);
  } catch (err) {
    if (sendPlanError(res, err)) return;
    if (err instanceof AiChatNotConfiguredError) {
      return res.status(503).json({ error: err.message });
    }
    res.status(400).json({ error: (err as Error).message });
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
    console.error("[ai-chat] ask failed:", (err as Error).message);
    res.status(502).json({ error: "Munshi AI could not answer right now. Please try again." });
  }
});
