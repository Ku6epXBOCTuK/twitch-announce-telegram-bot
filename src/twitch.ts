import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiClient } from "@twurple/api";
import { AppTokenAuthProvider } from "@twurple/auth";
import { config } from "./config.js";

let client: ApiClient | null = null;

export function getApiClient(): ApiClient {
	if (!client) {
		const provider = new AppTokenAuthProvider(
			config.twitch.clientId,
			config.twitch.clientSecret,
		);
		client = new ApiClient({ authProvider: provider });
	}
	return client;
}

/** Проверка подписи EventSub: HMAC-SHA256(secret, messageId + timestamp + rawBody). */
export function verifyEventSubSignature(
	messageId: string,
	timestamp: string,
	signature: string,
	rawBody: string,
): boolean {
	const digest = createHmac("sha256", config.twitch.eventSubSecret)
		.update(messageId + timestamp + rawBody)
		.digest("hex");
	const expected = Buffer.from(`sha256=${digest}`);
	const received = Buffer.from(String(signature));
	if (expected.length !== received.length) return false;
	return timingSafeEqual(expected, received);
}

function broadcasterUserIdOf(sub: { condition: unknown }): string | undefined {
	return (sub.condition as { broadcaster_user_id?: string })
		.broadcaster_user_id;
}

async function getMine() {
	const subs =
		await getApiClient().eventSub.getSubscriptionsForType("stream.online");
	return subs.data.filter(
		(s) => broadcasterUserIdOf(s) === config.twitch.broadcasterUserId,
	);
}

/** Первая подписка stream.online на наш канал (любой статус) или null. */
export async function getEventSubStatus() {
	const mine = await getMine();
	return mine[0] ?? null;
}

/** Идемпотентное создание подписки: enabled — не трогаем, «битую» пересоздаём. */
export async function subscribeIfNeeded(): Promise<{
	changed: boolean;
	id?: string;
}> {
	const mine = await getMine();

	const active = mine.find((s) => s.status === "enabled");
	if (active) return { changed: false, id: active.id };

	const broken = mine.find((s) =>
		[
			"notification_failures_exceeded",
			"webhook_callback_verification_failed",
		].includes(s.status),
	);
	if (broken) await getApiClient().eventSub.deleteSubscription(broken.id);

	const created = await getApiClient().eventSub.createSubscription(
		"stream.online",
		"1",
		{ broadcaster_user_id: config.twitch.broadcasterUserId },
		{
			method: "webhook",
			callback: `${config.baseUrl}/api/twitch`,
			secret: config.twitch.eventSubSecret,
		},
		config.twitch.broadcasterUserId,
	);
	return { changed: true, id: created.id };
}

/** Удалить все подписки stream.online нашего канала. Возвращает сколько удалено. */
export async function deleteEventSub(): Promise<number> {
	const mine = await getMine();
	for (const s of mine) {
		await getApiClient().eventSub.deleteSubscription(s.id);
	}
	return mine.length;
}
