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

- **[src/brain.js](src/brain.js)** — the brain, and the **only** place the AI is ever called. Exports one function: `answerCustomer(messages, parts) -> Promise<string>`. Knows nothing about Express, HTTP, the DOM, or Messenger. `messages` is `[{ role: "user"|"assistant", content }]`; returns a plain Georgian reply string. **Never throws** — on any error (including rate limits) it returns a friendly Georgian fallback message.
- **[src/server.js](src/server.js)** — thin Express wrapper. Loads `parts.json` once at startup, serves `public/`, exposes `POST /chat { messages } -> { reply }`. No intelligence here.
- **[public/](public/)** — plain HTML/CSS/JS chat UI. Holds history in memory, posts the whole history to `/chat`.

When adding a Messenger/Instagram webhook later: **import `brain.js` as-is, do not modify it.** Build the `messages` array from the thread, call `answerCustomer()`, send the result back. `server.js` and `public/` are just one interface among several. To swap the AI provider, edit **only** `brain.js`.

## brain.js specifics

- **Model** is a single constant `MODEL_NAME` at the top (currently `gemini-3.1-flash-lite`). Swap to `gemini-3.5-flash` / `gemini-2.5-flash` for higher quality at more quota cost.
- **Behavior** lives entirely in the `BEHAVIOR_RULES` system-instruction string: Georgian-only replies, three response modes (in stock / out of stock / not in catalog), never invent parts/prices/codes/image links, ask one question at a time. Change behavior here, not in code.
- **Token protection** — `selectRelevantParts()` is a keyword pre-filter that scores parts against recent user message tokens (works for Georgian, Latin, and numeric tokens). Tunables at top of file: `FILTER_THRESHOLD` (below this catalog size, send everything), `MAX_PARTS_SENT`, `NO_MATCH_FALLBACK`. Keeps requests under the free-tier 250K tokens/min limit. `compactPart()` then strips each part to only the fields the model needs.

## Data: parts.json

- Lives in the project root, **loaded once at server startup** — restart after editing/replacing it.
- The brain is **tolerant of two schemas**: the full partsauto.ge export (`title_ka`/`title_en`/`title_ru`, nested `car.name` like `"COROLLA 2019-2025"`, `price`, `newprice`, `stock`, `oem`, `code`, `compatible_with`, `image`) and a simpler `{ name, make, model, year, price, stock, url, image }`. When touching catalog handling, keep both paths working (see `searchText()`, `compactPart()`, `effectivePrice()`).
- `newprice` is a discount **only when > 0** (`0` means no discount — `effectivePrice()` falls back to `price`).
- Photo URLs are built as `IMAGE_BASE_URL + part.image` (constant at top of `brain.js`).

## Image rendering convention

The brain emits a part's image as a **plain URL on its own line** in the reply text. The frontend ([public/app.js](public/app.js) `extractImageUrls()`) regex-scrapes image URLs from the assistant text and renders them inline as `<img>`. So images flow as text through the brain — there is no separate image field in the API response.
