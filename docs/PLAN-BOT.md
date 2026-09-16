# Poster Bot — план

Отдельный документ рядом с `PLAN.md`: связан с ним только общей темой «постинг в
канал Telegram». Технологии не пересекаются: там Rust + десктоп, здесь
TypeScript + Vercel serverless.

## Назначение

Telegram-бот с **двумя функциями**:

1. Когда владелец (по `user_id`) присылает боту сообщение, бот добавляет две
   inline-кнопки (ссылки на Twitch и GitHub) и постит это сообщение в канал.
2. Когда начинается стрим на Twitch, бот постит в тот же канал уведомление
   (заголовок, игра из Helix) с теми же двумя кнопками.

Всё конфигурируемо через `config.ts` + `.env`. Без длительных соединений —
только webhook, работает на serverless Vercel.

## Вердикт исследования: возможно ✅

| Вопрос                     | Ответ                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegraf на Vercel         | Да. `bot.webhookCallback(path)` возвращает обычный handler — штатно экспортируется как Vercel-функция.                                                                                       |
| Оповещения о стриме        | Да. Twitch EventSub `stream.online` — webhook (POST).                                                                                                                                        |
| Long polling / сокеты      | Не нужны ни для Telegram, ни для Twitch.                                                                                                                                                     |
| Нужен ли user-токен Twitch | **Нет.** У события `stream.online` статус «No authorization required» — хватает app-токена (client_id + client_secret). Значит **не нужен** refresh-flow, KV-хранилище и постоянные серверы. |

## Стек и библиотеки

| Библиотека      | Зачем                                                  | Версия                |
| --------------- | ------------------------------------------------------ | --------------------- |
| `telegraf`      | Telegram Bot API                                       | ^4.16.3               |
| `@twurple/auth` | `AppTokenAuthProvider` (app-токен)                     | ^8.2.0                |
| `@twurple/api`  | `ApiClient`: создание подписки EventSub, данные стрима | ^8.2.0                |
| `typescript`    | типы                                                   | ^5                    |
| `dotenv`        | локальный прогон (`vercel dev`)                        | ^16 (dev)             |
| `@vercel/node`  | типы Vercel-хендлеров                                  | только для разработки |

**Не нужны:** `express`, `@twurple/eventsub-http`, `@twurple/eventsub-ws`,
никакие KV/Redis.

## Почему не `@twurple/eventsub-http` (важно)

`EventSubHttpListener` поднимает постоянный HTTP-сервер и держит подписки в
памяти. На Vercel функция живёт ≤1 запроса и умирает — listener нежизнеспособен.

Решение: принимаем EventSub **руками** (~40 строк). Алгоритм 1-в-1 из кода
twurple (`packages/eventsub-http/src/EventSubHttpBase.ts`, метод `_verifyData`):

1. Заголовок `Twitch-Eventsub-Message-Type` = `webhook_callback_verification` →
   отвечаем `200` с телом = `challenge` (text/plain).
2. Иначе: подпись `Twitch-Eventsub-Message-Signature` = `sha256=<hex>`.
   Вычислить `HMAC-SHA256(secret, messageId + timestamp + rawBody)` и сравнить
   через `crypto.timingSafeEqual`.
3. Если `notification` и `subscription.type === 'stream.online'` → обработать.

`rawBody` — строка **до** JSON.parse; сигнатура считается по сырому телу.

## Архитектура на Vercel

Один проект Vercel, функции:

| Файл              | Роут                  | Назначение                                                                |
| ----------------- | --------------------- | ------------------------------------------------------------------------- |
| `api/telegram.ts` | `POST /api/telegram`  | webhook Telegram                                                          |
| `api/twitch.ts`   | `POST /api/twitch`    | callback EventSub (challenge + события)                                   |
| `api/setup.ts`    | `GET/POST /api/setup` | идемпотентный сетап: `setWebhook` + подписка (создастся, только если нет) |

Telegram `setWebhook` указывает на `https://<project>.vercel.app/api/telegram`.
То же значение `PUBLIC_BASE_URL` используется как `callback` при создании
EventSub-подписки.

Всё POST, каждый хендлер завершается <1 сек. Холодные старты не проблема.

## Часть 1 — Telegram (telegraf)

Поток:

1. Сообщение от админа (проверка `ctx.from.id` ∈ `config.allowedUserIds`).
2. `sendMessage(config.telegram.channelId, text, { reply_markup })`, где
   `reply_markup` — `Markup.inlineKeyboard([...кнопки])`.
3. Опции: ответить автору «опубликовано» (`replyToAuthor`), не постить служебные
   команды (`/start`, `/help`).

Пример скелета:

```ts
bot.on(message("text"), async (ctx) => {
  if (!config.telegram.allowedUserIds.includes(ctx.from.id)) return;
  await ctx.telegram.sendMessage(config.telegram.channelId, ctx.message.text, {
    reply_markup: Markup.inlineKeyboard(
      config.buttons.map((b) => Markup.button.url(b.label, b.url)),
    ),
  });
});

export default bot.webhookCallback("/api/telegram");
```

