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
}> {
	const [configModule, botModule, twitch, share] = await Promise.all([
		import("../src/config.js"),
		import("../src/telegram.js"),
		import("../src/twitch.js"),
		import("../src/share.js"),
	]);
	return {
		appConfig: configModule.getConfig(),
		bot: botModule.getBot(),
		twitch,
		share,
	};
}

export async function POST(request: Request): Promise<Response> {
	let appConfig: AppConfig;
	let bot: Telegraf;
	let twitch: Awaited<ReturnType<typeof load>>["twitch"];
	let share: Awaited<ReturnType<typeof load>>["share"];
	try {
		({ appConfig, bot, twitch, share } = await load());
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
		try {
			const sent = await share.postToChannel(bot.telegram, text);
			console.log("stream.online posted, message_id:", sent.message_id);
			await notify(
				`✅ Пост в канал отправлен (message_id ${sent.message_id})\n«${stream?.title ?? "—"}» / ${stream?.gameName ?? "—"}`,
			);
		} catch (err) {
			console.error("channel post failed:", err);
			await notify(
				`❌ Пост о стриме не опубликован.\n\n${describeTelegramFailure(err, `канал ${appConfig.telegram.channelId}`)}`,
			);
		}
	} catch (err) {
		console.error("stream data fetch failed:", err);
		await notify(
			`❌ Не удалось получить данные стрима «${channel}» из Twitch API.\n\n${describeError(err)}`,
		);
	}

	return new Response(null, { status: 204 });
}
