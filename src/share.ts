import { Markup } from "telegraf";
import type { Telegram } from "telegraf";
import { getConfig } from "./config.js";

export function inlineKeyboard() {
	const config = getConfig();
	return Markup.inlineKeyboard(
		config.buttons.map((b) => Markup.button.url(b.label, b.url)),
	);
}

export async function postToChannel(
	telegram: Telegram,
	text: string,
): Promise<void> {
	const config = getConfig();
	await telegram.sendMessage(config.telegram.channelId, text, {
		reply_markup: inlineKeyboard().reply_markup,
	});
}

export function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}
