// ИИ-чат с подпиской: вход через Telegram, оплата через Crypto Pay (@CryptoBot),
// учёт токенов с наценкой. Node.js 22+, без внешних зависимостей.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

const CFG = {
  port: Number(env.PORT || 3000),
  host: env.HOST || "0.0.0.0",
  baseUrl: (env.BASE_URL || "https://darkseek-console.duckdns.org/v1").replace(/\/+$/, ""),
  apiKey: env.API_KEY || "",
  botName: env.BOT_NAME || "Мой ИИ",
  systemPrompt: env.SYSTEM_PROMPT || "",
  defaultModel: env.MODEL || "",
  models: list(env.MODELS),
  botToken: env.BOT_TOKEN || "",
  cryptoToken: env.CRYPTOPAY_TOKEN || "",
  cryptoTestnet: env.CRYPTOPAY_TESTNET === "1",
  admins: list(env.ADMIN_TG_IDS),
  priceIn: Number(env.PRICE_IN_PER_1M || 0.5),   // ваша себестоимость, $ за 1M входящих токенов
  priceOut: Number(env.PRICE_OUT_PER_1M || 1.5), // ваша себестоимость, $ за 1M исходящих токенов
  markup: Number(env.MARKUP || 10),
  freeBudget: Number(env.FREE_BUDGET_USD ?? 0.01), // бесплатный пробный лимит в $ себестоимости
  publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
  dataDir: env.DATA_DIR || path.join(DIR, "data"),
  contextChars: Number(env.CONTEXT_CHARS || 200000),
};

const DAY = 86400000;
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 24) => crypto.randomBytes(n).toString("base64url");

// ---------- Тарифы ----------
function loadPlans() {
  for (const p of [path.join(CFG.dataDir, "plans.json"), path.join(DIR, "plans.json")]) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  return [
    { id: "pro", name: "Pro", price: 10, features: ["Больше сообщений", "Загрузка проектов"] },
    { id: "max", name: "Max", price: 30, features: ["В 3 раза больше Pro", "Приоритет"] },
  ];
}
let PLANS = loadPlans();
const planById = (id) => PLANS.find((p) => p.id === id);
const blendedPerToken = () => (CFG.priceIn * 0.75 + CFG.priceOut * 0.25) / 1e6;
const usdToTokens = (usd) => Math.max(0, Math.floor(usd / blendedPerToken()));
const planBudget = (p) => p.price / CFG.markup; // сколько себестоимости даёт тариф

// ---------- База ----------
fs.mkdirSync(CFG.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(CFG.dataDir, "app.db"));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, tg_id TEXT UNIQUE, name TEXT, username TEXT,
  plan TEXT DEFAULT 'free', plan_until INTEGER DEFAULT 0, credits REAL DEFAULT 0, spent REAL DEFAULT 0,
  paid_total REAL DEFAULT 0, banned INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, created INTEGER, updated INTEGER);
CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, files TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS msg_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, user_id INTEGER, plan TEXT, amount REAL, url TEXT, status TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, user_id INTEGER, model TEXT, tin INTEGER, tout INTEGER, cost REAL, created INTEGER);
`);
const q = (sql) => db.prepare(sql);

function refreshUser(u) {
  if (u && u.plan !== "free" && u.plan_until < now()) {
    q("UPDATE users SET plan='free', credits=0 WHERE id=?").run(u.id);
    u.plan = "free"; u.credits = 0;
  }
  return u;
}

function upsertTgUser(from) {
  const tgId = String(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Пользователь";
  const ex = q("SELECT * FROM users WHERE tg_id=?").get(tgId);
  if (ex) {
    q("UPDATE users SET name=?, username=? WHERE id=?").run(name, from.username || "", ex.id);
    return ex.id;
  }
  const r = q("INSERT INTO users(tg_id,name,username,credits,created) VALUES(?,?,?,?,?)")
    .run(tgId, name, from.username || "", CFG.freeBudget, now());
  return Number(r.lastInsertRowid);
}

function activatePlan(userId, planId, paid) {
  const p = planById(planId);
  if (!p) throw new Error("Нет такого тарифа");
  const u = refreshUser(q("SELECT * FROM users WHERE id=?").get(userId));
  const base = u.plan !== "free" && u.plan_until > now() ? u.plan_until : now();
  q("UPDATE users SET plan=?, plan_until=?, credits=credits+?, paid_total=paid_total+? WHERE id=?")
    .run(p.id, base + 30 * DAY, planBudget(p), paid ? p.price : 0, userId);
  return p;
}

// ---------- HTTP-утилиты ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Слишком большой запрос"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit) {
  const b = await readBody(req, limit);
  try { return JSON.parse(b.toString("utf8") || "{}"); } catch { throw Object.assign(new Error("Плохой JSON"), { status: 400 }); }
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const t = cookies(req).sid;
  if (!t) return null;
  const u = q("SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=?").get(t);
  if (!u || u.banned) return null;
  return refreshUser(u);
}
const isAdmin = (u) => !!u && CFG.admins.includes(String(u.tg_id));

// ---------- Модели ----------
let MODELS = CFG.models.slice();
async function loadModels() {
  if (CFG.models.length || !CFG.apiKey) return;
  try {
    const r = await fetch(`${CFG.baseUrl}/models`, { headers: { Authorization: `Bearer ${CFG.apiKey}` } });
    const d = await r.json();
    const ids = (d.data || []).map((m) => m.id).filter(Boolean);
    if (ids.length) MODELS = ids;
  } catch (e) { console.error("Не удалось получить список моделей:", e.message); }
}
const defaultModel = () => CFG.defaultModel || MODELS[0] || "";

// ---------- ZIP ----------
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|vendor|__pycache__|\.next|\.nuxt|\.venv|venv|target|\.idea|\.vscode|coverage)\//;
const SKIP_FILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store|\.min\.(js|css)|\.map)$/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svgz|pdf|zip|gz|tgz|rar|7z|tar|exe|dll|so|dylib|bin|class|jar|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|wav|ogg|webm|psd|sqlite|db|pyc)$/i;

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error("Это не ZIP-архив"), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = []; let skipped = 0; let total = 0;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith("/")) continue;
    if ((flags & 1) || SKIP_DIRS.test("/" + name) || SKIP_FILES.test(name) || BINARY_EXT.test(name) || usize > 300000 || name.startsWith("__MACOSX/")) { skipped++; continue; }
    if (total + usize > 1500000) { skipped++; continue; }
    try {
      const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnl + lel;
      const raw = buf.subarray(start, start + csize);
      const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 400000 }) : null;
      if (!data || data.includes(0)) { skipped++; continue; }
      const content = data.toString("utf8");
      total += content.length;
      files.push({ name, content });
    } catch { skipped++; }
  }
  // убрать общую корневую папку (repo-main/...)
  const roots = new Set(files.map((f) => f.name.split("/")[0]));
  if (roots.size === 1 && files.every((f) => f.name.includes("/"))) {
    const r = [...roots][0] + "/";
    for (const f of files) f.name = f.name.slice(r.length);
  }
  return { files, skipped };
}

// ---------- Чат ----------
const activeStreams = new Set();

function buildHistory(chatId) {
  const rows = q("SELECT role, content, files FROM messages WHERE chat_id=? ORDER BY id").all(chatId);
  const msgs = rows.map((r) => {
    let text = r.content || "";
    const files = r.files ? JSON.parse(r.files) : [];
    if (files.length) {
      text = files.map((f) => `<file name="${f.name}">\n${f.content}\n</file>`).join("\n\n") + (text ? "\n\n" + text : "");
    }
    return { role: r.role, content: text };
  });
  let total = msgs.reduce((s, m) => s + m.content.length, 0);
  while (msgs.length > 1 && total > CFG.contextChars) total -= msgs.shift().content.length;
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const sys = CFG.systemPrompt ||
    `Ты — ${CFG.botName}, полезный ИИ-ассистент. Отвечай на языке пользователя. Код оформляй в блоках \`\`\`язык. Используй markdown.`;
  return [{ role: "system", content: sys }, ...msgs];
}

