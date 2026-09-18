import { Markup } from "telegraf";
import type { Telegram } from "telegraf";
import type { InlineKeyboardButton, Message } from "telegraf/types";
import { getConfig } from "./config.js";

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
): Promise<Message.TextMessage> {
	const config = getConfig();
	return telegram.sendMessage(config.telegram.channelId, text, {
		reply_markup: inlineKeyboard().reply_markup,
	});
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
