import { type Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Message } from "telegraf/types";
import { getConfig } from "./config.js";
import { postTelegramMessageToDiscord } from "./discord.js";
import { describeError, describeTelegramFailure } from "./errors.js";
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

		const hasMedia = hasForwardableMedia(ctx.message);
		const telegramPost = hasMedia
			? copyMessageToChannel(bot.telegram, ctx.chat.id, ctx.message.message_id)
			: postToChannel(bot.telegram, text ?? "");
		const discordPost = postTelegramMessageToDiscord(
			bot.telegram,
			"posts",
			ctx.message,
		);
		const [telegramResult, discordResult] = await Promise.allSettled([
			telegramPost,
			discordPost,
		]);

		if (telegramResult.status === "rejected") {
			// Сбой постинга — отдельная ветка: автор сразу получает причину
			// (например «chat not found»), а не общий стек из bot.catch.
			console.error("manual Telegram post failed:", telegramResult.reason);
			await ctx
				.reply(
					`❌ Не опубликовано в Telegram:\n${describeTelegramFailure(telegramResult.reason, `канал ${config.telegram.channelId}`)}`,
				)
				.catch(() => undefined);
		}
		if (discordResult.status === "rejected") {
			console.error("manual Discord post failed:", discordResult.reason);
			await notifyAdmins(
				bot.telegram,
				`❌ Пост в Discord не опубликован.\n\n${describeError(discordResult.reason)}`,
			);
		} else if (discordResult.value.attachmentError) {
			console.error(
				"manual Discord media failed:",
				discordResult.value.attachmentError,
			);
			await notifyAdmins(
				bot.telegram,
				`⚠️ Текст поста опубликован в Discord, но вложение пропущено.\n\n${describeError(discordResult.value.attachmentError)}`,
			);
		}
		if (telegramResult.status === "rejected") return;

		if (config.telegram.replyToAuthor) {
			const discordNote =
				discordResult.status === "rejected"
					? "\nDiscord: не опубликовано"
					: discordResult.value.attachmentError
						? "\nDiscord: текст опубликован, вложение пропущено"
						: "";
			await ctx.reply(`Опубликовано${discordNote}`).catch(() => undefined);
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
