# План: кросс-постинг в Discord и Twitter/X

## Текущая архитектура

Discord публикуется через два независимых вебхука:

- `DISCORD_STREAM_ONLINE_WEBHOOK_URL` — уведомления Twitch о начале стрима.
- `DISCORD_POSTS_WEBHOOK_URL` — сообщения и вложения из лички Telegram.

Триггеры:

- Сообщение из ЛС → `src/telegram.ts` → Telegram-канал и `posts`-вебхук.
- `stream.online` → `api/twitch.ts` → Telegram-канал и `stream`-вебхук.

Фотография из Telegram скачивается через Bot API и отправляется в Discord как
вложение. Для других типов файлов используется тот же механизм; если Discord не
принимает вложение, текстовая публикация и Telegram-пост не отменяются, а
администратор получает уведомление о пропуске вложения.

## Часть 1: Discord — вебхуки (реализовано)

### Setup (клики в Discord)

1. В канале уведомлений: Edit Channel → Integrations → Webhooks → New Webhook.
2. В отдельном канале постов повторить действие и создать второй вебхук.
3. Сохранить URL в `DISCORD_STREAM_ONLINE_WEBHOOK_URL` и
   `DISCORD_POSTS_WEBHOOK_URL`.

Переменные необязательные: если URL не задан, соответствующая публикация в
Discord пропускается, а Telegram продолжает работать.

### Реализация

- `src/discord.ts` отправляет JSON или `multipart/form-data`.
- Текст длиннее 2000 символов разбивается на несколько сообщений.
- Упоминания пользователей и ролей отключаются через `allowed_mentions`.
- Ошибка Discord не ломает публикацию в Telegram; при сбое отправляется
  уведомление администраторам.
- Для `stream.online` случайное изображение выбирается один раз и одни и те же
  байты отправляются в оба канала.

### Секреты

URL вебхуков являются секретами и не должны попадать в логи, ответы API или
репозиторий.

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
DISCORD_STREAM_ONLINE_WEBHOOK_URL=
DISCORD_POSTS_WEBHOOK_URL=
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

## Порядок реализации (когда решится с оплатой)

1. Добавить `DISCORD_STREAM_ONLINE_WEBHOOK_URL` и `DISCORD_POSTS_WEBHOOK_URL` в
   `.env`, `.env.example`, `src/config.ts`
2. Создать `src/discord.ts` (`postToDiscord` и загрузку Telegram-вложений)
3. Встроить вызовы для ручных постов и `stream.online`
4. Создать `src/x.ts` (`postTweet` + `isTooLong` + `XPostTooLongError`)
5. Обновить ответ автора: вместо «Опубликовано» — статус по каждой платформе
6. Установить: `pnpm add twitter-api-v2`
7. Добавить ключи X в Developer Console

## Время

- Discord: ~30 минут (клики в Discord + код)
- Twitter: ~1.5 часа + одобрение dev-аккаунта (может занять дни) + оплата
  кредитов
