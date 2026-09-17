import type { Telegraf } from "telegraf";
import type { AppConfig } from "../src/config.js";
import { jsonError } from "../src/http.js";

export const config = { runtime: "nodejs", maxDuration: 10 };

async function load(): Promise<{ appConfig: AppConfig; bot: Telegraf }> {
	const [{ getConfig }, { getBot }] = await Promise.all([
		import("../src/config.js"),
		import("../src/telegram.js"),
	]);
	return { appConfig: getConfig(), bot: getBot() };
}

export async function POST(request: Request): Promise<Response> {
	let appConfig: AppConfig;
	let bot: Telegraf;
	try {
		({ appConfig, bot } = await load());
	} catch (err) {
		return jsonError(err);
	}

	const secretToken = request.headers.get("x-telegram-bot-api-secret-token");
	if (
		appConfig.telegram.webhookSecret &&
		secretToken !== appConfig.telegram.webhookSecret
	) {
		return new Response("unauthorized", { status: 401 });
	}

	let update: unknown;
	try {
		update = await request.json();
	} catch {
		return new Response("bad request", { status: 400 });
	}

	try {
		await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
	} catch (err) {
		console.error("update handling failed:", err);
		const share = await import("../src/share.js");
		const details =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		await share.notifyAdmins(
			bot.telegram,
			`❌ Ошибка обработки Telegram update:\n${details.slice(0, 1500)}`,
		);
	}
	// Всегда отвечаем 200, чтобы Telegram не ретраил и не плодил дубли постов.
	return new Response("ok", { status: 200 });
}
