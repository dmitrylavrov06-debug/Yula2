#!/usr/bin/env python3
"""YULA supplier cabinets.

A small server for suppliers who have no CRM: they keep their products,
drop prices, sizes, stock and photos in a web cabinet, and the YULA admin
imports them as an ordinary Prom YML feed.

Standard library only (Python 3.8+). Runs behind nginx on 127.0.0.1.

  python3 yula_api.py --db /var/lib/yula/yula.db --media /var/lib/yula/media \
                      --key /etc/yula/admin.key --port 8790 [--static DIR]

Access:
  owner     X-Admin-Key header (the key lives in the --key file)
  supplier  X-Sup-Token header (the token is in the invite link)
  feed      /api/feed/<feed_key>.xml, read-only, no other access
"""
import argparse, hmac, json, os, re, secrets, sqlite3, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from xml.sax.saxutils import escape

CATS = ["Худі та зіпки", "Світшоти", "Светри й кофти", "Лонгсліви", "Футболки", "Поло", "Сорочки", "Майки", "Топи",
        "Костюми", "Комплекти", "Штани", "Джинси", "Легінси", "Шорти", "Сукні", "Спідниці", "Куртки", "Пальта", "Жилети",
        "Комбінезони", "Термобілизна", "Дім і сон", "Білизна", "Купальники", "Шкарпетки", "Кросівки й кеди", "Черевики",
        "Тапочки й сандалі", "Сумки", "Рюкзаки", "Шапки й аксесуари", "Інше"]
AUD = {"women": "Жіноче", "men": "Чоловіче", "uni": "Унісекс", "kids": "Дитяче"}
MAX_JSON = 256 * 1024
MAX_PHOTO = 4 * 1024 * 1024
MAX_PRODUCTS = 3000
MAX_PHOTOS = 8
IMG = {b"\xff\xd8\xff": "jpg", b"\x89PNG\r\n\x1a\n": "png"}

A = None          # parsed arguments
ADMIN_KEY = ""
DB_LOCK = threading.Lock()
FAILS = {}        # ip -> [count, window start]


