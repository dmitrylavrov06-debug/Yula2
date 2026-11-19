# ИИ-чат с подпиской

Свой ИИ-чат для любого OpenAI-совместимого API:

- вход через Telegram;
- тарифы с оплатой криптовалютой через @CryptoBot (Crypto Pay);
- наценка на токены (по умолчанию x10): каждый оплаченный $1 даёт пользователю токенов на $0.10 вашей себестоимости;
- загрузка файлов и ZIP-архивов с проектами;
- markdown, блоки кода с кнопками «Копировать» и «Скачать», история чатов;
- админка: выручка, себестоимость, прибыль, ручная выдача тарифа.

## Установка и обновление (Ubuntu 24.04)

```bash
curl -fsSL https://raw.githubusercontent.com/dmitrylavrov06-debug/Yula2/ai-chat/ai-chat/install.sh -o install.sh && sudo bash install.sh
```

Что понадобится:
1. **API ключ** вашего провайдера.
2. **Токен бота** — создайте бота у @BotFather (`/newbot`).
3. **Токен Crypto Pay** — @CryptoBot → Crypto Pay → Create App.
4. **Ваш Telegram ID** — узнайте у @userinfobot (даёт доступ к админке).
5. **Себестоимость** — сколько ваш провайдер берёт за 1M входящих и исходящих токенов.

## Настройка

- Тарифы: `/opt/my-ai/data/plans.json` (id, название, цена в $, список преимуществ).
- Остальное: `/opt/my-ai/.env`. После правок: `sudo systemctl restart my-ai`.
- Логи: `journalctl -u my-ai -f`.
