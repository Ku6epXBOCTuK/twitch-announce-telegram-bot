import { Markup } from "telegraf";
import type { Telegram } from "telegraf";
import type { InlineKeyboardButton, Message } from "telegraf/types";
import { getConfig } from "./config.js";
import { randomStreamOnlineImage } from "./assets.js";

export function inlineKeyboard() {
	const config = getConfig();
	const perRow = 2;
	const rows: InlineKeyboardButton[][] = [];
	for (let i = 0; i < config.buttons.length; i += perRow) {
		rows.push(
			config.buttons
				.slice(i, i + perRow)
				.map((b) => Markup.button.url(b.label, b.url)),
		);
	}
	return Markup.inlineKeyboard(rows);
}

export async function postToChannel(
	telegram: Telegram,
	text: string,
): Promise<Message.TextMessage | Message.PhotoMessage> {
	const config = getConfig();
	const replyMarkup = { reply_markup: inlineKeyboard().reply_markup };
	// Картинки как «фото» — Telegram умеет JPEG/PNG (jfif это jpeg). Нет файла —
	// постим как раньше текстом. Ошибка Telegram (битый файл и т.п.) не глотается,
	// её увидят админы через существующий обработчик.
	const image = await randomStreamOnlineImage();
	if (image) {
		console.log("stream_online image:", image.path);
		return telegram.sendPhoto(
			config.telegram.channelId,
			{ source: image.source },
			{ caption: text, ...replyMarkup },
		);
	}
	return telegram.sendMessage(config.telegram.channelId, text, replyMarkup);
}

/** Сообщение всем админам (ALLOWED_USER_IDS) в личку. Ничего не бросает — уведомления best-effort. */
export async function notifyAdmins(
	telegram: Telegram,
	text: string,
): Promise<void> {
	try {
		const config = getConfig();
		const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
		const results = await Promise.allSettled(
			config.telegram.allowedUserIds.map((id) =>
				telegram.sendMessage(id, body),
			),
		);
		for (const result of results) {
			// В личку не долетело — пишем в лог Vercel, чтобы уведомление не потерялось.
			if (result.status === "rejected") {
				console.warn("admin notify failed:", result.reason);
			}
		}
	} catch (err) {
		console.warn("admin notify failed:", err);
		// лог в личку не должен ломать обработку запроса
	}
}

export function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}
