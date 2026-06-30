# ავტონაწილების ასისტენტი — Car-Parts Chat Assistant (Local MVP)

A Georgian-language customer-service chat assistant for car-parts dealers.
It answers customers instantly about **stock, price, and next steps**, and
collects follow-up details when a part isn't available. This is a local-only
MVP — a chat window you talk to yourself — built so the "brain" can later be
reused **unchanged** behind a Meta Messenger / Instagram webhook.

## Run it

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Add your Gemini API key**
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and paste your key:
   ```
   GEMINI_API_KEY=your_key_here
   ```
   Get a free key at https://aistudio.google.com/app/apikey
   (Free tier: 500 requests/day, 250K tokens/min.)

3. **Start**
   ```bash
   npm start
   ```

4. Open **http://localhost:3000** and start chatting (in Georgian).

## Try these

- `Corolla 2021 წინა ბამპერი გაქვთ?` → in stock, gives price, offers a photo + next step.
- `ფოტო თუ შეიძლება?` → replies with the part's photo (rendered inline in the chat).
- `Prius 2013 მარცხენა ფარი` → out of stock, offers to take your name + phone.
- `BMW X5 2020 ფარი` → not in catalog, collects part + car + contact and promises follow-up.

## Where to put your real data

Drop the dealer's raw export (partsauto-style, many fields per object) at
**`data/raw_parts.json`**, then run the transform to produce the catalog the app
loads:

```bash
node scripts/transform.js   # data/raw_parts.json  →  parts.json
```

It trims every raw object down to just the fields the brain needs and overwrites
`parts.json` (re-runnable — run it again whenever the raw data changes):

```json
{
  "id": 2351,
  "name": "წინა ბამპერის კომპლექტი XLE",
  "compatible_with": "COROLLA 2019-25",
  "car_name": "COROLLA 2019-2025",
  "price": 400,
  "stock": 5,
  "oem": null,
  "code": null
}
```

| Field | Used for |
|-------|----------|
| `name` (from raw `title_ka`) | part name |
| `compatible_with` | free-text compatibility, e.g. `"COROLLA 2019-25"` — **preferred** match signal |
| `car_name` (from raw `car.name`) | the vehicle — model + year range (often less accurate) |
| `price` | price in ₾ (`null` / `<= 1` treated as unknown — not quoted) |
| `stock` | units figure — **unreliable**; never quoted literally (see below) |
| `oem` / `code` | manufacturer part numbers (matching) |

- **Data quirks** are handled in the system instruction in [`src/brain.js`](src/brain.js):
  stock is treated as unreliable (likely-available / out-of-stock / unknown, never a literal count),
  placeholder prices aren't quoted, `compatible_with` is preferred over `car_name`, and the
  assistant asks for year + trim on ambiguous matches.
- The server loads `parts.json` once at startup, so **restart** after running the transform.
- The brain is also tolerant of the full **partsauto.ge export** shape
  (`title_ka`, nested `car.name`, `image`, `newprice`, …) and a simpler
  `{ name, make, model, year, price, stock, url, image }` shape, so you can also just
  drop a `parts.json` straight in without transforming.

## Business info (non-catalog facts)

**`business_info.json`** (project root) holds everything that *isn't* a part: brand,
branches (address / phone / map), working hours, delivery, warranty, and a `stock_note`.
The parts catalog answers **what / how much / in stock**; `business_info.json` answers
**where / when / how / policies**. The brain loads it once at startup and uses it for
questions like "სად ხართ?", "სამუშაო საათები?", "ორიგინალია?", or "გარანტია გაქვთ?".

- It's loaded separately from `parts.json`, so editing it doesn't touch the catalog
  (restart the server after editing — it's read once at startup).
- The `unknown` block lists facts the dealer hasn't confirmed yet (payment methods, exact
  delivery cost/time, return policy, installation). Their values are `null` and the
  assistant will say it needs to confirm rather than guess — **fill these in once confirmed
  with the dealer** (replace the `null` with the real text) and the assistant will use them.