async function handleChat(req, res, user) {
  if (activeStreams.has(user.id)) return send(res, 429, { error: "Дождитесь окончания предыдущего ответа" });
  const body = await readJson(req, 4e6);
  const text = String(body.content || "").slice(0, 200000);
  let files = Array.isArray(body.files) ? body.files.slice(0, 500) : [];
  let fsize = 0;
  files = files.map((f) => ({ name: String(f.name || "file").slice(0, 300), content: String(f.content || "") }))
    .filter((f) => (fsize += f.content.length) <= 2000000);
  if (!text.trim() && !files.length) return send(res, 400, { error: "Пустое сообщение" });
  if (user.credits <= 0) return send(res, 402, { error: "limit", message: "Лимит исчерпан. Оформите подписку, чтобы продолжить." });

  const model = MODELS.includes(body.model) ? body.model : defaultModel();
  let chat = body.chat_id ? q("SELECT * FROM chats WHERE id=? AND user_id=?").get(String(body.chat_id), user.id) : null;
  if (!chat) {
    const title = (text.trim() || files[0]?.name || "Новый чат").replace(/\s+/g, " ").slice(0, 60);
    chat = { id: crypto.randomUUID(), title };
    q("INSERT INTO chats(id,user_id,title,created,updated) VALUES(?,?,?,?,?)").run(chat.id, user.id, title, now(), now());
  }
  q("INSERT INTO messages(chat_id,role,content,files,created) VALUES(?,?,?,?,?)")
    .run(chat.id, "user", text, files.length ? JSON.stringify(files) : null, now());

  const messages = buildHistory(chat.id);
  const inChars = messages.reduce((s, m) => s + m.content.length, 0);

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const emit = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  emit({ t: "chat", id: chat.id, title: chat.title });

  activeStreams.add(user.id);
  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });

  let answer = "", usage = null, error = null;
  try {
    const upstream = await fetch(`${CFG.baseUrl}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
    });
    if (!upstream.ok) {
      const t = await upstream.text();
      throw new Error(`Ошибка API (${upstream.status}): ${t.slice(0, 300)}`);
    }
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta || {};
        const think = d.reasoning_content || d.reasoning;
        if (think) emit({ t: "think", d: think });
        if (d.content) { answer += d.content; emit({ t: "delta", d: d.content }); }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") error = e.message || "Ошибка соединения с API";
  } finally {
    activeStreams.delete(user.id);
  }

  const tin = usage?.prompt_tokens ?? Math.ceil(inChars / 3);
  const tout = usage?.completion_tokens ?? Math.ceil(answer.length / 3);
  const cost = answer || usage ? (tin * CFG.priceIn + tout * CFG.priceOut) / 1e6 : 0;
  if (cost > 0) {
    q("UPDATE users SET credits=credits-?, spent=spent+? WHERE id=?").run(cost, cost, user.id);
    q("INSERT INTO usage(user_id,model,tin,tout,cost,created) VALUES(?,?,?,?,?,?)").run(user.id, model, tin, tout, cost, now());
  }
  if (answer) q("INSERT INTO messages(chat_id,role,content,created) VALUES(?,?,?,?)").run(chat.id, "assistant", answer, now());
  q("UPDATE chats SET updated=? WHERE id=?").run(now(), chat.id);

  if (!res.writableEnded && !res.destroyed) {
    const u = q("SELECT credits FROM users WHERE id=?").get(user.id);
    if (error) emit({ t: "error", message: error });
    emit({ t: "done", tokens_left: usdToTokens(u.credits) });
    res.end();
  }
}

function meInfo(u) {
  const plan = planById(u.plan);
  return {
    id: u.id, name: u.name, username: u.username, plan: u.plan, plan_name: plan?.name || "Free",
    plan_until: u.plan !== "free" ? u.plan_until : null,
    tokens_left: usdToTokens(u.credits), admin: isAdmin(u),
  };
}

// ---------- Telegram-бот (вход) ----------
let BOT_USERNAME = "";
async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}),
  });
  return r.json();
}
async function botLoop() {
  if (!CFG.botToken) return console.warn("BOT_TOKEN не задан — вход через Telegram отключён");
  while (!BOT_USERNAME) {
    try {
      const me = await tg("getMe");
      if (!me.ok) { console.error("Telegram getMe:", me.description); await sleep(10000); continue; }
      BOT_USERNAME = me.result.username;
      await tg("deleteWebhook");
      console.log("Бот: @" + BOT_USERNAME);
    } catch (e) { console.error("Telegram недоступен:", e.message); await sleep(10000); }
  }
  let offset = 0;
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const upd of r.result || []) {
        offset = upd.update_id + 1;
        onTgMessage(upd.message).catch((e) => console.error("bot:", e.message));
      }
      if (!r.ok) await sleep(5000);
    } catch { await sleep(3000); }
  }
}
async function onTgMessage(m) {
  if (!m || !m.from || m.chat?.type !== "private" || typeof m.text !== "string") return;
  const [cmd, arg] = m.text.trim().split(/\s+/, 2);
  if (cmd !== "/start") return;
  const userId = upsertTgUser(m.from);
  const login = arg ? q("SELECT * FROM logins WHERE token=?").get(arg) : null;
  if (login && !login.user_id && login.created > now() - 10 * 60000) {
    q("UPDATE logins SET user_id=? WHERE token=?").run(userId, arg);
    await tg("sendMessage", { chat_id: m.chat.id, text: "✅ Вход выполнен! Вернитесь на сайт — страница обновится сама." });
  } else {
    const site = CFG.publicUrl ? `\n\nСайт: ${CFG.publicUrl}` : "";
    await tg("sendMessage", { chat_id: m.chat.id, text: `Привет! Это бот для входа в ${CFG.botName}.${site}` });
  }
}

// ---------- Crypto Pay (@CryptoBot) ----------
async function cp(method, params) {
  const base = CFG.cryptoTestnet ? "https://testnet-pay.crypt.bot/api/" : "https://pay.crypt.bot/api/";
  const r = await fetch(base + method, {
    method: "POST", headers: { "Crypto-Pay-API-Token": CFG.cryptoToken, "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error("Crypto Pay: " + JSON.stringify(d.error));
  return d.result;
}
async function payLoop() {
  if (!CFG.cryptoToken) return console.warn("CRYPTOPAY_TOKEN не задан — оплата отключена");
  for (;;) {
    await sleep(15000);
    try {
      const rows = q("SELECT * FROM invoices WHERE status='active' AND created>?").all(now() - 3 * 3600000);
      q("UPDATE invoices SET status='expired' WHERE status='active' AND created<=?").run(now() - 3 * 3600000);
      if (!rows.length) continue;
      const res = await cp("getInvoices", { invoice_ids: rows.map((r) => r.id).join(",") });
      for (const inv of res.items || []) {
        if (inv.status === "paid") {
          const ok = q("UPDATE invoices SET status='paid' WHERE id=? AND status='active'").run(inv.invoice_id);
          if (ok.changes !== 1) continue;
          const row = rows.find((r) => r.id === inv.invoice_id);
          const p = activatePlan(row.user_id, row.plan, true);
          const u = q("SELECT tg_id FROM users WHERE id=?").get(row.user_id);
          if (CFG.botToken && u) tg("sendMessage", { chat_id: u.tg_id, text: `🎉 Оплата получена! Тариф ${p.name} активен 30 дней.` }).catch(() => {});
          console.log(`Оплата: user ${row.user_id}, тариф ${p.id}, $${p.price}`);
        } else if (inv.status === "expired") {
          q("UPDATE invoices SET status='expired' WHERE id=?").run(inv.invoice_id);
        }
      }
    } catch (e) { console.error("payLoop:", e.message); }
  }
}

// ---------- Статика ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(req, res, pathname) {
  const pub = path.join(DIR, "public");
  const file = path.normalize(path.join(pub, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(pub)) return send(res, 404, { error: "Not found" });
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!path.extname(pathname)) return serveStatic(req, res, "/"); // SPA
      return send(res, 404, { error: "Not found" });
    }
    let out = data;
    if (file.endsWith("index.html")) out = data.toString("utf8").replaceAll("{{BOT_NAME}}", CFG.botName.replace(/[<>&"]/g, ""));
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(out);
  });
}

// ---------- Роутер ----------
async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const M = req.method;
  if (!p.startsWith("/api/")) return serveStatic(req, res, p);

  if (p === "/api/config" && M === "GET") {
    return send(res, 200, { bot_name: CFG.botName, login: !!CFG.botToken, pay: !!CFG.cryptoToken });
  }
  if (p === "/api/auth/start" && M === "POST") {
    if (!BOT_USERNAME) return send(res, 503, { error: "Бот Telegram ещё не подключён. Проверьте BOT_TOKEN." });
    const token = rid(16);
    q("DELETE FROM logins WHERE created<?").run(now() - 15 * 60000);
    q("INSERT INTO logins(token,created) VALUES(?,?)").run(token, now());
    return send(res, 200, { token, url: `https://t.me/${BOT_USERNAME}?start=${token}` });
  }
  if (p === "/api/auth/poll" && M === "GET") {
    const token = url.searchParams.get("token") || "";
    const l = q("SELECT * FROM logins WHERE token=?").get(token);
    if (!l) return send(res, 200, { ok: false, expired: true });
    if (!l.user_id) return send(res, 200, { ok: false, expired: l.created < now() - 10 * 60000 });
    q("DELETE FROM logins WHERE token=?").run(token);
    const sid = rid();
    q("INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)").run(sid, l.user_id, now());
    return send(res, 200, { ok: true }, { "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90 * 86400}` });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Нужно войти" });

  if (p === "/api/auth/logout" && M === "POST") {
    q("DELETE FROM sessions WHERE token=?").run(cookies(req).sid || "");
    return send(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }
  if (p === "/api/me" && M === "GET") {
    return send(res, 200, {
      user: meInfo(user), models: MODELS, default_model: defaultModel(),
      plans: PLANS.map((pl) => ({ ...pl, tokens: usdToTokens(planBudget(pl)) })),
      free_tokens: usdToTokens(CFG.freeBudget),
    });
  }
  if (p === "/api/chats" && M === "GET") {
    return send(res, 200, q("SELECT id,title,updated FROM chats WHERE user_id=? ORDER BY updated DESC LIMIT 300").all(user.id));
  }
  const cm = p.match(/^\/api\/chats\/([\w-]+)$/);
  if (cm) {
    const chat = q("SELECT * FROM chats WHERE id=? AND user_id=?").get(cm[1], user.id);
    if (!chat) return send(res, 404, { error: "Чат не найден" });
    if (M === "GET") {
      const msgs = q("SELECT id,role,content,files FROM messages WHERE chat_id=? ORDER BY id").all(chat.id)
        .map((m) => ({ id: m.id, role: m.role, content: m.content, files: m.files ? JSON.parse(m.files).map((f) => ({ name: f.name, size: f.content.length })) : [] }));
      return send(res, 200, { id: chat.id, title: chat.title, messages: msgs });
    }
    if (M === "DELETE") {
      q("DELETE FROM messages WHERE chat_id=?").run(chat.id);
      q("DELETE FROM chats WHERE id=?").run(chat.id);
      return send(res, 200, { ok: true });
    }
    if (M === "PATCH") {
      const b = await readJson(req);
      const title = String(b.title || "").trim().slice(0, 80);
      if (title) q("UPDATE chats SET title=? WHERE id=?").run(title, chat.id);
      return send(res, 200, { ok: true });
    }
  }
  if (p === "/api/chat" && M === "POST") return handleChat(req, res, user);
  if (p === "/api/extract" && M === "POST") {
    const buf = await readBody(req, 30e6);
    return send(res, 200, unzip(buf));
  }
  if (p === "/api/pay" && M === "POST") {
    if (!CFG.cryptoToken) return send(res, 503, { error: "Оплата пока не настроена" });
    const b = await readJson(req);
    const plan = planById(b.plan);
    if (!plan || !(plan.price > 0)) return send(res, 400, { error: "Нет такого тарифа" });
    const inv = await cp("createInvoice", {
      currency_type: "fiat", fiat: "USD", amount: String(plan.price),
      accepted_assets: "USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC",
      description: `${CFG.botName} — тариф ${plan.name} на 30 дней`,
      payload: `${user.id}:${plan.id}`, expires_in: 3600,
    });
    const payUrl = inv.bot_invoice_url || inv.pay_url || inv.web_app_invoice_url;
    q("INSERT INTO invoices(id,user_id,plan,amount,url,status,created) VALUES(?,?,?,?,?,?,?)")
      .run(inv.invoice_id, user.id, plan.id, plan.price, payUrl, "active", now());
    return send(res, 200, { url: payUrl, invoice_id: inv.invoice_id });
  }

  // ----- Админка -----
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(user)) return send(res, 403, { error: "Нет доступа" });
    if (p === "/api/admin/stats" && M === "GET") {
      const s = q(`SELECT COUNT(*) users, SUM(plan!='free' AND plan_until>?) paying, COALESCE(SUM(paid_total),0) revenue,
        COALESCE(SUM(spent),0) spent FROM users`).get(now());
      const month = q("SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE status='paid' AND created>?").get(now() - 30 * DAY).v;
      const recent = q(`SELECT users.name, users.username, users.tg_id, users.plan, users.plan_until, users.credits, users.spent, users.paid_total
        FROM users ORDER BY id DESC LIMIT 50`).all().map((u) => ({ ...u, tokens_left: usdToTokens(u.credits) }));
      return send(res, 200, { ...s, month_revenue: month, profit: s.revenue - s.spent, markup: CFG.markup, users_list: recent });
    }
    if (p === "/api/admin/grant" && M === "POST") {
      const b = await readJson(req);
      const key = String(b.user || "").trim().replace(/^@/, "");
      const target = q("SELECT * FROM users WHERE tg_id=? OR lower(username)=lower(?)").get(key, key);
      if (!target) return send(res, 404, { error: "Пользователь не найден (он должен хотя бы раз войти)" });
      const pl = activatePlan(target.id, String(b.plan), false);
      return send(res, 200, { ok: true, message: `Выдан тариф ${pl.name} пользователю ${target.name}` });
    }
  }
  return send(res, 404, { error: "Not found" });
}

http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Ошибка сервера: " + e.message });
    else res.end();
  });
}).listen(CFG.port, CFG.host, () => {
  console.log(`${CFG.botName}: http://${CFG.host}:${CFG.port}`);
  if (!CFG.apiKey) console.warn("API_KEY не задан!");
});

loadModels();
botLoop();
payLoop();
