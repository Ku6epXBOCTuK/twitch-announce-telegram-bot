import type { Telegraf } from "telegraf";
import type { AppConfig } from "../src/config.js";
import { describeError, describeTelegramFailure } from "../src/errors.js";
import { jsonError } from "../src/http.js";

export const config = { runtime: "nodejs", maxDuration: 10 };

type Notification = {
	subscription?: { type?: string; status?: string };
	event?: {
		broadcaster_user_id?: string;
		broadcaster_user_name?: string;
		broadcaster_user_login?: string;
	};
};

async function load(): Promise<{
	appConfig: AppConfig;
	bot: Telegraf;
	twitch: typeof import("../src/twitch.js");
	share: typeof import("../src/share.js");
	assets: typeof import("../src/assets.js");
	discord: typeof import("../src/discord.js");
}> {
	const [configModule, botModule, twitch, share, assets, discord] =
		await Promise.all([
			import("../src/config.js"),
			import("../src/telegram.js"),
			import("../src/twitch.js"),
			import("../src/share.js"),
			import("../src/assets.js"),
			import("../src/discord.js"),
		]);
	return {
		appConfig: configModule.getConfig(),
		bot: botModule.getBot(),
		twitch,
		share,
		assets,
		discord,
	};
}

export async function POST(request: Request): Promise<Response> {
	let appConfig: AppConfig;
	let bot: Telegraf;
	let twitch: Awaited<ReturnType<typeof load>>["twitch"];
	let share: Awaited<ReturnType<typeof load>>["share"];
	let assets: Awaited<ReturnType<typeof load>>["assets"];
	let discord: Awaited<ReturnType<typeof load>>["discord"];
	try {
		({ appConfig, bot, twitch, share, assets, discord } = await load());
	} catch (err) {
		return jsonError(err);
	}

	const notify = (text: string) => share.notifyAdmins(bot.telegram, text);

	const rawBody = await request.text();
	const messageType = request.headers.get("twitch-eventsub-message-type") ?? "";
	const messageId = request.headers.get("twitch-eventsub-message-id") ?? "";

	// 1. Подтверждение владения колбэком: вернуть challenge как есть.
	if (messageType === "webhook_callback_verification") {
		const parsed = JSON.parse(rawBody) as { challenge?: string };
		if (typeof parsed.challenge !== "string") {
			return new Response("bad request", { status: 400 });
		}
		console.log("EventSub challenge ok:", messageId);
		await notify(`✅ Twitch подтвердил подписку (challenge ${messageId})`);
		return new Response(parsed.challenge, {
			status: 200,
			headers: {
				"Content-Type": "text/plain",
				"Content-Length": String(Buffer.byteLength(parsed.challenge)),
			},
		});
	}

	// 2. Проверка, что сообщение действительно от Twitch.
	const timestamp =
		request.headers.get("twitch-eventsub-message-timestamp") ?? "";
	const signature =
		request.headers.get("twitch-eventsub-message-signature") ?? "";
	if (
		!twitch.verifyEventSubSignature(messageId, timestamp, signature, rawBody)
	) {
		console.warn("EventSub bad signature:", messageId);
		await notify(
			`⚠️ EventSub: подпись не сошлась (id ${messageId}). Проверь EVENTSUB_SECRET на Vercel.`,
		);
		return new Response("bad signature", { status: 403 });
	}

	// 3. Твич сам отозвал подписку — сообщаем и логируем причину.
	if (messageType === "revocation") {
		console.warn("EventSub revocation:", rawBody);
		await notify(`🚫 Twitch отозвал подписку:\n${rawBody.slice(0, 1200)}`);
		return new Response(null, { status: 204 });
	}

	if (messageType !== "notification") {
		return new Response(null, { status: 204 });
	}

	// 4. Обработка события запуска стрима.
	const notification = JSON.parse(rawBody) as Notification;
	if (notification.subscription?.type !== "stream.online") {
		console.log(
			"EventSub notification skipped:",
			notification.subscription?.type,
		);
		return new Response(null, { status: 204 });
	}

	const retry = request.headers.get("twitch-eventsub-message-retry") ?? "0";
	const event = notification.event ?? {};
	const channel =
		event.broadcaster_user_name ?? event.broadcaster_user_login ?? "стример";
	await notify(
		`🟣 stream.online от ${channel} (id ${event.broadcaster_user_id ?? "?"}), message ${messageId}, retry ${retry}`,
	);

	// Событие уже принято и подпись проверена, поэтому Twitch нужно подтвердить
	// в любом случае. Если ответить не-2xx, Twitch повторит доставку того же
	// message-id (вплоть до отзыва подписки со статусом
	// notification_failures_exceeded) — это лишние запросы и дубли постов.
	// Сбои обрабатываем отдельно и только уведомляем админов: у сбора данных о
	// стриме и у публикации в Telegram разные причины и разные подсказки.
	try {
		const stream = await twitch
			.getApiClient()
			.streams.getStreamByUserId(event.broadcaster_user_id ?? "");
		const text = share.renderTemplate(appConfig.templates.streamOnline, {
			channel,
			title: stream?.title ?? "—",
			gameName: stream?.gameName ?? "—",
			startedAt: stream?.startDate?.toISOString() ?? "—",
		});
		const image = await assets.randomStreamOnlineImage();
		const discordAttachments = image
			? [
					{
						data: image.data,
						filename: image.filename,
						contentType: image.contentType,
					},
				]
			: [];
		const [telegramResult, discordResult] = await Promise.allSettled([
			share.postToChannel(bot.telegram, text, {
				withImage: true,
				image,
			}),
			discord.postToDiscord("stream", text, discordAttachments),
		]);

		if (telegramResult.status === "fulfilled") {
			console.log(
				"stream.online posted to Telegram, message_id:",
				telegramResult.value.message_id,
			);
			await notify(
				`✅ Пост в канал отправлен (message_id ${telegramResult.value.message_id})\n«${stream?.title ?? "—"}» / ${stream?.gameName ?? "—"}`,
			);
		} else {
			console.error(
				"stream.online Telegram post failed:",
				telegramResult.reason,
			);
			await notify(
				`❌ Пост о стриме не опубликован в Telegram.\n\n${describeTelegramFailure(telegramResult.reason, `канал ${appConfig.telegram.channelId}`)}`,
			);
		}

		if (discord.discordWebhookConfigured("stream")) {
			if (discordResult.status === "fulfilled") {
				console.log("stream.online posted to Discord");
			} else {
				console.error(
					"stream.online Discord post failed:",
					discordResult.reason,
				);
				await notify(
					`❌ Пост о стриме не опубликован в Discord.\n\n${describeError(discordResult.reason)}`,
				);
			}
		}
	} catch (err) {
		console.error("stream data fetch failed:", err);
		await notify(
			`❌ Не удалось получить данные стрима «${channel}» из Twitch API.\n\n${describeError(err)}`,
		);
	}

	return new Response(null, { status: 204 });
}
