import { config as appConfig } from "../src/config.js";
import { getEventSubStatus, subscribeIfNeeded } from "../src/twitch.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

const TELEGRAM_API = "https://api.telegram.org";

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	return (await res.json()) as unknown;
}

async function setTelegramWebhook() {
	const body: Record<string, unknown> = {
		url: `${appConfig.baseUrl}/api/telegram`,
	};
	if (appConfig.telegram.webhookSecret) {
		body.secret_token = appConfig.telegram.webhookSecret;
	}
	return fetchJson(
		`${TELEGRAM_API}/bot${appConfig.telegram.token}/setWebhook`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

export async function GET(): Promise<Response> {
	const status = {
		env: {
			telegramTokenSet: Boolean(appConfig.telegram.token),
			channelId: appConfig.telegram.channelId,
			baseUrl: appConfig.baseUrl,
			twitchClientIdSet: Boolean(appConfig.twitch.clientId),
			broadcasterUserId: appConfig.twitch.broadcasterUserId,
		},
		telegramWebhook: null as unknown,
		subscription: null as unknown,
	};

	try {
		status.telegramWebhook = await fetchJson(
			`${TELEGRAM_API}/bot${appConfig.telegram.token}/getWebhookInfo`,
		);
	} catch (err) {
		status.telegramWebhook = { error: String(err) };
	}

	try {
		const sub = await getEventSubStatus();
		status.subscription = sub
			? { id: sub.id, type: sub.type, status: sub.status }
			: null;
	} catch (err) {
		status.subscription = { error: String(err) };
	}

	return Response.json(status);
}

export async function POST(): Promise<Response> {
	const [webhookResult, subscriptionResult] = await Promise.all([
		setTelegramWebhook().catch((err) => ({ error: String(err) })),
		subscribeIfNeeded().catch((err) => ({ error: String(err) })),
	]);
	return Response.json({
		webhook: webhookResult,
		subscription: subscriptionResult,
	});
}
