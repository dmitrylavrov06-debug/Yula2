#!/usr/bin/env bash
# Установка / обновление ИИ-чата с подпиской на Ubuntu 24.04
# Запуск:  curl -fsSL https://raw.githubusercontent.com/dmitrylavrov06-debug/Yula2/ai-chat/ai-chat/install.sh -o install.sh && sudo bash install.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo: sudo bash install.sh"; exit 1; }

APP_DIR=/opt/my-ai
APP_USER=myai
REPO_TGZ="https://codeload.github.com/dmitrylavrov06-debug/Yula2/tar.gz/refs/heads/ai-chat"

# --- прочитать текущие настройки (при обновлении) ---
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    local k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    if [[ "$v" == \'*\' ]]; then v=${v:1:${#v}-2}
    elif [[ "$v" == \"*\" ]]; then v=${v:1:${#v}-2}; v=${v//\\\"/\"}; v=${v//\\\\/\\}; fi
    printf -v "$k" '%s' "$v"
  done < "$1"
}
ask() { # ask VAR "Вопрос" [secret]
  local var=$1 prompt=$2 secret=${3:-} cur="${!1:-}" hint="" val=""
  if [ -n "$cur" ]; then if [ -n "$secret" ]; then hint=" [Enter — оставить текущий]"; else hint=" [$cur]"; fi; fi
  if [ -n "$secret" ]; then read -rsp "$prompt$hint: " val </dev/tty; echo; else read -rp "$prompt$hint: " val </dev/tty; fi
  if [ -n "$val" ]; then printf -v "$var" '%s' "$val"; fi
  return 0
}
q() { local v=${1//\'/’}; printf "'%s'" "$v"; }

load_env "$APP_DIR/.env"
: "${BASE_URL:=https://darkseek-console.duckdns.org/v1}"
: "${BOT_NAME:=Мой ИИ}"
: "${MARKUP:=10}"
: "${PRICE_IN_PER_1M:=0.5}"
: "${PRICE_OUT_PER_1M:=1.5}"
: "${FREE_BUDGET_USD:=0.01}"

echo "=== Установка ИИ-чата ==="
echo "Подсказки: токен бота — у @BotFather; токен оплаты — @CryptoBot → Crypto Pay → Create App;"
echo "ваш Telegram ID — у @userinfobot."
echo
ask API_KEY "API ключ" secret
ask BASE_URL "Base URL API"
ask BOT_TOKEN "Токен Telegram-бота для входа" secret
ask CRYPTOPAY_TOKEN "Токен Crypto Pay (Enter — без оплаты)" secret
ask ADMIN_TG_IDS "Ваш Telegram ID (админ)"
ask BOT_NAME "Название сайта/ИИ"
ask PRICE_IN_PER_1M "Ваша цена за 1M входящих токенов, \$"
ask PRICE_OUT_PER_1M "Ваша цена за 1M исходящих токенов, \$"
ask MARKUP "Наценка (во сколько раз)"
ask DOMAIN "Домен для HTTPS, например ai.example.com (Enter — без домена)"
[ -n "${API_KEY:-}" ] || { echo "API ключ обязателен"; exit 1; }
[ -n "${BOT_TOKEN:-}" ] || { echo "Токен бота обязателен — без него не будет входа"; exit 1; }

echo "--> Проверяю Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".").map(Number).reduce((a,b,i)=>i<2?a*1000+b:a)')" -lt 22005 ]; then
  echo "    Ставлю Node.js 22"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    $(node -v)"

echo "--> Скачиваю код"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$REPO_TGZ" | tar -xz -C "$TMP"
SRC=$(echo "$TMP"/*/ai-chat)
[ -f "$SRC/server.js" ] || { echo "Не удалось скачать код"; exit 1; }

systemctl stop my-ai 2>/dev/null || true
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
cp -r "$SRC"/. "$APP_DIR"/
[ -f "$APP_DIR/data/plans.json" ] || cp "$APP_DIR/plans.json" "$APP_DIR/data/plans.json"

# --- порт ---
port_busy() { ss -ltn "( sport = :$1 )" | grep -q ":$1 "; }
APP_PORT=${PORT:-3001}
while port_busy "$APP_PORT"; do APP_PORT=$((APP_PORT+1)); done
if [ -n "${DOMAIN:-}" ]; then LISTEN_HOST=127.0.0.1; PUBLIC_URL="https://$DOMAIN"
else LISTEN_HOST=0.0.0.0; PUBLIC_URL="http://$(hostname -I | awk '{print $1}'):$APP_PORT"; fi

{
  for k in API_KEY BASE_URL BOT_TOKEN CRYPTOPAY_TOKEN ADMIN_TG_IDS BOT_NAME SYSTEM_PROMPT MODEL MODELS \
           PRICE_IN_PER_1M PRICE_OUT_PER_1M MARKUP FREE_BUDGET_USD DOMAIN CRYPTOPAY_TESTNET CONTEXT_CHARS; do
    [ -n "${!k:-}" ] && echo "$k=$(q "${!k}")"
  done
  echo "PUBLIC_URL=$(q "$PUBLIC_URL")"
  echo "DATA_DIR=$APP_DIR/data"
  echo "PORT=$APP_PORT"
  echo "HOST=$LISTEN_HOST"
} > "$APP_DIR/.env"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "--> Настраиваю автозапуск"
cat > /etc/systemd/system/my-ai.service <<__SVC__
[Unit]
Description=My AI chat
After=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
__SVC__
systemctl daemon-reload
systemctl enable my-ai >/dev/null 2>&1
systemctl restart my-ai

if [ -n "${DOMAIN:-}" ]; then
  if ! command -v nginx >/dev/null; then apt-get install -y -qq nginx >/dev/null; fi
  echo "--> Подключаю домен $DOMAIN через nginx"
  cat > /etc/nginx/sites-available/my-ai <<__NGX__
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 40m;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }
}
__NGX__
  ln -sf /etc/nginx/sites-available/my-ai /etc/nginx/sites-enabled/my-ai
  nginx -t && systemctl reload nginx
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null || true
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || echo "⚠ HTTPS не выдан — проверьте, что домен указывает на этот сервер, и запустите установку ещё раз"
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80,443/tcp >/dev/null; fi
else
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$APP_PORT"/tcp >/dev/null; fi
fi

OK=0
for i in $(seq 1 15); do
  sleep 1
  if systemctl is-active --quiet my-ai && port_busy "$APP_PORT"; then OK=1; break; fi
done
echo
if [ "$OK" = 1 ]; then
  echo "✅ Готово! Сайт: $PUBLIC_URL"
  echo "   Тарифы:     sudo nano $APP_DIR/data/plans.json"
  echo "   Настройки:  sudo nano $APP_DIR/.env   (после правок: sudo systemctl restart my-ai)"
  echo "   Логи:       journalctl -u my-ai -f"
  echo "   Обновление: запустите эту же команду установки ещё раз"
else
  echo "❌ Сервис не запустился. Последние строки лога:"
  journalctl -u my-ai -n 30 --no-pager
  exit 1
fi
