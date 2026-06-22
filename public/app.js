// Frontend chat logic. Keeps the conversation history in memory and talks to
// the /chat endpoint. The server (and brain) hold all the real logic.

const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');

// Conversation history in the { role, content } shape the brain expects.
const history = [];

const GREETING =
  'გამარჯობა! 👋 მე ვარ ავტონაწილების ასისტენტი. რომელი მანქანის რა ნაწილი გჭირდებათ? (მაგ.: Toyota Prius 2012 — წინა ბამპერი)';

/** Pull any image URLs out of a reply so we can render them as actual photos. */
function extractImageUrls(text) {
  const re = /https?:\/\/\S+?\.(?:jpg|jpeg|png|webp|gif)/gi;
  const found = text.match(re) || [];
  // Strip trailing punctuation and de-duplicate.
  return [...new Set(found.map((u) => u.replace(/[)\].,;]+$/, '')))];
}

/** Render a message bubble. role: "user" | "assistant". */
function addBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (role === 'user' ? 'bubble--user' : 'bubble--bot');
  bubble.textContent = text;
  messagesEl.appendChild(bubble);

  // If the assistant sent image links, show the photos inline.
  if (role === 'assistant') {
    for (const url of extractImageUrls(text)) {
      const img = document.createElement('img');
      img.className = 'bubble__image';
      img.src = url;
      img.alt = 'ნაწილის ფოტო';
      img.loading = 'lazy';
      img.onerror = () => img.remove(); // hide broken/unavailable images
      messagesEl.appendChild(img);
    }
  }

  scrollToBottom();
}

/** Show the animated typing indicator and return its element so we can remove it. */
function showTyping() {
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(typing);
  scrollToBottom();
  return typing;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setBusy(busy) {
  inputEl.disabled = busy;
  sendEl.disabled = busy;
  if (!busy) inputEl.focus();
}

async function sendMessage(text) {
  // 1. Show + record the user's message.
  addBubble('user', text);
  history.push({ role: 'user', content: text });

  setBusy(true);
  const typing = showTyping();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });

    const data = await res.json();
    const reply = data.reply || 'ბოდიში, პასუხი ვერ მივიღე. სცადეთ თავიდან.';

    typing.remove();
    addBubble('assistant', reply);
    history.push({ role: 'assistant', content: reply });
  } catch (err) {
    typing.remove();
    addBubble('assistant', 'ბოდიში, კავშირი ვერ დამყარდა. გთხოვთ, სცადოთ თავიდან.');
    console.error(err);
  } finally {
    setBusy(false);
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  sendMessage(text);
});

// Greet the user on load (display only — not part of the model history).
addBubble('assistant', GREETING);
inputEl.focus();
