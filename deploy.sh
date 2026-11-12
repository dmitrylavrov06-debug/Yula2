#!/usr/bin/env bash
# Розгортання YULA на Ubuntu з GitHub на окремому порту.
# Використання: bash deploy.sh https://github.com/ЛОГІН/РЕПО.git [ПОРТ]
set -euo pipefail
REPO="${1:?Вкажіть адресу репозиторію}"
PORT="${2:-}"
apt-get update -qq && apt-get install -y -qq nginx git >/dev/null
# Унікальний порт: заданий або перший вільний, починаючи з 8347
if [ -z "$PORT" ]; then
  PORT=8347
  while ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; do PORT=$((PORT+1)); done
fi
SRC=/opt/yula-src
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q; else rm -rf "$SRC"; git clone -q "$REPO" "$SRC"; fi
ROOT=$(dirname "$(find "$SRC" -path "$SRC/.git" -prune -o -name index.html -print | head -1)")
cat > /etc/nginx/sites-available/yula <<NGINX
server {
  listen $PORT;
  server_name _;
  root $ROOT;
  index index.html;
  location ~ /\.git { deny all; }
  location / { try_files \$uri \$uri/ =404; }
}
NGINX
ln -sf /etc/nginx/sites-available/yula /etc/nginx/sites-enabled/yula
nginx -t -q && systemctl reload nginx
command -v ufw >/dev/null && ufw status | grep -q active && ufw allow "$PORT"/tcp >/dev/null || true
IP=$(curl -s -4 ifconfig.me || hostname -I | awk '{print $1}')
echo "Готово: http://$IP:$PORT  (кабінет продавця: http://$IP:$PORT/seller.html)"