def db():
    con = sqlite3.connect(A.db, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(A.db)), exist_ok=True)
    os.makedirs(A.media, exist_ok=True)
    with db() as con:
        con.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS suppliers(
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, feed_key TEXT UNIQUE NOT NULL,
          phone TEXT DEFAULT '', tg TEXT DEFAULT '', ship_note TEXT DEFAULT '', ret_note TEXT DEFAULT '',
          active INTEGER DEFAULT 1, created INTEGER, updated INTEGER, seen INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS products(
          id INTEGER PRIMARY KEY, sup_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
          title TEXT NOT NULL, color TEXT DEFAULT '', cat TEXT DEFAULT 'Інше', aud TEXT DEFAULT 'uni',
          price INTEGER NOT NULL, sizes TEXT NOT NULL, material TEXT DEFAULT '', descr TEXT DEFAULT '',
          code TEXT DEFAULT '', photos TEXT DEFAULT '[]', created INTEGER, updated INTEGER);
        CREATE INDEX IF NOT EXISTS p_sup ON products(sup_id);
        """)


def load_key():
    global ADMIN_KEY
    if os.path.exists(A.key):
        ADMIN_KEY = open(A.key).read().strip()
    if not ADMIN_KEY:
        os.makedirs(os.path.dirname(os.path.abspath(A.key)), exist_ok=True)
        ADMIN_KEY = secrets.token_urlsafe(24)
        fd = os.open(A.key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, ADMIN_KEY.encode())
        os.close(fd)


# ---------- validation ----------
class Bad(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def txt(v, n, field, required=False):
    v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f<>]", "", str(v or "")).strip()
    if required and not v:
        raise Bad(f"Заповніть поле «{field}»")
    return v[:n]


def clean_product(d):
    title = txt(d.get("title"), 120, "Назва", True)
    color = txt(d.get("color"), 60, "Колір")
    cat = d.get("cat") if d.get("cat") in CATS else "Інше"
    aud = d.get("aud") if d.get("aud") in AUD else "uni"
    try:
        price = int(round(float(d.get("price"))))
    except (TypeError, ValueError):
        raise Bad("Вкажіть ціну дропу числом")
    if not 10 <= price <= 100000:
        raise Bad("Ціна дропу має бути від 10 до 100 000 ₴")
    sizes = d.get("sizes")
    if not isinstance(sizes, dict) or not sizes:
        raise Bad("Додайте хоча б один розмір")
    out = {}
    for k, v in list(sizes.items())[:40]:
        k = txt(k, 20, "Розмір")
        if not k:
            continue
        try:
            q = max(0, min(100000, int(v)))
        except (TypeError, ValueError):
            q = 0
        out[k] = q
    if not out:
        raise Bad("Додайте хоча б один розмір")
    photos = [p for p in (d.get("photos") or []) if isinstance(p, str) and re.fullmatch(r"[a-f0-9]{32}\.(jpg|png)", p)][:MAX_PHOTOS]
    return dict(title=title, color=color, cat=cat, aud=aud, price=price, sizes=json.dumps(out, ensure_ascii=False),
                material=txt(d.get("material"), 120, "Матеріал"), descr=txt(d.get("descr"), 2000, "Опис"),
                code=txt(d.get("code"), 40, "Артикул"), photos=json.dumps(photos))


def prod_out(r):
    d = dict(r)
    d["sizes"] = json.loads(d["sizes"])
    d["photos"] = json.loads(d["photos"])
    d.pop("sup_id", None)
    return d


def sup_out(r, full=False):
    d = {k: r[k] for k in ("id", "name", "phone", "tg", "ship_note", "ret_note", "updated")}
    if full:
        d.update(token=r["token"], feed_key=r["feed_key"], active=bool(r["active"]), created=r["created"], seen=r["seen"])
    return d


# ---------- feed ----------
def feed_xml(sup, rows, base):
    cats, cat_ids, nxt = [], {}, 100
    for i, (k, v) in enumerate(AUD.items(), 1):
        cats.append(f'<category id="{i}">{escape(v)}</category>')
    offers = []
    for r in rows:
        aud_id = list(AUD).index(r["aud"]) + 1 if r["aud"] in AUD else 3
        key = (aud_id, r["cat"])
        if key not in cat_ids:
            cat_ids[key] = nxt
            cats.append(f'<category id="{nxt}" parentId="{aud_id}">{escape(AUD[list(AUD)[aud_id - 1]] + " / " + r["cat"])}</category>')
            nxt += 1
        sizes = json.loads(r["sizes"])
        photos = json.loads(r["photos"])
        name = r["title"] + (", " + r["color"] if r["color"] else "")
        pics = "".join(f"<picture>{escape(base + '/media/' + p)}</picture>" for p in photos)
        desc = escape(" ".join(x for x in (r["descr"], ("Матеріал: " + r["material"]) if r["material"] else "") if x))
        for j, (sz, q) in enumerate(sizes.items()):
            offers.append(
                f'<offer id="{r["id"]}-{j}" group_id="{r["id"]}" available="{"true" if q > 0 else "false"}">'
                f'<name>{escape(name)}</name><price>{r["price"]}</price><currencyId>UAH</currencyId>'
                f'<categoryId>{cat_ids[key]}</categoryId>{pics}<vendorCode>{escape(r["code"] or "Y" + str(r["id"]))}</vendorCode>'
                f'<quantity_in_stock>{q}</quantity_in_stock><description>{desc}</description>'
                f'<param name="Размер">{escape(sz)}</param>'
                + (f'<param name="Материал">{escape(r["material"])}</param>' if r["material"] else "")
                + "</offer>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="%s"><shop><name>%s</name><currencies><currency id="UAH" rate="1"/></currencies><categories>%s</categories><offers>%s</offers></shop></yml_catalog>'
            % (time.strftime("%Y-%m-%d %H:%M"), escape(sup["name"]), "".join(cats), "".join(offers)))


# ---------- http ----------
class H(BaseHTTPRequestHandler):
    server_version = "YULA"
    sys_version = ""

    def log_message(self, fmt, *a):
        if A.verbose:
            super().log_message(fmt, *a)

    # responses
    def send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def err(self, code, msg):
        self.send(code, {"error": msg})

    def body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise Bad("Завеликий запит", 413)
        return self.rfile.read(n) if n else b""

    def json_body(self):
        try:
            d = json.loads(self.body(MAX_JSON) or b"{}")
        except ValueError:
            raise Bad("Некоректні дані")
        if not isinstance(d, dict):
            raise Bad("Некоректні дані")
        return d

    def ip(self):
        return (self.headers.get("X-Real-IP") or self.client_address[0])[:64]

    def throttle(self):
        w = FAILS.get(self.ip())
        if w and time.time() - w[1] < 600 and w[0] >= 20:
            raise Bad("Забагато спроб. Спробуйте за 10 хвилин", 429)

    def failed(self):
        ip, now = self.ip(), time.time()
        w = FAILS.get(ip)
        FAILS[ip] = [1, now] if not w or now - w[1] >= 600 else [w[0] + 1, w[1]]
        if len(FAILS) > 5000:
            FAILS.clear()

    def admin(self):
        self.throttle()
        k = self.headers.get("X-Admin-Key") or ""
        if not (k and hmac.compare_digest(k, ADMIN_KEY)):
            self.failed()
            raise Bad("Невірний ключ адміністратора", 401)

    def supplier(self, con):
        self.throttle()
        t = self.headers.get("X-Sup-Token") or ""
        r = con.execute("SELECT * FROM suppliers WHERE token=?", (t,)).fetchone() if len(t) >= 20 else None
        if not r:
            self.failed()
            raise Bad("Посилання недійсне. Попросіть у YULA нове", 401)
        if not r["active"]:
            raise Bad("Кабінет вимкнено. Зв’яжіться з YULA", 403)
        return r

    def base_url(self):
        host = re.sub(r"[^A-Za-z0-9.:\-\[\]]", "", self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "localhost")
        proto = "https" if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https" else "http"
        return f"{proto}://{host}"

    # routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, m):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                return self.api(m, path)
            if A.static and m in ("GET", "HEAD"):
                return self.static(path)
            self.err(404, "Не знайдено")
        except Bad as e:
            self.err(e.code, str(e))
        except Exception as e:  # never leak internals
            if A.verbose:
                import traceback; traceback.print_exc()
            self.err(500, "Помилка сервера. Спробуйте ще раз")

    def static(self, path):
        if path.startswith("/media/"):
            root, rel = A.media, path[7:]
        else:
            root, rel = A.static, path.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(os.path.realpath(root) + os.sep) or not os.path.isfile(full):
            return self.err(404, "Не знайдено")
        ext = full.rsplit(".", 1)[-1].lower()
        ct = {"html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css", "woff2": "font/woff2",
              "jpg": "image/jpeg", "png": "image/png", "xml": "application/xml", "txt": "text/plain; charset=utf-8"}.get(ext, "application/octet-stream")
        self.send(200, open(full, "rb").read(), ct)

    def api(self, m, path):
        p = path.rstrip("/").split("/")[2:]   # after /api/
        if p == ["health"]:
            return self.send(200, {"ok": True})

        # ---- feed for the admin import
        if m in ("GET", "HEAD") and len(p) == 2 and p[0] == "feed":
            key = p[1][:-4] if p[1].endswith(".xml") else p[1]
            with db() as con:
                s = con.execute("SELECT * FROM suppliers WHERE feed_key=? AND active=1", (key,)).fetchone() if len(key) >= 20 else None
                if not s:
                    return self.err(404, "Фід не знайдено")
                rows = con.execute("SELECT * FROM products WHERE sup_id=? ORDER BY id", (s["id"],)).fetchall()
            return self.send(200, feed_xml(s, rows, self.base_url()), "application/xml; charset=utf-8")

        # ---- owner
        if p and p[0] == "admin":
            self.admin()
            with DB_LOCK, db() as con:
                if p == ["admin", "check"]:
                    return self.send(200, {"ok": True})
                if p == ["admin", "suppliers"] and m == "GET":
                    out = []
                    for r in con.execute("SELECT * FROM suppliers ORDER BY id DESC"):
                        c = con.execute("SELECT COUNT(*) n, MAX(updated) u FROM products WHERE sup_id=?", (r["id"],)).fetchone()
                        d = sup_out(r, True); d.update(products=c["n"], last_product=c["u"] or 0); out.append(d)
                    return self.send(200, out)
                if p == ["admin", "suppliers"] and m == "POST":
                    d = self.json_body(); now = int(time.time())
                    name = txt(d.get("name"), 80, "Назва", True)
                    cur = con.execute("INSERT INTO suppliers(name,token,feed_key,phone,tg,created,updated) VALUES(?,?,?,?,?,?,?)",
                                      (name, secrets.token_urlsafe(24), secrets.token_urlsafe(24), txt(d.get("phone"), 30, "Телефон"),
                                       txt(d.get("tg"), 60, "Telegram"), now, now))
                    r = con.execute("SELECT * FROM suppliers WHERE id=?", (cur.lastrowid,)).fetchone()
                    return self.send(201, sup_out(r, True))
                if len(p) == 4 and p[1] == "suppliers" and p[2].isdigit() and m == "POST":
                    sid = int(p[2])
                    if not con.execute("SELECT 1 FROM suppliers WHERE id=?", (sid,)).fetchone():
                        return self.err(404, "Постачальника не знайдено")
                    if p[3] == "reset":
                        con.execute("UPDATE suppliers SET token=? WHERE id=?", (secrets.token_urlsafe(24), sid))
                    elif p[3] == "active":
                        con.execute("UPDATE suppliers SET active=? WHERE id=?", (1 if self.json_body().get("active") else 0, sid))
                    else:
                        return self.err(404, "Не знайдено")
                    return self.send(200, sup_out(con.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone(), True))
            return self.err(404, "Не знайдено")

        # ---- supplier
        if p and p[0] == "sup":
            with DB_LOCK, db() as con:
                s = self.supplier(con); sid = s["id"]; now = int(time.time())
                con.execute("UPDATE suppliers SET seen=? WHERE id=?", (now, sid))
                if p == ["sup", "me"] and m == "GET":
                    return self.send(200, sup_out(s))
                if p == ["sup", "me"] and m == "PUT":
                    d = self.json_body()
                    con.execute("UPDATE suppliers SET phone=?,tg=?,ship_note=?,ret_note=?,updated=? WHERE id=?",
                                (txt(d.get("phone"), 30, "Телефон"), txt(d.get("tg"), 60, "Telegram"),
                                 txt(d.get("ship_note"), 300, "Відправка"), txt(d.get("ret_note"), 300, "Повернення"), now, sid))
                    return self.send(200, sup_out(con.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone()))
                if p == ["sup", "products"] and m == "GET":
                    rows = con.execute("SELECT * FROM products WHERE sup_id=? ORDER BY updated DESC, id DESC", (sid,)).fetchall()
                    return self.send(200, [prod_out(r) for r in rows])
                if p == ["sup", "products"] and m == "POST":
                    if con.execute("SELECT COUNT(*) FROM products WHERE sup_id=?", (sid,)).fetchone()[0] >= MAX_PRODUCTS:
                        raise Bad("Досягнуто ліміту товарів")
                    v = clean_product(self.json_body())
                    cur = con.execute("INSERT INTO products(sup_id,%s,created,updated) VALUES(?,%s,?,?)" % (",".join(v), ",".join("?" * len(v))),
                                      (sid, *v.values(), now, now))
                    con.execute("UPDATE suppliers SET updated=? WHERE id=?", (now, sid))
                    return self.send(201, prod_out(con.execute("SELECT * FROM products WHERE id=?", (cur.lastrowid,)).fetchone()))
                if len(p) >= 3 and p[1] == "products" and p[2].isdigit():
                    pid = int(p[2])
                    r = con.execute("SELECT * FROM products WHERE id=? AND sup_id=?", (pid, sid)).fetchone()
                    if not r:
                        return self.err(404, "Товар не знайдено")
                    if len(p) == 3 and m == "PUT":
                        v = clean_product(self.json_body())
                        con.execute("UPDATE products SET %s,updated=? WHERE id=?" % ",".join(k + "=?" for k in v), (*v.values(), now, pid))
                    elif len(p) == 4 and p[3] == "stock" and m == "PATCH":
                        d = self.json_body(); old = json.loads(r["sizes"]); sz = d.get("sizes")
                        if not isinstance(sz, dict):
                            raise Bad("Некоректні залишки")
                        for k, q in sz.items():
                            if k in old:
                                try:
                                    old[k] = max(0, min(100000, int(q)))
                                except (TypeError, ValueError):
                                    pass
                        con.execute("UPDATE products SET sizes=?,updated=? WHERE id=?", (json.dumps(old, ensure_ascii=False), now, pid))
                    elif len(p) == 3 and m == "DELETE":
                        con.execute("DELETE FROM products WHERE id=?", (pid,))
                        con.execute("UPDATE suppliers SET updated=? WHERE id=?", (now, sid))
                        return self.send(200, {"ok": True})
                    else:
                        return self.err(404, "Не знайдено")
                    con.execute("UPDATE suppliers SET updated=? WHERE id=?", (now, sid))
                    return self.send(200, prod_out(con.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()))
                if p == ["sup", "photos"] and m == "POST":
                    data = self.body(MAX_PHOTO)
                    ext = next((e for sig, e in IMG.items() if data.startswith(sig)), None)
                    if not ext:
                        raise Bad("Фото має бути JPG або PNG")
                    name = secrets.token_hex(16) + "." + ext
                    with open(os.path.join(A.media, name), "wb") as f:
                        f.write(data)
                    return self.send(201, {"file": name, "url": "/media/" + name})
            return self.err(404, "Не знайдено")

        return self.err(404, "Не знайдено")


def main():
    global A
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/var/lib/yula/yula.db")
    ap.add_argument("--media", default="/var/lib/yula/media")
    ap.add_argument("--key", default="/etc/yula/admin.key")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--static", default="", help="serve site files too (local testing only)")
    ap.add_argument("--print-key", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    A = ap.parse_args()
    init_db(); load_key()
    if A.print_key:
        print(ADMIN_KEY); return
    srv = ThreadingHTTPServer((A.host, A.port), H)
    srv.daemon_threads = True
    print(f"YULA API on {A.host}:{A.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
