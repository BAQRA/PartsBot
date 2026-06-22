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

Replace **`parts.json`** in the project root with your own catalog (an array of parts).
The brain reads the **partsauto.ge export** shape and uses these fields:

| Field | Used for |
|-------|----------|
| `title_ka` (or `title_en` / `title_ru`) | part name |
| `car.name` (e.g. `"COROLLA 2019-2025"`) | the vehicle — model + year range |
| `compatible_with` | extra compatibility note |
| `price` | price in ₾ |
| `newprice` | discounted price **only if > 0** (`0` = no discount, ignored) |
| `stock` | units available (`0` = out of stock) |
| `oem` / `code` | manufacturer part numbers (matching) |
| `image` | photo filename → full URL is `https://api.partsauto.ge/storage/files/parts/` + `image` |

- The image base URL is a constant (`IMAGE_BASE_URL`) at the top of [`src/brain.js`](src/brain.js).
- The server loads `parts.json` once at startup, so **restart** after replacing it.
- The brain is also tolerant of a simpler `{ name, make, model, year, price, stock, url, image }` shape.

## Architecture (brain vs. interface)

The AI logic and the interface are kept **strictly separate** on purpose:

| File | Role |
|------|------|
| **`src/brain.js`** | The brain. Exports one function: `answerCustomer(messages, parts) -> reply`. The **only** place the AI is called. No Express, no HTTP, no DOM — pure logic. |
| `src/server.js` | Thin Express wrapper: loads `parts.json`, serves the frontend, exposes `POST /chat`. |
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
2. `const reply = await answerCustomer(messages, parts);`
3. Send `reply` back via the Meta Send API.

`server.js` and `public/` are just one interface (a local web chat); the webhook
is simply another interface calling the same `answerCustomer()`. Nothing about
the brain needs to change.

## Notes

- **Rate limits:** if Gemini returns a 429 / quota error, the brain catches it and
  returns a friendly Georgian message instead of crashing.
- **Token protection:** a keyword pre-filter (`selectRelevantParts` in `brain.js`)
  sends only relevant parts to the model when the catalog is large. For the small
  sample it sends everything.
- No auth, no database, no deployment config — local testing only.
