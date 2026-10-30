import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { sendMessageSchema } from "./ai-chat.schemas";
import { AiChatNotConfiguredError, confirmAction, dismissAction, listMessages, sendMessage } from "./ai-chat.service";

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
    const result = await sendMessage(req.auth!.tenantId!, req.auth!.userId, parsed.data.content);
    res.status(201).json(result);
  } catch (err) {
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
