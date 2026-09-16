import "dotenv/config";

export type Button = { label: string; url: string };

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env variable: ${name}`);
	}
	return value;
}

function parseUserIds(raw: string | undefined): number[] {
	if (!raw) throw new Error("Missing required env variable: ALLOWED_USER_IDS");
	return raw
		.split(",")
		.map((id) => Number(id.trim()))
		.filter((id) => Number.isFinite(id));
}

function parseButtons(raw: string | undefined): Button[] {
	if (!raw) return [{ label: "Twitch", url: "https://twitch.tv/" }];
	return raw.split("|").map((pair) => {
		const [label, url] = pair.split(":", 2);
		return { label: label.trim(), url: url.trim() };
	});
}

const baseUrl = requiredEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");

export const config = {
	telegram: {
		token: requiredEnv("TELEGRAM_BOT_TOKEN"),
		channelId: requiredEnv("TELEGRAM_CHANNEL_ID"),
		allowedUserIds: parseUserIds(process.env.ALLOWED_USER_IDS),
		webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
		replyToAuthor: process.env.REPLY_TO_AUTHOR !== "false",
	},
	twitch: {
		clientId: requiredEnv("TWITCH_CLIENT_ID"),
		clientSecret: requiredEnv("TWITCH_CLIENT_SECRET"),
		broadcasterUserId: requiredEnv("TWITCH_BROADCASTER_USER_ID"),
		eventSubSecret: requiredEnv("EVENTSUB_SECRET"),
	},
	baseUrl,
	buttons: parseButtons(process.env.BUTTONS),
	templates: {
		// сообщение из бота (1:1 как было), без шаблонизации
		streamOnline: "🎬 {channel} запустился!\n\n{title}\nИгра: {gameName}",
	},
};
