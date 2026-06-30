'use strict';

/**
 * notify.js — outbound lead notifications (plumbing, NOT the brain).
 *
 * The brain (src/brain.js) only DECIDES a lead exists and returns it; it never
 * sends anything. This module is the sending side: server.js / messenger.js call
 * sendLead(lead) AFTER they've already replied to the customer.
 *
 * Destination is Telegram (one shop for now). For a real multi-dealer setup the
 * chat id becomes per-dealer config rather than a single env var — see README.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN — bot token from @BotFather
 *   TELEGRAM_CHAT_ID   — the chat / group id leads are posted to
 *
 * Uses global fetch (Node 18+). No new dependencies.
 */

/**
 * Build the Georgian notification text, omitting lines whose value is null/empty.
 * A Messenger-sourced lead also carries senderName + senderId (merged in by
 * messenger.js); those add the "კლიენტი (Messenger)" line and a chat deep-link so
 * staff can find and reply to the conversation. Leads from /chat carry neither,
 * so those lines are simply omitted.
 */
function formatLead(lead) {
  const rows = [
    ['ნაწილი', lead.part],
    ['მანქანა', lead.car],
    ['კლიენტი', lead.customer_name],
    ['კლიენტი (Messenger)', lead.senderName],
    ['კონტაქტი', lead.contact],
    ['შენიშვნა', lead.note],
  ];
  const lines = ['🔔 ახალი მოთხოვნა'];
  for (const [label, value] of rows) {
    if (value != null && String(value).trim() !== '') {
      lines.push(`${label}: ${value}`);
    }
  }
  // Deep-link back to the Messenger conversation, when we have the sender's PSID.
  if (lead.senderId != null && String(lead.senderId).trim() !== '') {
    lines.push(`ჩატის ბმული: https://www.facebook.com/messages/t/${lead.senderId}`);
  }
  return lines.join('\n');
}

/**
 * Send a captured lead to Telegram. Never throws and never blocks anything that
 * matters: callers send the customer's reply first and then call this, so a
 * Telegram failure only costs a log line — the customer reply is unaffected.
 */
async function sendLead(lead) {
  if (!lead) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[notify] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping lead notification.');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatLead(lead) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[notify] Telegram sendMessage failed ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[notify] Telegram request error:', err.message);
  }
}

module.exports = { sendLead, formatLead };
