import { type Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Message } from "telegraf/types";
import { getConfig } from "./config.js";
import { describeTelegramFailure } from "./errors.js";
import { copyMessageToChannel, notifyAdmins, postToChannel } from "./share.js";
import {
	deleteEventSub,
	getEventSubStatus,
	subscribeIfNeeded,
} from "./twitch.js";

let botInstance: Telegraf | null = null;

const FORWARDABLE_MEDIA_KEYS = [
	"animation",
	"audio",
	"document",
	"photo",
	"sticker",
	"video",
	"video_note",
	"voice",
] as const;

type ActionRun = () => Promise<string>;

function hasForwardableMedia(message: Message): boolean {
	return FORWARDABLE_MEDIA_KEYS.some((key) => key in message);
}

/** Отвечает на нажатие кнопки: показывает и результат, и понятную причину сбоя. */
async function runAction(
	ctx: Context,
	title: string,
	run: ActionRun,
): Promise<void> {
	await ctx.answerCbQuery().catch(() => undefined);
	try {
		await ctx.reply(await run());
	} catch (err) {
		console.error(`${title} failed:`, err);
		await ctx
			.reply(`❌ ${title}: не получилось\n${describeTelegramFailure(err)}`)
			.catch(() => undefined);
	}
}

export function getBot(): Telegraf {
	if (!botInstance) {
		botInstance = createBot();
	}
	return botInstance;
}

function createBot(): Telegraf {
	const config = getConfig();
	const bot = new Telegraf(config.telegram.token);

	bot.on(message(), async (ctx, next) => {
		if (!config.telegram.allowedUserIds.includes(ctx.from.id)) return;
		const text =
			"text" in ctx.message && ctx.message.text.length > 0
				? ctx.message.text
				: undefined;
		if (text?.startsWith("/")) return next();
		if (!text && !hasForwardableMedia(ctx.message)) return next();

		try {
			if (text) {
				await postToChannel(bot.telegram, text);
			} else {
				await copyMessageToChannel(
					bot.telegram,
					ctx.chat.id,
					ctx.message.message_id,
				);
			}
		} catch (err) {
			// Сбой постинга — отдельная ветка: автор сразу получает причину
			// (например «chat not found»), а не общий стек из bot.catch.
			console.error("manual post failed:", err);
			await ctx
				.reply(
					`❌ Не опубликовано:\n${describeTelegramFailure(err, `канал ${config.telegram.channelId}`)}`,
				)
				.catch(() => undefined);
			return;
		}
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

	bot.action("twitch_status", (ctx) =>
		runAction(ctx, "Статус подписки", async () => {
			const sub = await getEventSubStatus();
			return sub ? `Статус: ${sub.status} (id ${sub.id})` : "Подписки нет";
		}),
	);

	bot.action("twitch_on", (ctx) =>
		runAction(ctx, "Включение подписки", async () => {
			const result = await subscribeIfNeeded();
			return result.changed
				? "Подписка создаётся (ждёт подтверждения Twitch)…"
				: "Подписка уже активна";
		}),
	);

	bot.action("twitch_off", (ctx) =>
		runAction(ctx, "Выключение подписки", async () => {
			const deleted = await deleteEventSub();
			return deleted > 0 ? `Подписка удалена (${deleted})` : "Подписки не было";
		}),
	);

	bot.catch((err, ctx) => {
		console.error("bot error:", err, ctx.update);
		void notifyAdmins(
			bot.telegram,
			`❌ Ошибка бота:\n${describeTelegramFailure(err)}`,
		);
	});

	return bot;
}
