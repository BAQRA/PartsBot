'use strict';

/**
 * brain.js — the AI "brain", fully decoupled from any interface.
 *
 * This file knows NOTHING about Express, HTTP, sockets, the DOM, or Messenger.
 * It exports a single async function:
 *
 *     answerCustomer(messages, parts) -> Promise<string>
 *
 * `messages` is the conversation history as an array of { role, content } where
 * role is "user" or "assistant" (the same shape a Meta webhook can build from a
 * thread). `parts` is the parts catalog (array of part objects from parts.json).
 * The function returns the assistant's reply as a plain Georgian string.
 *
 * To reuse this behind a Meta Messenger / Instagram webhook later: import this
 * file unchanged, build the `messages` array from the incoming thread, call
 * answerCustomer(), and send the returned string back via the Send API.
 *
 * To swap the AI provider: edit ONLY this file (the model constant + the
 * generateContent call below). Nothing else in the project touches the AI.
 *
 * CATALOG SHAPE (partsauto.ge export). Each part may include:
 *   id, title_ka / title_en / title_ru (name), description_ka/en/ru,
 *   image (filename — full URL = IMAGE_BASE_URL + image), price, newprice
 *   (discounted price; 0 = no discount), stock, oem, code, compatible_with,
 *   and a nested car: { name } like "COROLLA 2019-2025" (model + year range).
 * The brain is tolerant: it also accepts a simpler { name, make, model, year,
 * price, stock, url, image } shape.
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─────────────────────────────────────────────────────────────────────────────
// MODEL — single editable constant. Swap to "gemini-3.5-flash" or
// "gemini-2.5-flash" for higher quality (uses more of the free-tier quota).
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_NAME = 'gemini-3.1-flash-lite';

// Base URL for part photos. Full image URL = IMAGE_BASE_URL + part.image
const IMAGE_BASE_URL = 'https://api.partsauto.ge/storage/files/parts/';

// Below this catalog size we just send everything to the model. Above it, the
// keyword pre-filter kicks in to protect the free-tier 250K tokens/min limit.
const FILTER_THRESHOLD = 40;

// How many of the most relevant parts to send when the catalog is large.
// Kept above the largest single part-type group (e.g. ~100 "ფარი" entries) so
// that when only the part-name keyword matches — e.g. the customer writes the
// car model in Georgian letters, which won't match the Latin model names in
// the data — the right part isn't cut off. ~120 compact entries is still only
// ~10K tokens, well under the 250K tokens/min free-tier limit.
const MAX_PARTS_SENT = 120;

// When no keyword matches at all, send this many parts so the model still has
// some context (and can ask for the car/part) instead of being totally blind.
const NO_MATCH_FALLBACK = 25;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ─────────────────────────────────────────────────────────────────────────────
// Behavior rules (system instruction). Written as instructions to the model;
// the model MUST reply only in Georgian. The live parts catalog is appended at
// call time by buildSystemInstruction().
// ─────────────────────────────────────────────────────────────────────────────
const BEHAVIOR_RULES = `You are a friendly, helpful customer-service assistant for a car-parts dealer in Georgia (partsauto.ge).
You chat with customers on Messenger/Instagram about car parts: availability, price, photos, and next steps.

# LANGUAGE
- Reply ONLY in natural, warm, conversational Georgian (ქართული). Never reply in English or any other language.
- Sound like a real, polite shop assistant — short, clear sentences. A friendly tone and the occasional emoji is fine.
- Prices are in Georgian Lari. Always write prices like "320 ₾".

# YOUR KNOWLEDGE
- You ONLY know about the parts in the catalog provided below in this system message.
- NEVER invent parts, prices, stock numbers, OEM codes, or image links. If something is not in the catalog, you do not have it.

# CATALOG FIELDS (per part)
- "name": the part name (in Georgian).
- "car": the vehicle it fits, written as MODEL + YEAR RANGE, e.g. "COROLLA 2019-2025" means Toyota Corolla, model years 2019 through 2025.
- "fits": extra compatibility note, when present.
- "price": the price in ₾ (already the current price).
- "stock": units in stock. 0 means out of stock.
- "oem" / "code": manufacturer part numbers, when present (useful if the customer gives a code).
- "imageUrl": a direct link to the part's photo, when present.

# MATCHING
- Match the customer's request to the catalog by part name + car model + year.
- The customer's year must fall INSIDE the car's year range (e.g. a 2021 Corolla matches "COROLLA 2019-2025").
- Brand may be implied by the model name (Corolla/Camry/Prius/RAV4 = Toyota, Accord/Civic = Honda, etc.). Use common sense.
- Be flexible with wording: customers describe parts in everyday Georgian, with typos, or mix Georgian and English, and may
  write the car model in Latin or Georgian letters.
- If you genuinely need the car's model and year (or which side/variant) to pick the right part, ask for it — one question at a time.

# HOW TO RESPOND
1. PART FOUND AND IN STOCK (stock > 0):
   - Confirm it is available, state the price, and offer the next step
     (e.g. ask quantity, offer to reserve it, or ask which city for delivery).
2. PART FOUND BUT OUT OF STOCK (stock = 0):
   - Politely say it is currently unavailable. Offer to take their contact info (name + phone)
     so the team can notify them when it arrives. Do NOT promise a date.
3. PART NOT IN THE CATALOG (or car not carried):
   - Do NOT guess or make anything up. Say you'll check with the team, and collect:
     (a) exactly which part they need, (b) car make / model / year, (c) their contact info (name + phone).
   - Confirm that the team will follow up with them.

# PHOTOS / IMAGES
- If the customer asks to see a photo/picture (e.g. "ფოტო", "სურათი", "სურათის ნახვა", "გადააგზავნე ფოტო"),
  share that part's "imageUrl" as a plain link on its own line so it can be opened/previewed.
- Only share imageUrl values that actually exist in the catalog. If a part has no imageUrl, say a photo isn't
  available right now but offer to help otherwise. NEVER invent or guess an image link.

# BE PROACTIVE
- Never leave the conversation hanging. If the customer goes quiet, gives a one-word reply, or just says
  "კი" / "yes", ask the natural next question (quantity, delivery city, or contact details).
- Ask only ONE clear question at a time. Keep momentum toward a concrete next step (reserve, order, or follow-up).

# IMPORTANT
- Be honest. If you're unsure or it's not in the catalog, say you'll check — never bluff.`;

/** Effective price: a non-zero newprice is a discount; otherwise use price. */
function effectivePrice(p) {
  if (typeof p.newprice === 'number' && p.newprice > 0) return p.newprice;
  return p.price;
}