## Часть 2 — Twitch (twurple, ручной webhook)

### Создание подписки (идемпотентно)

Повторный запуск не должен плодить дубли: у Twitch лимит **3 одинаковых**
подписок (`type` + `condition`), а лишний дубль = дубли уведомлений. Поэтому
перед созданием — проверяем существующие.

```ts
const provider = new AppTokenAuthProvider(clientId, clientSecret);
const apiClient = new ApiClient({ authProvider: provider });

// 1. Ищем уже существующую подписку stream.online на наш канал
const subs = await apiClient.eventSub.getSubscriptions({
  type: "stream.online",
});
const mine = subs.data.filter(
  (s) => s.condition.broadcasterUserId === broadcasterUserId,
);

// 2. Уже enabled — ничего не делаем (разовый запуск стал идемпотентным)
if (mine.some((s) => s.status === "enabled")) return;

// 3. Есть «битая» — удаляем и пересоздаём
const broken = mine.find((s) =>
  [
    "notification_failures_exceeded",
    "webhook_callback_verification_failed",
  ].includes(s.status),
);
if (broken) await apiClient.eventSub.deleteSubscription(broken.id);

// 4. Создаём
await apiClient.eventSub.createSubscription({
  type: "stream.online",
  version: "1",
  condition: { broadcasterUserId }, // числовой ID канала
  transport: {
    method: "webhook",
    callback: `${BASE_URL}/api/twitch`,
    secret: EVENTSUB_SECRET, // 10–100 символов
  },
});
```

`getSubscriptions` / `deleteSubscription` / `createSubscription` подтверждены в
`@twurple/api` 8.x (`HelixEventSubApi`). Сразу после создания статус —
`webhook_callback_verification_pending`, после успешного challenge — `enabled`.

### Проверка: активна ли подписка

Тот же вызов `getSubscriptions({ type: "stream.online" })` и фильтр по каналу.
Срок жизни подписки **не ограничен** — по доке Twitch (2026) «subscriptions do
not expire»; отзываются только явно или по статусам ниже.

| Статус                                  | Что значит                                                    |
| --------------------------------------- | ------------------------------------------------------------- |
| `enabled`                               | активна                                                       |
| `webhook_callback_verification_pending` | создана, ждёт challenge от Twitch                             |
| `webhook_callback_verification_failed`  | callback не ответил на challenge                              |
| `notification_failures_exceeded`        | Твич отозвал: callback не отвечал слишком долго → пересоздать |
| `user_removed`                          | канал удалён из Twitch                                        |
| `version_removed`                       | версия типа события больше не поддерживается                  |

### Отключение подписки

Твич сам подписку «по желанию» не выключает — только отзывает при проблемах
доставки (`notification_failures_exceeded`). Поэтому отключаем явно:

```ts
const subs = await apiClient.eventSub.getSubscriptions({
  type: "stream.online",
});
for (const s of subs.data) {
  if (s.condition.broadcasterUserId === broadcasterUserId) {
    await apiClient.eventSub.deleteSubscription(s.id);
  }
}
```

Важно: при удалении приложения в dev.twitch.tv — сначала удалить подписку, иначе
Твич продолжит слать события на старый callback.

### Обработка события

1. Проверить подпись (см. выше).
2. `subscription.type === 'stream.online'`.
3. Получить данные стрима: `apiClient.streams.getStreamByUserId(broadcasterId)`
   — оттуда `title`, `gameName`, `startedAt`, `thumbnailUrl`.
4. Сформировать текст по шаблону `templateStreamOnline` и отправить канал с
   кнопками — та же общая функция, что в части 1.

### Bacon: данные для шаблона

| Поле                                             | Откуда                    |
| ------------------------------------------------ | ------------------------- |
| `title`, `gameName`, `startedAt`, `thumbnailUrl` | Helix `getStreamByUserId` |
| `channel` (login/display)                        | из payload события        |

## Часть 3 — управление подпиской из бота

### Кнопки не мешают постингу

Нажатие inline-кнопки приходит как `callback_query`, а в «пост в канал» попадают
только `message` с текстом — это разные типы апдейтов. Конфликта нет. Правило
одно: всё, что не свободный текст владельца, отсекаем до отправки.

```ts
bot.on(message("text"), async (ctx) => {
  if (!config.telegram.allowedUserIds.includes(ctx.from.id)) return;
  if (ctx.message.text.startsWith("/")) return; // команды в канал не идут

  await ctx.telegram.sendMessage(config.telegram.channelId, ctx.message.text, {
    reply_markup: Markup.inlineKeyboard(
      config.buttons.map((b) => Markup.button.url(b.label, b.url)),
    ),
  });
});

bot.command("menu", async (ctx) => {
  await ctx.reply("Бот постинга — управление Twitch:", {
    reply_markup: Markup.inlineKeyboard([
      Markup.button.callback("Статус подписки", "twitch_status"),
      Markup.button.callback("Включить", "twitch_on"),
      Markup.button.callback("Выключить", "twitch_off"),
    ]),
  });
});

bot.action("twitch_status", async (ctx) => {
  const active = await findSubscription(); // getSubscriptions + фильтр по каналу
  await ctx.answerCbQuery();
  await ctx.reply(active ? `Подписка активна (${active.id})` : "Подписки нет");
});

bot.action("twitch_on", async (ctx) => {
  await subscribeIfNeeded(); // идемпотентный create из части 2
  await ctx.answerCbQuery("Готово");
});

bot.action("twitch_off", async (ctx) => {
  await deleteSubscriptions(); // отключение из части 2
  await ctx.answerCbQuery("Готово");
});
```

