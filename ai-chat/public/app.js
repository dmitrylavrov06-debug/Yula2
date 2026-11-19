"use strict";
const $ = (s) => document.querySelector(s);
const S = { me: null, plans: [], models: [], chats: [], chatId: null, files: [], ctrl: null, busy: false, pollPay: null };
const app = $("#app"), thread = $("#thread"), scroller = $("#scroll"), input = $("#input"), sendBtn = $("#send");

// ---------- утилиты ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".0", "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
const fmtSize = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + " МБ" : n > 1e3 ? Math.round(n / 1e3) + " КБ" : n + " Б";
function toast(t, ms = 2600) { const el = $("#toast"); el.textContent = t; el.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add("hidden"), ms); }
async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.body && typeof opts.body === "string" ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } };
  const r = await fetch(path, o);
  if (r.status === 401 && !path.startsWith("/api/auth")) { showLogin(); throw new Error("Нужно войти"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.message || d.error || "Ошибка " + r.status), { status: r.status, data: d });
  return d;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  toast("Скопировано");
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- markdown ----------
const EXT = { javascript: "js", js: "js", typescript: "ts", ts: "ts", tsx: "tsx", jsx: "jsx", python: "py", py: "py", html: "html", css: "css",
  json: "json", bash: "sh", sh: "sh", shell: "sh", zsh: "sh", sql: "sql", java: "java", kotlin: "kt", c: "c", cpp: "cpp", "c++": "cpp",
  csharp: "cs", cs: "cs", go: "go", rust: "rs", php: "php", ruby: "rb", swift: "swift", yaml: "yml", yml: "yml", xml: "xml",
  markdown: "md", md: "md", dockerfile: "Dockerfile", lua: "lua", dart: "dart", vue: "vue", toml: "toml", ini: "ini", env: "env" };
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + esc(codes[i]) + "</code>");
}
function codeBlock(lang, code) {
  return `<div class="code"><div class="code-h"><span>${esc(lang || "код")}</span>` +
    `<button data-act="copy-code">Копировать</button><button data-act="dl-code" data-lang="${esc(lang)}">Скачать</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function renderList(items) {
  let html = ""; const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += "</li></" + stack.pop().tag + ">";
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ indent: it.indent, tag });
      html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ""}><li>` + inline(it.text);
    } else html += "</li><li>" + inline(it.text);
  }
  while (stack.length) html += "</li></" + stack.pop().tag + ">";
  return html;
}
function md(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let out = "", para = [], i = 0;
  const flush = () => { if (para.length) { out += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(```|~~~)\s*([\w#+.-]*)/))) {
      flush(); const fence = m[1]; const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++; out += codeBlock(m[2], code.join("\n")); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length + 0, 4); out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out += "<hr>"; i++; continue; }
    if (/^\s*>/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out += "<blockquote>" + md(q.join("\n")) + "</blockquote>"; continue;
    }
    if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush(); const head = cells(l); i += 2;
      let t = "<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) t += "<tr>" + cells(lines[i++]).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
      out += t + "</tbody></table>"; continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/);
        if (mm) { items.push({ indent: mm[1].replace(/\t/g, "    ").length, ordered: !!mm[3], start: mm[3] ? +mm[3] : 1, text: mm[4] }); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += " " + lines[i].trim(); i++; }
        else break;
      }
      out += renderList(items); continue;
    }
    para.push(l); i++;
  }
  flush();
  return out;
}

// ---------- вход ----------
let loginTimer = null;
async function showLogin() {
  app.classList.add("hidden"); $("#login").classList.remove("hidden");
  if (showLogin.on) return;
  showLogin.on = true;
  const btn = $("#tgLogin");
  const start = async () => {
    try {
      const d = await api("/api/auth/start", { method: "POST" });
      btn.href = d.url; btn.dataset.token = d.token; $("#loginErr").classList.add("hidden");
    } catch (e) { $("#loginErr").textContent = e.message; $("#loginErr").classList.remove("hidden"); }
  };
  await start();
  btn.onclick = () => $("#loginHint").classList.remove("hidden");
  loginTimer = setInterval(async () => {
    if (!btn.dataset.token) return start();
    try {
      const d = await api("/api/auth/poll?token=" + encodeURIComponent(btn.dataset.token));
      if (d.ok) { clearInterval(loginTimer); location.reload(); }
      else if (d.expired) { btn.dataset.token = ""; start(); }
    } catch {}
  }, 2000);
}

// ---------- профиль ----------
async function loadMe() {
  const d = await api("/api/me");
  S.me = d.user; S.plans = d.plans; S.models = d.models; S.freeTokens = d.free_tokens;
  $("#meName").textContent = S.me.name;
  $("#avatar").textContent = (S.me.name || "?").trim()[0]?.toUpperCase() || "?";
  $("#mePlan").textContent = S.me.plan_name + (S.me.plan_until ? " · до " + new Date(S.me.plan_until).toLocaleDateString("ru") : "");
  $("#adminItem").classList.toggle("hidden", !S.me.admin);
  updateQuota(S.me.tokens_left);
  const sel = $("#model");
  if (!sel.options.length) {
    sel.innerHTML = S.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    let saved = null; try { saved = localStorage.getItem("model"); } catch {}
    sel.value = S.models.includes(saved) ? saved : d.default_model;
    sel.classList.toggle("hidden", S.models.length < 2);
  }
  const h = new Date().getHours();
  const part = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  $("#greet").textContent = `${part}, ${S.me.name.split(" ")[0]}`;
  return d;
}
function updateQuota(tokens) {
  S.me.tokens_left = tokens;
  $("#quotaText").textContent = tokens > 0 ? `Осталось ≈ ${fmtTokens(tokens)} токенов` : "Лимит исчерпан";
  $("#upgradeBtn").textContent = S.me.plan === "free" ? "Улучшить" : "Продлить";
}

// ---------- чаты ----------
async function loadChats() {
  S.chats = await api("/api/chats");
  renderChats();
}
function renderChats() {
  $("#chatList").innerHTML = S.chats.length ? S.chats.map((c) =>
    `<a class="chat-item${c.id === S.chatId ? " active" : ""}" href="#${c.id}" data-id="${c.id}"><span>${esc(c.title)}</span>` +
    `<button class="del" data-del="${c.id}" title="Удалить">✕</button></a>`).join("")
    : `<div class="muted small" style="padding:6px 12px">Пока нет чатов</div>`;
}
function setTitle(t) { $("#chatTitle").textContent = t || ""; document.title = t ? `${t} — ${document.querySelector("h1").textContent}` : document.querySelector("h1").textContent; }
function newChat() {
  if (S.busy) stop();
  S.chatId = null; thread.innerHTML = ""; app.classList.add("empty"); setTitle("");
  if (location.hash) history.replaceState(null, "", location.pathname);
  renderChats(); closeSide(); input.focus();
}
async function openChat(id) {
  if (S.busy) stop();
  try {
    const d = await api("/api/chats/" + id);
    S.chatId = d.id; thread.innerHTML = ""; app.classList.remove("empty"); setTitle(d.title);
    for (const m of d.messages) m.role === "user" ? addUser(m.content, m.files) : addBot(m.content);
    renderChats(); closeSide();
    requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  } catch (e) { toast(e.message); newChat(); }
}

// ---------- сообщения ----------
function filesHtml(files) {
  return files.length ? `<div class="files">${files.map((f) => `<div class="chip">📄 <b>${esc(f.name)}</b><span class="muted">${fmtSize(f.size ?? f.content.length)}</span></div>`).join("")}</div>` : "";
}
function addUser(text, files = []) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = filesHtml(files) + (text ? `<div class="bubble">${esc(text)}</div>` : "");
  thread.appendChild(el); return el;
}
function addBot(text = "") {
  const el = document.createElement("div");
  el.className = "msg bot";
  el.innerHTML = `<div class="mark"></div><div class="body"><details class="think hidden"><summary>Размышления</summary><div></div></details>` +
    `<div class="md"></div><div class="actions"><button data-act="copy-msg">Копировать</button></div></div>`;
  el._text = text;
  el.querySelector(".md").innerHTML = md(text);
  thread.appendChild(el); return el;
}
function addNotice(html, cls = "") {
  const el = document.createElement("div");
  el.className = "notice " + cls; el.innerHTML = html;
  thread.appendChild(el); scrollDown(true); return el;
}
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
function scrollDown(force) { if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight; }

function setBusy(b) {
  S.busy = b;
  sendBtn.classList.toggle("stop", b);
  sendBtn.setAttribute("aria-label", b ? "Остановить" : "Отправить");
  updateSendState();
}
function updateSendState() {
  const loading = S.files.some((f) => f.loading);
  sendBtn.disabled = !S.busy && (loading || (!input.value.trim() && !S.files.length));
}
function stop() { if (S.ctrl) S.ctrl.abort(); }

async function sendMessage() {
  if (S.busy) return stop();
  const text = input.value.trim();
  const files = S.files.filter((f) => !f.loading).map((f) => ({ name: f.name, content: f.content }));
  if (!text && !files.length) return;
  if (S.me.tokens_left <= 0) return limitNotice();
  input.value = ""; autosize(); S.files = []; renderAttachments();
  app.classList.remove("empty");
  addUser(text, files);
  const bot = addBot(""); const mdEl = bot.querySelector(".md"); const think = bot.querySelector(".think");
  mdEl.classList.add("cursor"); scrollDown(true);
  setBusy(true);
  S.ctrl = new AbortController();
  let answer = "", thinking = "", raf = 0;
  const paint = () => { raf = 0; mdEl.innerHTML = md(answer); bot._text = answer; scrollDown(); };
  try {
    const r = await fetch("/api/chat", {
      method: "POST", signal: S.ctrl.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: S.chatId, content: text, files, model: $("#model").value }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) return showLogin();
      if (r.status === 402) { bot.remove(); updateQuota(0); return limitNotice(); }
      throw new Error(d.message || d.error || "Ошибка " + r.status);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        let ev; try { ev = JSON.parse(p.slice(6)); } catch { continue; }
        if (ev.t === "chat") {
          if (S.chatId !== ev.id) {
            S.chatId = ev.id; history.replaceState(null, "", "#" + ev.id); setTitle(ev.title);
            if (!S.chats.find((c) => c.id === ev.id)) S.chats.unshift({ id: ev.id, title: ev.title, updated: Date.now() });
            renderChats();
          }
        } else if (ev.t === "delta") { answer += ev.d; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.t === "think") { thinking += ev.d; think.classList.remove("hidden"); think.querySelector("div").textContent = thinking; }
        else if (ev.t === "error") addNotice(`<div>⚠ ${esc(ev.message)}</div>`, "error");
        else if (ev.t === "done") updateQuota(ev.tokens_left);
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") addNotice(`<div>⚠ ${esc(e.message)}</div>`, "error");
  } finally {
    if (raf) cancelAnimationFrame(raf);
    paint(); mdEl.classList.remove("cursor");
    if (!answer) bot.remove();
    setBusy(false); S.ctrl = null;
    const c = S.chats.find((x) => x.id === S.chatId);
    if (c) { S.chats = [c, ...S.chats.filter((x) => x !== c)]; renderChats(); }
    if (S.me.tokens_left <= 0) limitNotice();
  }
}
function limitNotice() {
  if (thread.querySelector(".notice.limit")) return;
  app.classList.remove("empty");
  addNotice(`<div><b>Лимит исчерпан.</b><br><span class="muted">Оформите подписку, чтобы продолжить общение.</span></div>` +
    `<button class="btn primary" data-act="plans">Выбрать тариф</button>`, "limit");
}

// ---------- вложения ----------
function renderAttachments() {
  $("#attachments").innerHTML = S.files.map((f, i) =>
    `<div class="chip${f.loading ? " loading" : ""}">📄 <b>${esc(f.name)}</b><span class="muted">${f.loading ? "…" : fmtSize(f.content.length)}</span>` +
    `<button type="button" class="x" data-rm="${i}">✕</button></div>`).join("");
  updateSendState();
}
const looksBinary = (s) => s.slice(0, 8000).includes("\u0000");
async function addFiles(list) {
  for (const file of list) {
    if (/\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
      const slot = { name: file.name, content: "", loading: true }; S.files.push(slot); renderAttachments();
      try {
        if (file.size > 30e6) throw new Error("Архив больше 30 МБ");
        const r = await fetch("/api/extract", { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Не удалось распаковать");
        S.files.splice(S.files.indexOf(slot), 1);
        if (!d.files.length) toast("В архиве нет текстовых файлов");
        const bundle = d.files.map((f) => `===== ${f.name} =====\n${f.content}`).join("\n\n");
        if (d.files.length) S.files.push({ name: `${file.name} (${d.files.length} файлов)`, content: bundle });
        if (d.skipped) toast(`Пропущено файлов: ${d.skipped} (бинарные, большие или служебные)`);
      } catch (e) { S.files.splice(S.files.indexOf(slot), 1); toast(e.message); }
      renderAttachments(); continue;
    }
    if (file.size > 2e6) { toast(`${file.name}: файл больше 2 МБ`); continue; }
    const text = await file.text().catch(() => "");
    if (!text || looksBinary(text)) { toast(`${file.name}: поддерживаются только текстовые файлы и ZIP`); continue; }
    S.files.push({ name: file.name, content: text });
    renderAttachments();
  }
}

// ---------- тарифы ----------
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
function showPlans() {
  const cur = S.me.plan;
  const free = `<div class="plan${cur === "free" ? " current" : ""}"><h4>Free</h4><div class="price">$0</div>` +
    `<ul><li>≈ ${fmtTokens(S.freeTokens)} токенов на пробу</li><li>Все возможности чата</li></ul>` +
    `<button class="btn" disabled>${cur === "free" ? "Текущий" : "Базовый"}</button></div>`;
  const cards = S.plans.map((p) => `<div class="plan${cur === p.id ? " current" : ""}"><h4>${esc(p.name)}</h4>` +
    `<div class="price">$${p.price}<small> / 30 дней</small></div>` +
    `<ul><li>≈ ${fmtTokens(p.tokens)} токенов</li>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
    `<button class="btn primary" data-buy="${esc(p.id)}">${cur === p.id ? "Продлить" : "Оплатить криптой"}</button></div>`).join("");
  openModal(`<h3>Тарифы</h3><p class="muted small">Оплата через @CryptoBot: USDT, TON, BTC и другие. Продление добавляет 30 дней и токены к текущим.</p>` +
    `<div class="plans">${free}${cards}</div><p class="muted small" id="payStatus"></p>`);
}
async function buy(planId, btn) {
  const w = window.open("", "_blank");
  btn.disabled = true; btn.textContent = "Создаю счёт…";
  try {
    const d = await api("/api/pay", { method: "POST", body: JSON.stringify({ plan: planId }) });
    if (w) w.location.href = d.url; else location.href = d.url;
    btn.textContent = "Ожидаю оплату…";
    const st = $("#payStatus"); if (st) st.innerHTML = `Счёт открыт в CryptoBot. Не открылся? <a href="${esc(d.url)}" target="_blank" rel="noopener">Открыть счёт</a>. После оплаты тариф включится сам в течение ~15 секунд.`;
    const before = S.me.plan_until || 0, beforePlan = S.me.plan;
    clearInterval(S.pollPay);
    let n = 0;
    S.pollPay = setInterval(async () => {
      if (++n > 360) return clearInterval(S.pollPay);
      try {
        const m = await api("/api/me");
        if (m.user.plan !== beforePlan || (m.user.plan_until || 0) > before) {
          clearInterval(S.pollPay); await loadMe(); closeModal();
          thread.querySelector(".notice.limit")?.remove();
          toast(`🎉 Тариф ${m.user.plan_name} активирован!`, 4000);
        }
      } catch {}
    }, 5000);
  } catch (e) { if (w) w.close(); btn.disabled = false; btn.textContent = "Оплатить криптой"; toast(e.message); }
}

// ---------- админка ----------
async function showAdmin() {
  openModal(`<h3>Админка</h3><p class="muted">Загрузка…</p>`);
  try {
    const d = await api("/api/admin/stats");
    const money = (v) => "$" + Number(v || 0).toFixed(2);
    openModal(`<h3>Админка</h3><p class="muted small">Наценка x${d.markup}. Себестоимость — то, что списано с вашего API-ключа.</p>
      <div class="stats">
        <div class="stat"><span class="muted small">Пользователей</span><b>${d.users}</b></div>
        <div class="stat"><span class="muted small">Платящих</span><b>${d.paying || 0}</b></div>
        <div class="stat"><span class="muted small">Выручка за 30 дн.</span><b>${money(d.month_revenue)}</b></div>
        <div class="stat"><span class="muted small">Выручка всего</span><b>${money(d.revenue)}</b></div>
        <div class="stat"><span class="muted small">Себестоимость</span><b>${money(d.spent)}</b></div>
        <div class="stat"><span class="muted small">Прибыль</span><b>${money(d.profit)}</b></div>
      </div>
      <h4 style="margin:18px 0 4px">Выдать тариф</h4>
      <div class="row"><input id="gUser" placeholder="@username или Telegram ID"><select id="gPlan">${S.plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      <button class="btn primary" id="gBtn">Выдать на 30 дней</button></div>
      <h4 style="margin:18px 0 8px">Последние пользователи</h4>
      <div class="table-wrap"><table class="table"><tr><th>Имя</th><th>Telegram</th><th>Тариф</th><th>Осталось</th><th>Оплатил</th><th>Себест.</th></tr>
      ${d.users_list.map((u) => `<tr><td>${esc(u.name)}</td><td>${u.username ? "@" + esc(u.username) : esc(u.tg_id)}</td><td>${esc(u.plan)}${u.plan !== "free" ? " до " + new Date(u.plan_until).toLocaleDateString("ru") : ""}</td><td>${fmtTokens(u.tokens_left)}</td><td>${money(u.paid_total)}</td><td>${money(u.spent)}</td></tr>`).join("")}
      </table></div>`);
    $("#gBtn").onclick = async () => {
      try { const r = await api("/api/admin/grant", { method: "POST", body: JSON.stringify({ user: $("#gUser").value, plan: $("#gPlan").value }) }); toast(r.message); showAdmin(); loadMe(); }
      catch (e) { toast(e.message); }
    };
  } catch (e) { openModal(`<h3>Админка</h3><p class="err">${esc(e.message)}</p>`); }
}

// ---------- интерфейс ----------
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; updateSendState(); }
function openSide() { app.classList.add("side-open"); }
function closeSide() { app.classList.remove("side-open"); }
const isMobile = () => matchMedia("(max-width: 820px)").matches || matchMedia("(pointer: coarse)").matches;

input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isMobile()) { e.preventDefault(); sendMessage(); }
});
input.addEventListener("paste", (e) => {
  const t = e.clipboardData?.getData("text") || "";
  if (t.length > 4000) { e.preventDefault(); S.files.push({ name: "Вставленный текст.txt", content: t }); renderAttachments(); toast("Длинный текст добавлен как файл"); }
});
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
$("#attachBtn").onclick = () => $("#file").click();
$("#file").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
$("#attachments").onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) { S.files.splice(+b.dataset.rm, 1); renderAttachments(); } };
$("#model").onchange = (e) => { try { localStorage.setItem("model", e.target.value); } catch {} };
$("#newChat").onclick = newChat; $("#newChatTop").onclick = newChat;
$("#openSide").onclick = openSide; $("#closeSide").onclick = closeSide; $("#scrim").onclick = closeSide;
$("#upgradeBtn").onclick = showPlans;
$("#meBtn").onclick = (e) => { e.stopPropagation(); $("#meMenu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest("#meMenu")) $("#meMenu").classList.add("hidden"); });
$("#modalX").onclick = closeModal;
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };

$("#chatList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("Удалить этот чат?")) return;
    await api("/api/chats/" + del.dataset.del, { method: "DELETE" }).catch((er) => toast(er.message));
    S.chats = S.chats.filter((c) => c.id !== del.dataset.del);
    if (S.chatId === del.dataset.del) newChat(); else renderChats();
    return;
  }
  const a = e.target.closest("[data-id]");
  if (a) { e.preventDefault(); history.replaceState(null, "", "#" + a.dataset.id); openChat(a.dataset.id); }
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act],[data-buy]");
  if (!b) return;
  if (b.dataset.buy) return buy(b.dataset.buy, b);
  const act = b.dataset.act;
  if (act === "copy-code") copyText(b.closest(".code").querySelector("code").textContent);
  else if (act === "dl-code") {
    const lang = (b.dataset.lang || "").toLowerCase();
    const ext = EXT[lang] || (lang && lang.length <= 5 ? lang : "txt");
    download(ext === "Dockerfile" ? "Dockerfile" : "code." + ext, b.closest(".code").querySelector("code").textContent);
  } else if (act === "copy-msg") copyText(b.closest(".msg")._text || "");
  else if (act === "plans") { $("#meMenu").classList.add("hidden"); showPlans(); }
  else if (act === "admin") { $("#meMenu").classList.add("hidden"); showAdmin(); }
  else if (act === "logout") { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); location.reload(); }
});

// перетаскивание файлов
let dragN = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragN++; $("#drop").classList.remove("hidden"); } });
window.addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; $("#drop").classList.add("hidden"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); dragN = 0; $("#drop").classList.add("hidden"); if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });

window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== S.chatId) openChat(id); });

// ---------- старт ----------
(async function init() {
  try {
    await loadMe();
  } catch (e) {
    if (e.status === 401 || e.message === "Нужно войти") return showLogin();
    document.body.innerHTML = `<div class="login"><div class="login-card"><h1>Ошибка</h1><p class="muted">${esc(e.message)}</p></div></div>`;
    return;
  }
  $("#login").classList.add("hidden"); app.classList.remove("hidden"); app.classList.add("empty");
  await loadChats().catch(() => {});
  const id = location.hash.slice(1);
  if (id) openChat(id); else newChat();
  autosize();
})();