/** Build the searchable text for a part (tolerant to both schemas). */
function searchText(p) {
  return [
    p.title_ka,
    p.title_en,
    p.title_ru,
    p.car && p.car.name,
    p.compatible_with,
    p.oem,
    p.code,
    p.name, // simple-schema fallbacks below
    p.make,
    p.model,
    p.year,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Compact projection sent to the model — only the fields needed to answer.
 * Drops timestamps, nested car object, long descriptions, etc., to stay well
 * under the free-tier token limit. Tolerant to the simple sample schema too.
 */
function compactPart(p) {
  const out = {
    id: p.id,
    name: p.title_ka || p.title_en || p.title_ru || p.name || null,
    car:
      (p.car && p.car.name) ||
      [p.make, p.model, p.year].filter(Boolean).join(' ') ||
      null,
    price: effectivePrice(p),
    stock: typeof p.stock === 'number' ? p.stock : 0,
  };
  if (p.compatible_with) out.fits = p.compatible_with;
  if (p.oem) out.oem = p.oem;
  if (p.code) out.code = p.code;
  if (p.image) out.imageUrl = IMAGE_BASE_URL + p.image;
  else if (p.url) out.url = p.url;
  return out;
}

/**
 * Keyword pre-filter. For a small catalog it returns everything (the filter
 * just needs to exist). For a large catalog it scores each part by how many
 * tokens from the recent user messages appear in its searchable text and
 * returns the best matches, capped at MAX_PARTS_SENT. Works for Georgian,
 * Latin, and numeric tokens (years, model names, OEM codes).
 */
function selectRelevantParts(messages, parts) {
  if (!Array.isArray(parts) || parts.length === 0) return [];
  if (parts.length <= FILTER_THRESHOLD) return parts;

  const recentUserText = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .slice(-4)
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();

  // Tokenize on anything that isn't a Latin letter, digit, or Georgian char.
  const tokens = recentUserText
    .split(/[^a-z0-9Ⴀ-ჿ]+/i)
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return parts.slice(0, NO_MATCH_FALLBACK);

  const scored = parts.map((p) => {
    const hay = searchText(p);
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 1;
    }
    return { part: p, score };
  });

  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.part);

  if (matched.length > 0) return matched.slice(0, MAX_PARTS_SENT);

  // Nothing matched the keywords — send a small slice so the model still has
  // context and can ask the customer for the car/part instead of being blind.
  return parts.slice(0, NO_MATCH_FALLBACK);
}

/** Build the full system instruction: behavior rules + the (filtered) catalog. */
function buildSystemInstruction(relevantParts) {
  const catalog = JSON.stringify(relevantParts.map(compactPart), null, 1);
  return `${BEHAVIOR_RULES}

# PARTS CATALOG (the only parts you have; "price" is in ₾, "stock" is units available)
${catalog}`;
}

/** Convert our { role, content } history into Gemini's "contents" format. */
function toGeminiContents(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim() !== '')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

/** Detect free-tier rate-limit / quota errors from the SDK. */
function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.code;
  if (status === 429) return true;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted')
  );
}

/**
 * THE one entry point. Takes conversation history + parts, returns a Georgian
 * reply string. Never throws — on error it returns a friendly Georgian message.
 */
async function answerCustomer(messages, parts) {
  if (!process.env.GEMINI_API_KEY) {
    return 'ბოდიში, ასისტენტი ჯერ არ არის კონფიგურირებული (API გასაღები არ მოიძებნა). გთხოვთ, დაუკავშირდეთ ჩვენს გუნდს.';
  }

  try {
    const relevantParts = selectRelevantParts(messages, parts);

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: buildSystemInstruction(relevantParts),
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 600,
      },
    });

    const result = await model.generateContent({
      contents: toGeminiContents(messages),
    });

    const reply = (result.response.text() || '').trim();
    return reply || 'ბოდიში, ვერ მოვახერხე პასუხის ჩამოყალიბება. გთხოვთ, სცადოთ თავიდან.';
  } catch (err) {
    if (isRateLimitError(err)) {
      return 'ერთი წუთით დაიცადეთ და თავიდან სცადეთ 🙏 (სისტემა ამ წუთას დატვირთულია).';
    }
    console.error('[brain] answerCustomer error:', err);
    return 'ბოდიში, ტექნიკური ხარვეზი მოხდა. გთხოვთ, ცოტა ხანში სცადოთ თავიდან.';
  }
}

module.exports = { answerCustomer, MODEL_NAME };
