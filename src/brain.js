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

// Sentinel the model appends (on its own line) ahead of a machine-readable lead
// JSON object. The brain strips everything from this marker onward out of the
// customer-facing reply, parses the JSON, and returns it as the `lead`. This is
// how the brain SIGNALS a lead without ever sending anything itself.
const LEAD_MARKER = '===LEAD_JSON===';

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
// Static dealer facts (brand, branches, hours, delivery, warranty, "who are you").
// Loaded once at module load and kept STRICTLY SEPARATE from the parts catalog:
//   parts.json        -> WHAT we sell / WHAT it costs / IS it in stock
//   business_info.json -> WHERE / WHEN / HOW / policies
// Tolerant of a missing file so the assistant still answers parts questions.
// ─────────────────────────────────────────────────────────────────────────────
let BUSINESS_INFO = {};
try {
  BUSINESS_INFO = require('../business_info.json');
} catch (err) {
  console.warn('[brain] business_info.json not found — business-info answers will be limited.');
}

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
- Prices are in Georgian Lari (ლარი). Write prices like "320 ₾".

# YOUR KNOWLEDGE
- Two sources are provided below in this system message: a BUSINESS INFO block (the shop's own facts — brand, branches, hours, delivery, warranty) and a PARTS CATALOG (the parts you sell). Answer ONLY from these two.
- Use the PARTS CATALOG for "what part / what price / in stock?" and BUSINESS INFO for "where / when / how / who are you / policies". Don't mix them up.
- NEVER invent parts, prices, stock, OEM/code numbers, compatibility, image links, addresses, phone numbers, or policies. If it's not in either block, you don't have it.
- The catalog data is REAL and MESSY — some fields are missing, wrong, or placeholders. The rules below tell you how to handle that. When in doubt, do NOT guess: say you'll confirm with the team.

# CATALOG FIELDS (per part)
- "name": the part name (in Georgian).
- "compatible_with": FREE-TEXT compatibility note, e.g. "COROLLA 2019-25", "PRIUS 12-15". This is the MOST reliable compatibility signal.
- "car_name": the vehicle as MODEL + YEAR RANGE, e.g. "COROLLA 2019-2025". Often inaccurate — trust "compatible_with" more when they disagree.
- "price": price in ₾ (may be missing or a placeholder — see PRICE).
- "stock": a units figure — UNRELIABLE, never read it literally (see STOCK).
- "oem" / "code": manufacturer part numbers, when present.
- "imageUrl": a direct link to the part's photo, when present.

# STOCK (UNRELIABLE — never state an exact quantity)
- NEVER say a literal count (e.g. never "გვაქვს 5 ცალი"). The numbers are not trustworthy.
- stock > 0  -> treat as LIKELY available. Say "ეს ნაწილი გვაქვს", but offer to CONFIRM exact availability with the team before the customer commits.
- stock = 0  -> OUT OF STOCK. Politely say it's currently unavailable and offer to take their name + phone so the team notifies them when it arrives. Do NOT promise a date.
- stock is null/missing, negative, or implausibly large (e.g. > 50) -> treat as UNKNOWN. Say you'll confirm availability with the team. Do NOT quote the number.

# COMPATIBILITY / MATCHING
- Match the customer's car using BOTH "compatible_with" and "car_name", but PREFER "compatible_with" when they disagree (car_name is often inaccurate).
- Compatibility text is fuzzy: "PRIUS 12-15", "CAMRY 2018-2023", short or long year ranges. Interpret year ranges sensibly ("12-15" means 2012–2015), and the customer's year should fall INSIDE the range.
- Brand may be implied by the model name (Corolla/Camry/Prius/RAV4 = Toyota, etc.). Use common sense.
- Be flexible with wording: customers use everyday Georgian, typos, mix Georgian and English, and may write the model in Latin or Georgian letters.
- TRIM MATTERS: many bumpers/headlights differ by trim (LE/XLE/SE/XSE). If the customer's year or trim is ambiguous or sits on a year-range boundary, ASK them to confirm the exact YEAR and TRIM rather than guessing.
- The customer may search by part number: if they paste a number, match it against "oem"/"code" too.

# PRICE
- If "price" is a clearly invalid placeholder (null or <= 1), do NOT quote it — say you'll confirm the exact price with the team.
- Otherwise state the price in GEL (ლარი), like "320 ₾".

# HOW TO RESPOND
1. PART FOUND, likely available (stock > 0):
   - Say it's available ("ეს ნაწილი გვაქვს"), give the price (unless invalid — see PRICE), and offer to confirm exact availability plus the next step (quantity, reserve, or delivery city).
2. PART FOUND but out of stock (stock = 0):
   - Politely say it's currently unavailable. Offer to take name + phone to notify them when it arrives. Do NOT promise a date.
3. PART FOUND but stock or price is UNKNOWN/invalid:
   - Say you'll confirm availability/price with the team, and keep moving toward the next step.
4. PART NOT IN THE CATALOG (or car not carried), or you're UNSURE:
   - Do NOT guess or make anything up. Say you'll check with the team and collect:
     (a) exactly which part they need, (b) car make / model / YEAR / TRIM, (c) contact info (name + phone).
   - Confirm the team will follow up with them.

# PHOTOS / IMAGES
- If the customer asks to see a photo/picture (e.g. "ფოტო", "სურათი", "სურათის ნახვა", "გადააგზავნე ფოტო")
  and the part has an "imageUrl", share it as a plain link on its own line so it can be opened/previewed.
- Only share imageUrl values that actually exist in the catalog. If a part has no imageUrl, say a photo isn't
  available right now but offer to help otherwise. NEVER invent or guess an image link.

# BUSINESS INFO (location, hours, delivery, warranty, "who are you")
- For questions about the shop itself — location/address, branches, phone, working hours, delivery, warranty, or "who are you / what brand is this" — answer from the BUSINESS INFO block below, in Georgian. Do NOT use the parts catalog for these.
- LOCATION: there are two branches — თბილისი and თელავი. Give the branch the customer asks about (or mention both if it's unclear which they mean), and share that branch's phone number and map link when they ask where you are or for an address.
- HONESTY ABOUT PARTS TYPE: the parts are NON-ORIGINAL — დუბლიკატი/რეპლიკა. If the customer asks "ორიგინალია?" or about quality/origin, be upfront and clear: they are tested, certified replica (aftermarket) parts from well-known factories (Taiwan/China), NOT OEM/original. NEVER imply or let the customer believe the parts are original. You MAY frame it positively the way the dealer does — certified, tested, sold in the US/Canada/EU/UAE markets — but never misrepresent.
- WARRANTY SCOPE: the 3-month warranty applies specifically to HEADLIGHTS (ფარები) — the company has its own headlight factory. Do NOT promise warranty on other parts. If asked about warranty on a non-headlight part, say you'll confirm the exact terms with the team.
- UNKNOWN INFO: for things marked unknown in BUSINESS INFO (payment methods, exact delivery cost/time, return policy, installation) do NOT invent an answer. Say you'll confirm with the team and offer to take the customer's name + phone, or invite them to call the branch directly. (General delivery — "all over Georgia" — you may state; the exact cost and timing are the unknown parts.)

# LEAD CAPTURE (internal — for the team, NEVER shown to the customer)
- After writing your Georgian reply, decide whether this turn should create a follow-up LEAD for a human teammate. Create one when ANY of these is true:
  • the requested part is NOT in the catalog, or the car isn't carried;
  • you told the customer you'd CONFIRM price, stock, availability, or a policy with the team;
  • the customer left contact info (name / phone) or asked to be contacted or called back.
- Do NOT create a lead for ordinary in-stock answers, greetings, or small talk with no follow-up.
- TO RECORD A LEAD: write your normal Georgian reply to the customer FIRST, then add a final line that is EXACTLY this marker:
  ${LEAD_MARKER}
  and on the next line a single-line JSON object with these keys (use null for anything not provided — NEVER invent names or contact info):
  {"part": <string|null>, "car": <string|null>, "customer_name": <string|null>, "contact": <string|null>, "note": <short Georgian summary of what's needed / why to follow up>}
- The customer must NEVER see the marker or the JSON — they are stripped out automatically. If no lead is needed, do NOT add the marker at all.

# BE PROACTIVE
- Never leave the conversation hanging. If the customer goes quiet, gives a one-word reply, or just says
  "კი" / "yes", ask the natural next question (year/trim, quantity, delivery city, or contact details).
- Ask only ONE clear question at a time. Keep momentum toward a concrete next step (confirm, reserve, order, or follow-up).

# IMPORTANT
- Be honest. If you're unsure or it's not in the catalog, say you'll check — never bluff or make up parts, prices, codes, or compatibility.`;

/** Effective price: a non-zero newprice is a discount; otherwise use price. */
function effectivePrice(p) {
  if (typeof p.newprice === 'number' && p.newprice > 0) return p.newprice;
  return p.price;
}

/** Build the searchable text for a part (tolerant to all schemas). */
function searchText(p) {
  return [
    p.title_ka,
    p.title_en,
    p.title_ru,
    p.car && p.car.name,
    p.car_name, // trimmed-schema flat car name
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
 * under the free-tier token limit. Tolerant to all schemas.
 *
 * NOTE: `stock` is passed through RAW (null / negative / large values kept) so
 * the model can apply the "stock is unreliable" rules in the system instruction
 * instead of us silently coercing missing stock to 0 (= falsely "out of stock").
 */
function compactPart(p) {
  const out = {
    id: p.id,
    name: p.title_ka || p.title_en || p.title_ru || p.name || null,
    car_name:
      (p.car && p.car.name) ||
      p.car_name ||
      [p.make, p.model, p.year].filter(Boolean).join(' ') ||
      null,
    price: effectivePrice(p),
    stock: p.stock == null ? null : p.stock,
  };
  if (p.compatible_with) out.compatible_with = p.compatible_with;
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

/** Build the full system instruction: behavior rules + business info + the (filtered) catalog. */
function buildSystemInstruction(relevantParts) {
  const catalog = JSON.stringify(relevantParts.map(compactPart), null, 1);
  const business = JSON.stringify(BUSINESS_INFO, null, 1);
  return `${BEHAVIOR_RULES}

# BUSINESS INFO (the dealer's own facts — who/where/when/policies; use for non-catalog questions)
${business}

# PARTS CATALOG (the only parts you have; "price" is in ₾, "stock" is a units figure — see STOCK rules)
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
 * Normalize a raw lead object (parsed from the model) into the lead shape,
 * trimming strings and coercing empty/missing values to null. Returns null when
 * there is no usable information at all.
 */
function normalizeLead(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const clean = (v) => {
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    return null;
  };
  const lead = {
    part: clean(obj.part),
    car: clean(obj.car),
    customer_name: clean(obj.customer_name),
    contact: clean(obj.contact),
    note: clean(obj.note),
  };
  return Object.values(lead).some((v) => v !== null) ? lead : null;
}

/**
 * Split the model's raw output into the customer-facing reply and an optional
 * structured lead. Everything from LEAD_MARKER onward is internal: it's removed
 * from the reply and parsed as the lead JSON. A malformed lead is dropped (and
 * logged) so a bad marker can never corrupt or leak into the customer's reply.
 */
function splitReplyAndLead(raw) {
  const text = (raw || '').trim();
  const idx = text.indexOf(LEAD_MARKER);
  if (idx === -1) return { reply: text, lead: null };

  const reply = text.slice(0, idx).trim();
  const after = text.slice(idx + LEAD_MARKER.length).trim();
  let lead = null;
  try {
    lead = normalizeLead(JSON.parse(after));
  } catch (err) {
    console.warn('[brain] lead marker present but JSON could not be parsed; dropping lead.');
  }
  return { reply, lead };
}

/**
 * THE one entry point. Takes conversation history + parts and returns
 *   { reply: string, lead: null | { part, car, customer_name, contact, note } }
 * `reply` is the Georgian customer reply; `lead` is set only when this turn
 * should be recorded for a human teammate (otherwise null). The brain only
 * SIGNALS the lead — it never sends anything. Never throws: on any error it
 * returns a friendly Georgian reply and lead = null.
 */
async function answerCustomer(messages, parts) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      reply:
        'ბოდიში, ასისტენტი ჯერ არ არის კონფიგურირებული (API გასაღები არ მოიძებნა). გთხოვთ, დაუკავშირდეთ ჩვენს გუნდს.',
      lead: null,
    };
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

    const { reply, lead } = splitReplyAndLead(result.response.text());
    return {
      reply: reply || 'ბოდიში, ვერ მოვახერხე პასუხის ჩამოყალიბება. გთხოვთ, სცადოთ თავიდან.',
      lead,
    };
  } catch (err) {
    if (isRateLimitError(err)) {
      return {
        reply: 'ერთი წუთით დაიცადეთ და თავიდან სცადეთ 🙏 (სისტემა ამ წუთას დატვირთულია).',
        lead: null,
      };
    }
    console.error('[brain] answerCustomer error:', err);
    return {
      reply: 'ბოდიში, ტექნიკური ხარვეზი მოხდა. გთხოვთ, ცოტა ხანში სცადოთ თავიდან.',
      lead: null,
    };
  }
}

module.exports = { answerCustomer, MODEL_NAME };