- A few facts are handled with care in the prompt: parts are **non-original** (certified
  replicas — the assistant is told never to claim they're OEM/original), and the **3-month
  warranty applies to headlights specifically**.

## Architecture (brain vs. interface)

The AI logic and the interface are kept **strictly separate** on purpose:

| File | Role |
|------|------|
| **`src/brain.js`** | The brain. Exports one function: `answerCustomer(messages, parts) -> { reply, lead }`. The **only** place the AI is called. No Express, no HTTP, no DOM — pure logic, and it never sends anything. |
| `src/server.js` | Thin Express wrapper: loads `parts.json`, serves the frontend, exposes `POST /chat`. |
| `src/notify.js` | Thin plumbing: `sendLead(lead)` pushes a captured lead to Telegram. |
| `public/` | Plain HTML/CSS/JS chat UI. Keeps history in memory, calls `/chat`. |

### Swapping the model

The model name is a single constant at the top of [`src/brain.js`](src/brain.js):

```js
const MODEL_NAME = 'gemini-3.1-flash-lite';
```

Change it to `gemini-3.5-flash` or `gemini-2.5-flash` for higher quality
(uses more of the free-tier quota). To swap providers entirely, edit **only**
`brain.js`.

## 👉 When you add Messenger / Instagram later

**Reuse `src/brain.js` as-is.** Do not modify it. In your Meta webhook handler:

1. On an incoming message, build the conversation `messages` array
   (`[{ role: "user" | "assistant", content }]`) from the thread.
2. `const { reply, lead } = await answerCustomer(messages, parts);`
3. Send `reply` back via the Meta Send API, and if `lead` is set, `sendLead(lead)`.
   (This is exactly what [`src/messenger.js`](src/messenger.js) already does.)

`server.js` and `public/` are just one interface (a local web chat); the webhook
is simply another interface calling the same `answerCustomer()`. Nothing about
the brain needs to change.

## Lead notifications (Telegram)

When the bot captures a lead it can't fully resolve — a part that isn't in the
catalog, a price/stock/policy it needs to confirm, or a customer who left contact
info or asked to be called back — it pushes a notification to Telegram so a human
can act on it. (The Messenger conversation also stays in the Page inbox as backup;
this is the active push on top of that.)

How it stays clean: the **brain only signals** the lead. `answerCustomer()` returns
`{ reply, lead }`, where `lead` is `null` or `{ part, car, customer_name, contact, note }`
(any field may be `null`). The brain never sends anything. The plumbing
([`src/server.js`](src/server.js) / [`src/messenger.js`](src/messenger.js)) replies
to the customer first, then calls `sendLead(lead)` in [`src/notify.js`](src/notify.js).
If Telegram fails it just logs — the customer's reply is never blocked.

**Setup:**

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram, send
   `/newbot`, follow the prompts, and copy the **bot token** it gives you into
   `TELEGRAM_BOT_TOKEN` in `.env`.
2. **Get the chat id** — decide where leads should land:
   - *Your own DM:* message your new bot once, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`.
   - *A team group:* add the bot to the group, send any message there, then call the
     same `getUpdates` URL and read the group `chat.id` (group ids are negative).
   Put that value in `TELEGRAM_CHAT_ID`.
3. Restart the server. Leave either var unset and notifications are simply skipped
   (logged), so the assistant keeps working.

> **Multi-dealer note:** the destination chat id is **per-dealer**. For now it's a
> single `TELEGRAM_CHAT_ID` env var (one shop); when this serves multiple dealers the
> chat id moves into each dealer's config and `sendLead` is passed the right destination.

## Notes

- **Rate limits:** if Gemini returns a 429 / quota error, the brain catches it and
  returns a friendly Georgian message instead of crashing.
- **Token protection:** a keyword pre-filter (`selectRelevantParts` in `brain.js`)
  sends only relevant parts to the model when the catalog is large. For the small
  sample it sends everything.
- No auth, no database, no deployment config — local testing only.
