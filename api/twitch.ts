import type { Telegraf } from "telegraf";
import type { AppConfig } from "../src/config.js";
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

	const rawBody = await request.text();
	const messageType = request.headers.get("twitch-eventsub-message-type") ?? "";

	// 1. Подтверждение владения колбэком: вернуть challenge как есть.
	if (messageType === "webhook_callback_verification") {
		const parsed = JSON.parse(rawBody) as { challenge?: string };
		if (typeof parsed.challenge !== "string") {
			return new Response("bad request", { status: 400 });
		}
		return new Response(parsed.challenge, {
			status: 200,
			headers: {
				"Content-Type": "text/plain",
				"Content-Length": String(Buffer.byteLength(parsed.challenge)),
			},
		});
	}

	// 2. Проверка, что сообщение действительно от Twitch.
	const messageId = request.headers.get("twitch-eventsub-message-id") ?? "";
	const timestamp =
		request.headers.get("twitch-eventsub-message-timestamp") ?? "";
	const signature =
		request.headers.get("twitch-eventsub-message-signature") ?? "";
	if (!twitch.verifyEventSubSignature(messageId, timestamp, signature, rawBody)) {
		return new Response("bad signature", { status: 403 });
	}

	// 3. Твич сам отозвал подписку — логируем причину.
	if (messageType === "revocation") {
		console.warn("EventSub revocation:", rawBody);
		return new Response(null, { status: 204 });
	}

	if (messageType !== "notification") {
		return new Response(null, { status: 204 });
	}

	// 4. Обработка события запуска стрима.
	const notification = JSON.parse(rawBody) as Notification;
	if (notification.subscription?.type !== "stream.online") {
		return new Response(null, { status: 204 });
	}

	try {
		const event = notification.event ?? {};
		const stream = await twitch.getApiClient().streams.getStreamByUserId(
			event.broadcaster_user_id ?? "",
		);
		const text = share.renderTemplate(appConfig.templates.streamOnline, {
			channel:
				event.broadcaster_user_name ?? event.broadcaster_user_login ?? "стример",
			title: stream?.title ?? "—",
			gameName: stream?.gameName ?? "—",
			startedAt: stream?.startDate?.toISOString() ?? "—",
		});
		await share.postToChannel(bot.telegram, text);
	} catch (err) {
		console.error("stream.online handling failed:", err);
	}

	return new Response(null, { status: 204 });
}