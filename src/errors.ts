import { TelegramError } from "telegraf";

/** Сколько символов стека уходит в сообщение Telegram (лимит сообщения — 4096). */
const MAX_REPORT_LENGTH = 1500;
/** Сколько символов стека показываем, когда ошибка не от Telegram API. */
const MAX_TECH_LENGTH = 400;

/** Текст ошибки без стека — для логов и JSON-ответов. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Стек ошибки (или её текст), обрезанный под размер сообщения в Telegram. */
export function describeError(err: unknown, limit = MAX_REPORT_LENGTH): string {
	const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
	return text.slice(0, limit);
}

/**
 * Подсказка из структурированных полей ответа Telegram (`parameters`), а не из
 * текста ошибки: `migrate_to_chat_id` и `retry_after` приходят отдельными полями.
 * null — таких полей нет, подсказывать нечего.
 */
function parametersNote(
	parameters: TelegramError["parameters"],
): string | null {
	if (parameters?.migrate_to_chat_id) {
		return `Чат переехал в супергруппу — обнови TELEGRAM_CHANNEL_ID на ${parameters.migrate_to_chat_id}.`;
	}
	if (parameters?.retry_after) {
		return `Telegram просит подождать ${parameters.retry_after} с (лимит частоты отправки).`;
	}
	return null;
}

/**
 * Читаемое описание сбоя обращения к Telegram:
 *
 *   Куда: канал -100…                — если передан target
 *   Telegram API 403: Forbidden: …   — код и текст ответа Telegram как есть
 *   💡 подсказка                     — если Telegram прислал структурированные
 *                                      параметры (лимит частоты, переезд чата)
 *
 */
export function describeTelegramFailure(err: unknown, target?: string): string {
	if (!(err instanceof TelegramError))
		return describeError(err, MAX_TECH_LENGTH);

	const lines = [`Telegram API ${err.code}: ${err.description}`];
	const note = parametersNote(err.parameters);
	if (note) lines.push(`💡 ${note}`);
	if (target) lines.unshift(`Куда: ${target}`);
	return lines.join("\n");
}
