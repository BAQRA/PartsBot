# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Georgian-language car-parts customer-service chat assistant (partsauto.ge). Local-only MVP: a web chat you talk to yourself, deliberately built so the AI "brain" can later be reused **unchanged** behind a Meta Messenger / Instagram webhook.

## Commands

```bash
npm install          # install deps
cp .env.example .env # then add GEMINI_API_KEY=...  (required; get one at aistudio.google.com/app/apikey)
npm start            # node src/server.js → http://localhost:3000
```

There are no tests, linter, or build step. `PORT` env var overrides the default 3000.

## Architecture: brain vs. interface (the core invariant)

The AI logic and every interface are kept **strictly separate**, and this separation is the whole point of the project — preserve it.

- **[src/brain.js](src/brain.js)** — the brain, and the **only** place the AI is ever called. Exports one function: `answerCustomer(messages, parts) -> Promise<{ reply, lead }>`. Knows nothing about Express, HTTP, the DOM, or Messenger — and it **never sends anything itself**. `messages` is `[{ role: "user"|"assistant", content }]`. Returns `{ reply, lead }`: `reply` is the Georgian reply string; `lead` is `null`, or `{ part, car, customer_name, contact, note }` (any field may be `null`) when the turn should be recorded for a human to follow up. The brain only *signals* a lead; the plumbing (`server.js`/`messenger.js`) sends it via `notify.js`. **Never throws** — on any error (including rate limits) it returns a friendly Georgian `reply` and `lead: null`.
- **[src/server.js](src/server.js)** — thin Express wrapper. Loads `parts.json` once at startup, serves `public/`, exposes `POST /chat { messages } -> { reply }`. No intelligence here.
- **[public/](public/)** — plain HTML/CSS/JS chat UI. Holds history in memory, posts the whole history to `/chat`.

When adding a Messenger/Instagram webhook later: **import `brain.js` as-is, do not modify it.** Build the `messages` array from the thread, call `answerCustomer()`, send the result back. `server.js` and `public/` are just one interface among several. To swap the AI provider, edit **only** `brain.js`.

## brain.js specifics

- **Model** is a single constant `MODEL_NAME` at the top (currently `gemini-3.1-flash-lite`). Swap to `gemini-3.5-flash` / `gemini-2.5-flash` for higher quality at more quota cost.
- **Behavior** lives entirely in the `BEHAVIOR_RULES` system-instruction string: Georgian-only replies, three response modes (in stock / out of stock / not in catalog), never invent parts/prices/codes/image links, ask one question at a time. Change behavior here, not in code.
- **Lead capture (the `lead` half of the return value)** — for follow-ups the bot can't fully resolve (part not in catalog, price/stock/policy to confirm, or the customer left contact info / asked for a callback), the model appends a `LEAD_MARKER` line (`===LEAD_JSON===`) followed by a one-line JSON object **after** its Georgian reply. `splitReplyAndLead()` strips everything from the marker onward out of the customer-facing `reply` and parses it into `lead` (`normalizeLead()` coerces blanks to `null`). A malformed lead is dropped and logged — it never leaks into the reply. The brain only signals; **sending lives in [src/notify.js](src/notify.js)** (`sendLead()`), which the plumbing calls *after* replying so a notification failure can't block the customer's reply.
- **Token protection** — `selectRelevantParts()` is a keyword pre-filter that scores parts against recent user message tokens (works for Georgian, Latin, and numeric tokens). Tunables at top of file: `FILTER_THRESHOLD` (below this catalog size, send everything), `MAX_PARTS_SENT`, `NO_MATCH_FALLBACK`. Keeps requests under the free-tier 250K tokens/min limit. `compactPart()` then strips each part to only the fields the model needs.

## Data: parts.json

- Lives in the project root, **loaded once at server startup** — restart after editing/replacing it.
- The brain is **tolerant of two schemas**: the full partsauto.ge export (`title_ka`/`title_en`/`title_ru`, nested `car.name` like `"COROLLA 2019-2025"`, `price`, `newprice`, `stock`, `oem`, `code`, `compatible_with`, `image`) and a simpler `{ name, make, model, year, price, stock, url, image }`. When touching catalog handling, keep both paths working (see `searchText()`, `compactPart()`, `effectivePrice()`).
- `newprice` is a discount **only when > 0** (`0` means no discount — `effectivePrice()` falls back to `price`).
- Photo URLs are built as `IMAGE_BASE_URL + part.image` (constant at top of `brain.js`).

## Image rendering convention

The brain emits a part's image as a **plain URL on its own line** in the reply text. The frontend ([public/app.js](public/app.js) `extractImageUrls()`) regex-scrapes image URLs from the assistant text and renders them inline as `<img>`. So images flow as text through the brain — there is no separate image field in the API response.
