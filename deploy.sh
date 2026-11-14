#!/usr/bin/env bash
# Розгортання YULA на Ubuntu з GitHub на окремому порту.
# Сайт працює як системна служба: не залежить від SSH-сесії, піднімається після перезавантаження
# і перезапускається сам, якщо впаде.
# Використання: bash deploy.sh https://github.com/ЛОГІН/РЕПО.git [ПОРТ]
set -euo pipefail
REPO="${1:?Вкажіть адресу репозиторію}"
PORT="${2:-}"
PORT_FILE=/etc/yula-port
SRC=/opt/yula-src

if [ "$(id -u)" -ne 0 ]; then echo "Запустіть від root: sudo -i, потім команду ще раз"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq nginx git curl python3 >/dev/null

# Порт: заданий, або збережений з минулого запуску, або перший вільний від 8347.
if [ -z "$PORT" ] && [ -f "$PORT_FILE" ]; then PORT=$(cat "$PORT_FILE"); fi
if [ -z "$PORT" ] && [ -f /etc/nginx/sites-available/yula ]; then PORT=$(awk '/listen/{gsub(";","",$2);print $2;exit}' /etc/nginx/sites-available/yula); fi
if [ -z "$PORT" ]; then
  PORT=8347
  while ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; do PORT=$((PORT+1)); done
fi
echo "$PORT" > "$PORT_FILE"

# Код сайту
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin && git -C "$SRC" reset -q --hard FETCH_HEAD
else rm -rf "$SRC"; git clone -q --depth 1 "$REPO" "$SRC"; fi
ROOT=$(dirname "$(find "$SRC" -path "$SRC/.git" -prune -o -name index.html -print | head -1)")
chmod -R o+rX "$SRC"

# Сервер кабінетів постачальників: база й фото лежать окремо від коду і не зникають при оновленні
API_PORT=8790
DATA=/var/lib/yula
mkdir -p "$DATA/media" /etc/yula
id -u yula >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin yula
chown -R yula:yula "$DATA"
if [ ! -s /etc/yula/admin.key ]; then head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > /etc/yula/admin.key; fi
chown root:yula /etc/yula/admin.key; chmod 640 /etc/yula/admin.key
API_CMD="/usr/bin/python3 $SRC/server/yula_api.py --db $DATA/yula.db --media $DATA/media --key /etc/yula/admin.key --port $API_PORT"

# Конфіг nginx тільки для нашого порту
cat > /etc/nginx/sites-available/yula <<NGINX
server {
  listen $PORT;
  server_name _;
  root $ROOT;
  index index.html;
  location ~ /\.git { deny all; }
  location ^~ /server/ { deny all; }
  client_max_body_size 6m;
  location /api/ {
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
  location /media/ {
    alias $DATA/media/;
    add_header X-Content-Type-Options nosniff;
    add_header Cache-Control "public, max-age=31536000, immutable";
    location ~* \.(php|html?|js|svg)\$ { deny all; }
  }
  location /fonts/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
  # Проксі для фідів постачальників: адмінка завантажує їх зі свого домену, без блокування CORS.
  # Дозволені тільки ці два джерела, тому це не відкритий проксі.
  location /feed-proxy/mydrop/ {
    proxy_pass https://backend.mydrop.com.ua/vendor/api/export/;
    proxy_set_header Host backend.mydrop.com.ua;
    proxy_ssl_server_name on;
    proxy_read_timeout 180s;
    add_header Cache-Control "no-store";
  }
  location /feed-proxy/prom/ {
    proxy_pass https://my.prom.ua/;
    proxy_set_header Host my.prom.ua;
    proxy_ssl_server_name on;
    proxy_read_timeout 180s;
    add_header Cache-Control "no-store";
  }
  location / { try_files \$uri \$uri/ =404; }
}
NGINX
ln -sf /etc/nginx/sites-available/yula /etc/nginx/sites-enabled/yula
# Стандартний сайт nginx на 80-му порту може конфліктувати з іншим веб-сервером — вимикаємо його
rm -f /etc/nginx/sites-enabled/default
nginx -t -q

if [ -d /run/systemd/system ]; then
  # Автоперезапуск, якщо nginx впаде
  mkdir -p /etc/systemd/system/nginx.service.d
  printf '[Service]\nRestart=always\nRestartSec=3\n' > /etc/systemd/system/nginx.service.d/yula-restart.conf
  cat > /etc/systemd/system/yula-api.service <<UNIT
[Unit]
Description=YULA supplier cabinets
After=network.target
[Service]
User=yula
Group=yula
ExecStart=$API_CMD
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable -q nginx yula-api
  systemctl restart yula-api
  systemctl restart nginx
else
  # Сервер без systemd (деякі VPS-контейнери): запускаємо nginx як демон і додаємо автозапуск
  pgrep -x nginx >/dev/null && nginx -s reload || nginx
  pkill -f "server/yula_api.py" 2>/dev/null || true
  nohup su -s /bin/sh yula -c "$API_CMD" >/var/log/yula-api.log 2>&1 &
  ( crontab -l 2>/dev/null | grep -v 'yula-nginx' ; echo "@reboot /usr/sbin/nginx # yula-nginx"; echo "@reboot su -s /bin/sh yula -c '$API_CMD' >/var/log/yula-api.log 2>&1 # yula-nginx"; echo "*/5 * * * * pgrep -x nginx >/dev/null || /usr/sbin/nginx # yula-nginx" ) | crontab -
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT"/tcp >/dev/null; fi

# Перевірка
sleep 1
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  IP=$(curl -s -4 --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')
  echo "Готово: http://$IP:$PORT  (адмінка: http://$IP:$PORT/admin.html)"
  echo "Сайт працює як служба і не вимкнеться після виходу з сервера."
  sleep 1
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    echo "Кабінети постачальників працюють. Ключ адміністратора: $(cat /etc/yula/admin.key)"
    echo "Його вводять один раз в адмінці, розділ «Постачальники». Нікому не пересилайте."
  else
    echo "Увага: сервер кабінетів не відповідає. Подивіться: journalctl -u yula-api -n 30"
  fi
else
  echo "nginx не відповідає на порту $PORT. Подивіться: journalctl -u nginx -n 30"; exit 1
fi
