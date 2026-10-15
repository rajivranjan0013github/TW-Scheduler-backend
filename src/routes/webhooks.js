import express from 'express';
import crypto from 'crypto';
import { enqueueComment } from '../queues/automationQueue.js';
import { getProviderForWebhookObject } from '../services/socialProviders/index.js';
import { handleIncomingMessage, parseMessagingEvent } from '../services/inboxService.js';
import { recordWebhookComment } from '../services/commentFeedService.js';

const router = express.Router();

const getWebhookSecrets = () => [
  process.env.INSTAGRAM_APP_SECRET,
  process.env.META_APP_SECRET,
].filter(Boolean);

export const isValidMetaSignature = (rawBody, signatureHeader, secrets = getWebhookSecrets()) => {
  const signature = String(signatureHeader || '');
  if (!signature.startsWith('sha256=') || !Buffer.isBuffer(rawBody)) return false;
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');

  return secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  });
};

// @desc    Meta webhook verification handshake
// @route   GET /api/webhooks/meta
// @access  Public (verified by META_WEBHOOK_VERIFY_TOKEN)
router.get('/meta', (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (
    verifyToken
    && req.query['hub.mode'] === 'subscribe'
    && req.query['hub.verify_token'] === verifyToken
  ) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  return res.sendStatus(403);
});

// @desc    Receive Instagram and Facebook Page comment and message events
// @route   POST /api/webhooks/meta
// @access  Public (verified by X-Hub-Signature-256)
router.post('/meta', async (req, res) => {
  if (!isValidMetaSignature(req.body, req.get('x-hub-signature-256'))) {
    return res.sendStatus(401);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // Acknowledge immediately: Meta disables webhooks that respond slowly
  res.sendStatus(200);

  const provider = getProviderForWebhookObject(payload?.object);
  if (!provider) return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const comment = provider.parseCommentChange(entry.id, change);
      if (!comment) continue;
      try {
        await recordWebhookComment(comment);
      } catch (error) {
        console.error(`[Webhook] Failed to store comment ${comment.commentId}:`, error.message);
      }
      try {
        await enqueueComment(comment);
      } catch (error) {
        console.error(`[Webhook] Failed to queue comment ${comment.commentId}:`, error.message);
      }
    }
    for (const item of entry.messaging || []) {
      const message = parseMessagingEvent(entry.id, item, provider.platform);
      if (!message) continue;
      try {
        await handleIncomingMessage(message);
      } catch (error) {
        console.error(`[Webhook] Failed to store message ${message.mid}:`, error.message);
      }
    }
  }
});

export default router;