Альтернатива без кнопок — команды напрямую (`bot.command("twitch_status", ...)`
и т.д.): работает так же, но команды — это текстовые сообщения, поэтому их
обязательно фильтровать в обработчике постинга (guard `startsWith("/")` выше это
уже делает).

### Скрипты (альтернатива: вообще без изменений в боте)

| Скрипт                   | Что делает                                     |
| ------------------------ | ---------------------------------------------- |
| `scripts/subscribe.ts`   | выполнить пункты 1–4 создания (идемпотентно)   |
| `scripts/status.ts`      | показать статус подписки                       |
| `scripts/unsubscribe.ts` | удалить подписку                               |
| `api/setup.ts`           | то же, что `subscribe.ts`, но через HTTP (GET) |

## Конфигурация

### `.env` (secrets, не в git)

| Переменная             | Зачем                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`   | токен бота от BotFather                                         |
| `TWITCH_CLIENT_ID`     | приложение в dev.twitch.tv                                      |
| `TWITCH_CLIENT_SECRET` | секрет приложения                                               |
| `EVENTSUB_SECRET`      | секрет подписки EventSub (10–100 символов, **не менять потом**) |
| `PUBLIC_BASE_URL`      | `https://<project>.vercel.app`                                  |

### `config.ts` (все значения по умолчанию)

```ts
config = {
  telegram: {
    channelId: "@my_channel", // или числовой chat_id
    allowedUserIds: [123456789], // кто может постить
    replyToAuthor: true,
  },
  twitch: {
    broadcasterLogin: "mylogin", // → резолвится в broadcasterUserId
  },
  buttons: [
    { label: "Twitch", url: "https://twitch.tv/mylogin" },
    { label: "GitHub", url: "https://github.com/me" },
  ],
  templates: {
    message: "{text}", // сообщение из бота (1:1 как было)
    streamOnline: "🎬 {channel} запустился!\n\n{title}\nИгра: {gameName}",
  },
};
```

Плейсхолдеры в `streamOnline`: `{channel}`, `{title}`, `{gameName}`,
`{startedAt}`.

## Структура проекта

```txt
poster-bot/
├── api/
│   ├── telegram.ts       # webhook Telegram
│   ├── twitch.ts         # EventSub callback (challenge + events)
│   └── setup.ts          # разовый сетап (setWebhook + подписка)
├── src/
│   ├── config.ts         # вся конфигурация
│   ├── telegram.ts       # создание bot, обработчики
│   ├── twitch.ts         # twurple клиент, verify, subscribe
│   └── share.ts          # «собрать кнопки + отправить в канал» (общая часть)
├── scripts/
│   ├── subscribe.ts      # идемпотентный create (локально + dotenv)
│   ├── status.ts         # показать статус подписки
│   └── unsubscribe.ts    # удалить подписку
├── .env.example
├── package.json
└── tsconfig.json
```

## Порядок реализации (оценки)

1. Scaffold: Vercel-проект, TS, `config.ts`, `.env.example` — **~30 мин**
2. Telegram-часть: `api/telegram.ts` + `setWebhook` — **~1 ч**
3. Twitch: app-токен + `createSubscription` + `api/setup.ts` — **~1–1.5 ч**
4. Twitch-приём: `api/twitch.ts`, HMAC, обработка `stream.online` — **~1 ч**
5. Шаблоны, кнопки, полировка, документ setup в README — **~1 ч**

Итого ~ **полдня**. Тестирование: `vercel dev` локально, затем
`vercel deploy --prod` и проверка через Twitch CLI:
`twitch event trigger streamup -F <url>/api/twitch -s <secret>` (или реальный
запуск стрима).

## Риски и ограничения

1. **`EVENTSUB_SECRET` неизменяем**: после создания подписки менять нельзя — все
   события начнут падать на проверке подписи. Сменил → удали и пересоздай
   подписку.
2. **Редкие дубли** `stream.online` — Твич может прислать повтор. Для личного
   канала это ок; при желании — дедуп по `started_at` через Vercel KV
   (опционально).
3. **HTTPS и скорость ответа**: Vercel из коробки https; на challenge отвечаем
   мгновенно (<5 сек лимит Твича).
4. **Без авторизации в самом боте**: защита только по `allowedUserIds`, бот
   приватный.
5. **Дубли при повторном сетапе**: раньше повторный запуск создавал лишние
   подписки (Твич допускает до 3 одинаковых). Это закрыто идемпотентной
   проверкой в части 2.
