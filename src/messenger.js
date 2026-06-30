'use strict';

/**
 * messenger.js — a Facebook/Instagram Messenger interface for the brain.
 *
 * This is one more thin interface around src/brain.js, exactly like server.js's
 * /chat endpoint. It contains NO AI logic: it receives Messenger webhook events,
 * builds the { role, content } history the brain expects, calls answerCustomer()
 * (imported UNCHANGED), and sends the reply back through Meta's Send API.
 *
 * Wiring (done by server.js):
 *   1. express.json must capture the raw body so we can verify Meta's signature.
 *      Pass `rawBodySaver` as the `verify` option:
 *          app.use(express.json({ verify: rawBodySaver }));
 *   2. Mount the routes:
 *          mountMessenger(app, parts);
 *
 * Env vars (see .env.example):
 *   VERIFY_TOKEN       — your own secret string, also entered in the Meta dashboard.
 *   PAGE_ACCESS_TOKEN  — token for the Facebook Page, used to call the Send API.
 *   APP_SECRET         — the app secret, used to verify X-Hub-Signature-256.
 *   GEMINI_API_KEY     — already used by brain.js.
 */

const crypto = require('crypto');

const { answerCustomer } = require('./brain');

// Graph API version for the Send API endpoint.
const GRAPH_API_VERSION = 'v21.0';

// Keep at most this many recent turns per sender so in-memory history can't grow
// without bound. Trimmed to the most recent messages (oldest dropped first).
const MAX_HISTORY_MESSAGES = 20;

// Per-sender conversation history: senderId -> [{ role, content }, ...].
// In-memory only (resets on restart), which is fine for an MVP.
const conversations = new Map();

/**
 * express.json `verify` callback. Stashes the raw request bytes on req.rawBody
 * BEFORE the JSON is parsed, so we can compute the HMAC signature over exactly
 * the bytes Meta signed. Must be wired into the FIRST body parser that consumes
 * the stream (the global one in server.js), or the raw bytes are gone.
 */
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

/**
 * Verify Meta's X-Hub-Signature-256 header: it is "sha256=" + HMAC-SHA256 of the
 * raw request body keyed by APP_SECRET. Returns true only on an exact, constant-
 * time match. Returns false if APP_SECRET is unset or the body wasn't captured.
 */
function isValidSignature(req) {
  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody || !process.env.APP_SECRET) return false;

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(headerBuf, expectedBuf);
}

/** Send a plain-text reply back to a user via Meta's Send API. */
async function callSendAPI(senderId, text) {
  const token = process.env.PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error('[messenger] PAGE_ACCESS_TOKEN is not set; cannot send reply.');
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(
    token
  )}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[messenger] Send API error ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[messenger] Send API request failed:', err.message);
  }
}

/**
 * Handle a single inbound text message: append it to the sender's history, ask
 * the brain for a reply, store the reply, and send it back. answerCustomer never
 * throws (it returns a Georgian fallback on error), so the reply is always sent.
 */
async function handleTextMessage(senderId, text, parts) {
  const history = conversations.get(senderId) || [];
  history.push({ role: 'user', content: text });

  const reply = await answerCustomer(history, parts);

  history.push({ role: 'assistant', content: reply });
  // Trim to the most recent turns to bound memory use.
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  conversations.set(senderId, history);

  await callSendAPI(senderId, reply);
}

/**
 * Register the Messenger webhook routes on the given Express app.
 * `parts` is the catalog loaded once at startup (passed straight to the brain).
 */
function mountMessenger(app, parts) {
  // GET /webhook — Meta verification handshake. No signature needed here.
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('[messenger] Webhook verified.');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // POST /webhook — inbound events. Verify signature, ack Meta immediately (200),
  // then process each text message asynchronously.
  app.post('/webhook', (req, res) => {
    if (!isValidSignature(req)) {
      console.warn('[messenger] Rejected webhook with invalid signature.');
      return res.sendStatus(403);
    }

    // Acknowledge fast so Meta doesn't retry; processing happens after.
    res.sendStatus(200);

    const body = req.body;
    if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const events = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const event of events) {
        const senderId = event.sender && event.sender.id;
        const message = event.message;
        // Only handle real inbound text messages (skip echoes, deliveries, etc.).
        if (!senderId || !message || message.is_echo || typeof message.text !== 'string') {
          continue;
        }
        handleTextMessage(senderId, message.text, parts).catch((err) =>
          console.error('[messenger] Failed to handle message:', err)
        );
      }
    }
  });

  console.log('[messenger] Webhook routes mounted at GET/POST /webhook');
}

module.exports = { mountMessenger, rawBodySaver };
