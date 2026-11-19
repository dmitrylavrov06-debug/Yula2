// Cloudflare Worker: сайт-чат + защищённый прокси к OpenAI-совместимому API.
// Ключ НЕ хранится в коде — он задаётся как секрет API_KEY в настройках Worker.
//
// Переменные (Settings → Variables and Secrets):
//   API_KEY         (Secret, обязательно) — ваш ключ
//   BASE_URL        (необязательно) — по умолчанию https://darkseek-console.duckdns.org/v1
//   MODEL           (необязательно) — модель по умолчанию; иначе берётся первая из списка
//   BOT_NAME        (необязательно) — имя вашего ИИ
//   SYSTEM_PROMPT   (необязательно) — характер/инструкции для ИИ
//   ACCESS_PASSWORD (необязательно) — пароль на вход, чтобы чужие не тратили баланс

const DEFAULT_BASE = "https://darkseek-console.duckdns.org/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = (env.BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
    const botName = env.BOT_NAME || "Мой ИИ";

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(renderPage(botName, !!env.ACCESS_PASSWORD), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (env.ACCESS_PASSWORD && request.headers.get("x-access-password") !== env.ACCESS_PASSWORD) {
        return json({ error: "Неверный пароль" }, 401);
      }
      if (!env.API_KEY) return json({ error: "На сервере не задан API_KEY" }, 500);
      const auth = { Authorization: `Bearer ${env.API_KEY}` };

      if (url.pathname === "/api/models" && request.method === "GET") {
        try {
          const r = await fetch(`${base}/models`, { headers: auth });
          const data = await r.json();
          const ids = (data.data || []).map((m) => m.id);
          return json({ models: ids, default: env.MODEL || ids[0] || "" });
        } catch (e) {
          return json({ models: env.MODEL ? [env.MODEL] : [], default: env.MODEL || "" });
        }
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Плохой запрос" }, 400); }
        const history = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
        const messages = [];
        if (env.SYSTEM_PROMPT) messages.push({ role: "system", content: env.SYSTEM_PROMPT });
        for (const m of history) {
          if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
            messages.push({ role: m.role, content: m.content.slice(0, 20000) });
          }
        }
        let upstream;
        try {
          upstream = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ model: body.model || env.MODEL, messages, stream: true }),
          });
        } catch (e) {
          return json({ error: `Не удалось подключиться к API: ${e.message}` }, 502);
        }
        if (!upstream.ok) {
          const text = await upstream.text();
          return json({ error: `Ошибка API (${upstream.status}): ${text.slice(0, 500)}` }, 502);
        }
        return new Response(upstream.body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage(botName, needPassword) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(botName)}</title>
