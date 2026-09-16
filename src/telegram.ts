import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { getConfig } from "./config.js";
import { postToChannel } from "./share.js";
import {
	deleteEventSub,
	getEventSubStatus,
	subscribeIfNeeded,
} from "./twitch.js";

let botInstance: Telegraf | null = null;

export function getBot(): Telegraf {
	if (!botInstance) {
		botInstance = createBot();
	}
	return botInstance;
}

function createBot(): Telegraf {
	const config = getConfig();
	const bot = new Telegraf(config.telegram.token);

	bot.on(message("text"), async (ctx) => {
		if (!config.telegram.allowedUserIds.includes(ctx.from.id)) return;
		if (ctx.message.text.startsWith("/")) return; // команды в канал не идут

		await postToChannel(bot.telegram, ctx.message.text);
		if (config.telegram.replyToAuthor) {
			await ctx.reply("Опубликовано").catch(() => undefined);
		}
	});

	bot.command("menu", async (ctx) => {
		await ctx.reply(
			"Бот постинга — управление Twitch:",
			Markup.inlineKeyboard([
				Markup.button.callback("Статус подписки", "twitch_status"),
				Markup.button.callback("Включить", "twitch_on"),
				Markup.button.callback("Выключить", "twitch_off"),
			]),
		);
	});

	bot.action("twitch_status", async (ctx) => {
		await ctx.answerCbQuery();
		const sub = await getEventSubStatus();
		await ctx.reply(
			sub ? `Статус: ${sub.status} (id ${sub.id})` : "Подписки нет",
		);
	});

	bot.action("twitch_on", async (ctx) => {
		await ctx.answerCbQuery();
		const result = await subscribeIfNeeded();
		await ctx.reply(
			result.changed
				? "Подписка создаётся (ждёт подтверждения Twitch)…"
				: "Подписка уже активна",
		);
	});

	bot.action("twitch_off", async (ctx) => {
		await ctx.answerCbQuery();
		const deleted = await deleteEventSub();
		await ctx.reply(
			deleted > 0 ? `Подписка удалена (${deleted})` : "Подписки не было",
		);
	});

	bot.catch((err, ctx) => {
		console.error("bot error:", err, ctx.update);
	});

	return bot;
}
