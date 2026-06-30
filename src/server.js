'use strict';

/**
 * server.js — thin HTTP wrapper around the brain. It only:
 *   1. loads parts.json once at startup,
 *   2. serves the static chat frontend from /public,
 *   3. exposes POST /chat { messages } -> { reply }.
 *
 * All intelligence lives in src/brain.js. This file is just one possible
 * interface; a Meta webhook would be another, calling the same answerCustomer().
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const { answerCustomer, MODEL_NAME } = require('./brain');
const { mountMessenger, rawBodySaver } = require('./messenger');
const { sendLead } = require('./notify');

const PORT = process.env.PORT || 3000;
const PARTS_PATH = path.join(__dirname, '..', 'parts.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Load the parts catalog once at startup.
let parts = [];
try {
  parts = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf8'));
  console.log(`[server] Loaded ${parts.length} parts from parts.json`);
} catch (err) {
  console.error(`[server] Could not read parts.json at ${PARTS_PATH}:`, err.message);
  console.error('[server] Starting with an empty catalog.');
}

if (!process.env.GEMINI_API_KEY) {
  console.warn('[server] WARNING: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
}

const missingMessengerVars = ['VERIFY_TOKEN', 'PAGE_ACCESS_TOKEN', 'APP_SECRET'].filter(
  (v) => !process.env[v]
);
if (missingMessengerVars.length) {
  console.warn(
    `[server] WARNING: Messenger webhook env vars not set: ${missingMessengerVars.join(', ')}. ` +
      'The /webhook routes will load but verification/replies will fail until these are configured.'
  );
}

const app = express();
// `verify` stashes the raw request bytes on req.rawBody so the Messenger webhook
// can validate Meta's X-Hub-Signature-256 over exactly the bytes that were signed.
app.use(express.json({ limit: '1mb', verify: rawBodySaver }));
app.use(express.static(PUBLIC_DIR));

// Mount the Facebook/Instagram Messenger interface (GET/POST /webhook). Like
// /chat below, it's just another thin interface around the same brain.
mountMessenger(app, parts);

// POST /chat — the only dynamic endpoint. Body: { messages: [{role, content}, ...] }
app.post('/chat', async (req, res) => {
  const messages = req.body && req.body.messages;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }

  const { reply, lead } = await answerCustomer(messages, parts);
  res.json({ reply });

  // Push the lead to the team AFTER replying, so the notification can never delay
  // or block the customer's response. sendLead is self-contained and never throws.
  if (lead) sendLead(lead);
});

app.listen(PORT, () => {
  console.log(`[server] Model: ${MODEL_NAME}`);
  console.log(`[server] Car-parts assistant running at http://localhost:${PORT}`);
});
