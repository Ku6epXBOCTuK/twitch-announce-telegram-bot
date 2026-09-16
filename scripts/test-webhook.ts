import { createHmac, randomUUID } from "node:crypto";
import { getConfig } from "../src/config.js";
import { getApiClient } from "../src/twitch.js";

async function main() {
	const config = getConfig();

	let login = "test";
	let name = "тест";
	try {
		const user = await getApiClient().users.getUserById(
			config.twitch.broadcasterUserId,
		);
		if (user) {
			login = user.name;
			name = user.displayName;
		}
	} catch (err) {
		console.warn(
			"Не удалось получить имя канала, шлю заготовку:",
			err instanceof Error ? err.message : String(err),
		);
	}

	const timestamp = new Date().toISOString();
	const messageId = randomUUID();
	const payload = JSON.stringify({
		subscription: {
			id: messageId,
			type: "stream.online",
			version: "1",
			status: "enabled",
			condition: { broadcaster_user_id: config.twitch.broadcasterUserId },
			transport: {
				method: "webhook",
				callback: `${config.baseUrl}/api/twitch`,
			},
			created_at: timestamp,
			cost: 0,
		},
		event: {
			broadcaster_user_id: config.twitch.broadcasterUserId,
			broadcaster_user_login: login,
			broadcaster_user_name: name,
		},
	});

	const expected = createHmac("sha256", config.twitch.eventSubSecret)
		.update(messageId + timestamp + payload)
		.digest("hex");

	const res = await fetch(`${config.baseUrl}/api/twitch`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"twitch-eventsub-message-id": messageId,
			"twitch-eventsub-message-timestamp": timestamp,
			"twitch-eventsub-message-signature": `sha256=${expected}`,
			"twitch-eventsub-message-type": "notification",
		},
		body: payload,
	});

	console.log("Статус:", res.status);
	console.log("Ответ:", (await res.text()) || "(пусто)");
	console.log("Если в канале появился пост — пайплайн stream.online работает.");
}

main().catch((err) => {
	console.error("Ошибка:", err);
	process.exit(1);
});