<style>
  :root { --bg:#0d0f14; --panel:#161a22; --line:#262c38; --text:#e8ebf1; --muted:#8a93a6; --accent:#7c5cff; --user:#2a2f3d; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  body { display:flex; flex-direction:column; height:100dvh; }
  header { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line);
    padding-top:max(12px, env(safe-area-inset-top)); }
  .logo { width:32px; height:32px; border-radius:10px; background:linear-gradient(135deg,var(--accent),#22d3ee); }
  header h1 { font-size:17px; margin:0; flex:1; }
  select, button.ghost { background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:10px; padding:6px 10px; font-size:13px; max-width:40vw; }
  #chat { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
  .msg { max-width:min(760px, 92%); padding:10px 14px; border-radius:16px; white-space:pre-wrap; word-wrap:break-word; }
  .user { align-self:flex-end; background:var(--user); border-bottom-right-radius:4px; }
  .bot { align-self:flex-start; background:var(--panel); border:1px solid var(--line); border-bottom-left-radius:4px; }
  .err { align-self:center; color:#ff8a8a; font-size:14px; }
  .msg pre { background:#0a0c10; border:1px solid var(--line); border-radius:8px; padding:10px; overflow-x:auto; white-space:pre; }
  .msg code { font-family:ui-monospace,Menlo,monospace; font-size:14px; }
  .empty { margin:auto; text-align:center; color:var(--muted); }
  .empty .logo { width:56px; height:56px; border-radius:18px; margin:0 auto 12px; }
  form { display:flex; gap:8px; padding:12px; border-top:1px solid var(--line);
    padding-bottom:max(12px, env(safe-area-inset-bottom)); }
  textarea { flex:1; resize:none; background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:14px; padding:10px 14px; font:inherit; max-height:160px; outline:none; }
  textarea:focus { border-color:var(--accent); }
  #send { background:var(--accent); color:#fff; border:0; border-radius:14px; padding:0 18px; font-size:15px; font-weight:600; }
  #send:disabled { opacity:.5; }
  .cursor::after { content:"▍"; animation:blink 1s infinite; color:var(--accent); }
  @keyframes blink { 50% { opacity:0; } }
</style>
</head>
<body>
<header>
  <div class="logo"></div>
  <h1>${esc(botName)}</h1>
  <select id="model" title="Модель"></select>
  <button class="ghost" id="clear" title="Новый чат">Очистить</button>
</header>
<main id="chat"></main>
<form id="form">
  <textarea id="input" rows="1" placeholder="Напишите сообщение…"></textarea>
  <button id="send" type="submit">➤</button>
</form>
<script>
const NEED_PASSWORD = ${needPassword};
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const form = document.getElementById("form");
const sendBtn = document.getElementById("send");
const modelSel = document.getElementById("model");
let history = [];
try { history = JSON.parse(localStorage.getItem("history") || "[]"); } catch {}
let password = "";
try { password = localStorage.getItem("pwd") || ""; } catch {}

function save() { try { localStorage.setItem("history", JSON.stringify(history)); } catch {} }
function headers() {
  if (NEED_PASSWORD && !password) {
    password = prompt("Пароль для доступа:") || "";
    try { localStorage.setItem("pwd", password); } catch {}
  }
  return { "Content-Type": "application/json", "x-access-password": password };
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c])); }
function format(text) {
  const parts = text.split("\\u0060\\u0060\\u0060");
  return parts.map((p, i) => {
    if (i % 2) { const nl = p.indexOf("\\n"); return "<pre><code>" + escapeHtml(nl >= 0 ? p.slice(nl + 1) : p) + "</code></pre>"; }
    return escapeHtml(p).replace(/\\u0060([^\\u0060\\n]+)\\u0060/g, "<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
  }).join("");
}
function addMsg(role, text) {
  const d = document.createElement("div");
  d.className = "msg " + role;
  d.innerHTML = format(text);
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}
function render() {
  chat.innerHTML = "";
  if (!history.length) {
    chat.innerHTML = '<div class="empty"><div class="logo"></div>Привет! Я ' + escapeHtml(document.title) + '.<br>Спросите что угодно.</div>';
    return;
  }
  for (const m of history) addMsg(m.role === "user" ? "user" : "bot", m.content);
}

async function loadModels() {
  try {
    const r = await fetch("/api/models", { headers: headers() });
    if (r.status === 401) { password = ""; try { localStorage.removeItem("pwd"); } catch {} return loadModels(); }
    const d = await r.json();
    const saved = (() => { try { return localStorage.getItem("model"); } catch { return null; } })();
    modelSel.innerHTML = d.models.map(m => '<option>' + escapeHtml(m) + '</option>').join("");
    modelSel.value = d.models.includes(saved) ? saved : d.default;
    if (!d.models.length) modelSel.style.display = "none";
  } catch { modelSel.style.display = "none"; }
}
modelSel.onchange = () => { try { localStorage.setItem("model", modelSel.value); } catch {} };

form.onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  if (!history.length) chat.innerHTML = "";
  history.push({ role: "user", content: text });
  addMsg("user", text);
  input.value = ""; input.style.height = "auto";
  sendBtn.disabled = true;
  const bubble = addMsg("bot", "");
  bubble.classList.add("cursor");
  let answer = "";
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ messages: history, model: modelSel.value || undefined }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { password = ""; try { localStorage.removeItem("pwd"); } catch {} }
      throw new Error(d.error || ("Ошибка " + r.status));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\\n");
      buf = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) { answer += delta; bubble.innerHTML = format(answer); chat.scrollTop = chat.scrollHeight; }
        } catch {}
      }
    }
    if (!answer) throw new Error("Пустой ответ от модели");
    history.push({ role: "assistant", content: answer });
    save();
  } catch (err) {
    history.pop();
    bubble.remove();
    const d = document.createElement("div");
    d.className = "msg err"; d.textContent = "⚠ " + err.message;
    chat.appendChild(d);
  } finally {
    bubble.classList.remove("cursor");
    sendBtn.disabled = false;
  }
};
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 700) { e.preventDefault(); form.requestSubmit(); }
});
document.getElementById("clear").onclick = () => { history = []; save(); render(); };

render();
loadModels();
</script>
</body>
</html>`;
}
