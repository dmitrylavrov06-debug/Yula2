# My AI — свой ИИ-чат

Сайт-чат для любого OpenAI-совместимого API. Ключ хранится только на сервере.

## Быстрая установка (Ubuntu 24.04)

```bash
curl -fsSL https://raw.githubusercontent.com/dmitrylavrov06-debug/Yula2/ai-chat/ai-chat/install.sh -o install.sh && sudo bash install.sh
```

Скрипт спросит ключ, имя ИИ, пароль на вход и (по желанию) домен для HTTPS.

- Логи: `journalctl -u my-ai -f`
- Настройки: `sudo nano /opt/my-ai/.env` → `sudo systemctl restart my-ai`

Также можно развернуть `worker.js` на Cloudflare Workers (секрет `API_KEY`).
