# План: кросс-постинг в Discord и Twitter/X

## Текущая архитектура (точка интеграции)

Все посты идут через одну воронку: `postToChannel()` в `src/share.ts:20`.

- Триггер A: текст в ЛС бота → `src/telegram.ts:24-32` → `postToChannel()`
- Триггер B: Twitch stream.online → `api/twitch.ts` → `postToChannel()`

Если добавить Discord/Twitter в `postToChannel()` — оба триггера получат
кросс-постинг автоматически.

**Открытый вопрос (не решён):** Twitch-уведомления тоже идут в Discord/Twitter
или только ручные посты из ЛС?

1. Везде — код в `share.ts` (рекомендуется)
2. Только ручные посты — код в `telegram.ts:28`

## Часть 1: Discord — вебхук (бесплатно, ~30 минут)

### Решение

Вебхук: один HTTP POST, ноль депенденси, `fetch()` встроен в Node 20+.

### Setup (клики в Discord)

1. Правой кнопкой по каналу → Edit Channel → Integrations → Webhooks
2. New Webhook → скопировать URL
3. Добавить в env: `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`

### Код (новый файл `src/discord.ts`)

```ts
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;

export async function postToDiscord(content: string): Promise<void> {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(
      `Discord webhook failed (${res.status}): ${await res.text()}`,
    );
  }
}
```

### Лимиты

- 30 сообщений/мин на вебхук — с запасом хватает

### Секреты

- Одна env: `DISCORD_WEBHOOK_URL` (сам URL и есть токен)

## Часть 2: Twitter/X — блокировано оплатой

### Требования (актуально на 2026)

| Пункт              | Значение                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ |
| Библиотека         | `twitter-api-v2` (единственная живая, 0 deps)                                        |
| Credentials        | 4 ключа: `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`  |
| Период размышлений | App permissions → **Read & Write**                                                   |
| Цена               | **$0.015/пост, $0.20 если ссылка** — pay-per-use, купить кредиты в Developer Console |
| Лимит символов     | **280**; при превышении API отклонит (400), сам не обрезает                          |
| Rate limit         | 100/15 мин на юзера                                                                  |

⛔ **Блокер:** оплата. Без кредитов непонятно, заработает ли

### Варианты обхода оплаты (на подумать)

- **Nitter / альтернативные фронтенды** — нестабильно, часто умирают, не дают
  постинг
- **Вручную** — бот пишет «скопируй и вставь в X» — теряет смысл автоматизации
- **Возврат к вопросу позже** — пересмотреть, если появится бюджет или сменится
  ценовая модель

### Код (новый файл `src/x.ts`) — написан, но НЕ реализуем до решения по оплате

```ts
import { TwitterApi } from "twitter-api-v2";

const MAX_TWEET_LENGTH = 280;

export function isTooLong(text: string): boolean {
  return text.length > MAX_TWEET_LENGTH;
}

export async function postTweet(text: string): Promise<string> {
  if (isTooLong(text)) {
    throw new XPostTooLongError(text.length);
  }

  const client = new TwitterApi({
    appKey: requiredEnv("X_API_KEY"),
    appSecret: requiredEnv("X_API_KEY_SECRET"),
    accessToken: requiredEnv("X_ACCESS_TOKEN"),
    accessTokenSecret: requiredEnv("X_ACCESS_TOKEN_SECRET"),
  });

  const { data } = await client.v2.tweet(text);
  return data.id;
}

export class XPostTooLongError extends Error {
  readonly length: number;
  constructor(length: number) {
    super("post is too long, trim it manually");
    this.name = "XPostTooLongError";
    this.length = length;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}
```

### Логика «пост длинный» (требование от пользователя)

1. Проверить `text.length > 280` ДО вызова API (не жечь кредиты)
2. Если длинный → Twitter пропускается (пост всё равно уходит в Telegram и
   Discord)
3. Бот отвечает автору в ЛС:
   `"🚫 Пост длиннее 280 символов для Twitter. Обрежь вручную"`

### Новые env-переменные

```env
DISCORD_WEBHOOK_URL=
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

## Порядок реализации (когда решится с оплатой)

1. Добавить `DISCORD_WEBHOOK_URL` в `.env`, `.env.example`, `src/config.ts`
2. Создать `src/discord.ts` (`postToDiscord`)
3. Создать `src/x.ts` (`postTweet` + `isTooLong` + `XPostTooLongError`)
4. Внести вызовы в точку интеграции (зависит от ответа на вопрос выше)
5. Обновить ответ автора: вместо «Опубликовано» — статус по каждой платформе
6. Установить: `pnpm add twitter-api-v2`
7. Добавить ключи X в Developer Console

## Время

- Discord: ~30 минут (клики в Discord + код)
- Twitter: ~1.5 часа + одобрение dev-аккаунта (может занять дни) + оплата
  кредитов
