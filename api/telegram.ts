import { config as appConfig } from "../src/config.js";
import { bot } from "../src/telegram.js";

export const config = { runtime: "nodejs", maxDuration: 10 };

export async function POST(request: Request): Promise<Response> {
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
	}
	// Всегда отвечаем 200, чтобы Telegram не ретраил и не плодил дубли постов.
	return new Response("ok", { status: 200 });
}
