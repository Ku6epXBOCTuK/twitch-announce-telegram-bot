import path from "node:path";
import type { Telegram } from "telegraf";
import type { Message } from "telegraf/types";
import { getConfig } from "./config.js";

const DISCORD_MAX_CONTENT_LENGTH = 2000;
const DISCORD_REQUEST_TIMEOUT_MS = 5000;
const DISCORD_MAX_ERROR_LENGTH = 500;

export type DiscordTarget = "stream" | "posts";

export type DiscordAttachment = {
	data: Buffer;
	filename: string;
	contentType?: string;
};

export type TelegramDiscordResult = {
	attachmentPosted: boolean;
	attachmentError?: unknown;
};

type MediaFile = {
	file_id: string;
	file_name?: string;
	mime_type?: string;
};

type MediaMessage = {
	text?: string;
	caption?: string;
	photo?: Array<{
		file_id: string;
		file_size?: number;
	}>;
	document?: MediaFile;
	animation?: MediaFile;
	audio?: MediaFile;
	sticker?: MediaFile;
	video?: MediaFile;
	video_note?: MediaFile;
	voice?: MediaFile;
};

const CONTENT_TYPES: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".m4a": "audio/mp4",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".ogg": "audio/ogg",
	".png": "image/png",
	".webm": "video/webm",
	".webp": "image/webp",
};

function webhookUrl(target: DiscordTarget): string | undefined {
	const config = getConfig();
	return target === "stream"
		? config.discord.streamOnlineWebhookUrl
		: config.discord.postsWebhookUrl;
}

export function discordWebhookConfigured(target: DiscordTarget): boolean {
	return Boolean(webhookUrl(target));
}

function splitContent(content: string): string[] {
	if (!content) return [""];
	const characters = Array.from(content);
	const chunks: string[] = [];
	for (
		let offset = 0;
		offset < characters.length;
		offset += DISCORD_MAX_CONTENT_LENGTH
	) {
		chunks.push(
			characters.slice(offset, offset + DISCORD_MAX_CONTENT_LENGTH).join(""),
		);
	}
	return chunks;
}

function safeFilename(value: string | undefined, fallback: string): string {
	const filename = value
		?.replace(/[\\/]/g, "_")
		.replace(/[\u0000-\u001f\u007f"]/g, "")
		.trim();
	return filename || fallback;
}

function filenameFromLink(link: URL, fallback: string): string {
	let pathname = link.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		pathname = link.pathname;
	}
	return safeFilename(path.posix.basename(pathname), fallback);
}

function normalizeFilename(filename: string): string {
	if (path.extname(filename).toLowerCase() === ".jfif") {
		return `${filename.slice(0, -5)}.jpg`;
	}
	return filename;
}

function contentTypeFor(filename: string, provided?: string): string {
	if (provided && provided !== "application/octet-stream") return provided;
	return (
		CONTENT_TYPES[path.extname(filename).toLowerCase()] ??
		"application/octet-stream"
	);
}

function asMediaMessage(message: Message): MediaMessage {
	return message as unknown as MediaMessage;
}

function messageText(message: Message): string | undefined {
	const media = asMediaMessage(message);
	if (typeof media.text === "string" && media.text.length > 0)
		return media.text;
	if (typeof media.caption === "string" && media.caption.length > 0)
		return media.caption;
	return undefined;
}

function mediaFile(message: Message): MediaFile | null {
	const media = asMediaMessage(message);
	if (media.photo && media.photo.length > 0) {
		const largest = media.photo.reduce((current, candidate) =>
			(candidate.file_size ?? 0) >= (current.file_size ?? 0)
				? candidate
				: current,
		);
		return { file_id: largest.file_id };
	}
	const candidates = [
		media.document,
		media.animation,
		media.audio,
		media.sticker,
		media.video,
		media.video_note,
		media.voice,
	];
	return candidates.find((candidate) => candidate) ?? null;
}

async function downloadTelegramFile(
	telegram: Telegram,
	file: MediaFile,
): Promise<DiscordAttachment> {
	const link = await telegram.getFileLink(file.file_id);
	const response = await fetch(link, {
		signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Telegram file download failed (${response.status})`);
	}
	const data = Buffer.from(await response.arrayBuffer());
	const filename = normalizeFilename(
		safeFilename(file.file_name, filenameFromLink(link, "telegram-file")),
	);
	return {
		data,
		filename,
		contentType: contentTypeFor(filename, file.mime_type),
	};
}

async function sendDiscordRequest(
	url: string,
	content: string,
	attachments: DiscordAttachment[],
): Promise<void> {
	const endpoint = new URL(url);
	endpoint.searchParams.set("wait", "true");
	const payload: {
		content?: string;
		allowed_mentions: { parse: string[] };
	} = { allowed_mentions: { parse: [] } };
	if (content) payload.content = content;

	let body: BodyInit;
	let headers: HeadersInit | undefined;
	if (attachments.length > 0) {
		const form = new FormData();
		form.append("payload_json", JSON.stringify(payload));
		for (const [index, attachment] of attachments.entries()) {
			const blob = new Blob([new Uint8Array(attachment.data)], {
				type: attachment.contentType ?? "application/octet-stream",
			});
			form.append(`files[${index}]`, blob, attachment.filename);
		}
		body = form;
	} else {
		headers = { "Content-Type": "application/json" };
		body = JSON.stringify(payload);
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => ""))
			.trim()
			.slice(0, DISCORD_MAX_ERROR_LENGTH);
		throw new Error(
			`Discord webhook failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
}

export async function postToDiscord(
	target: DiscordTarget,
	content: string,
	attachments: DiscordAttachment[] = [],
): Promise<void> {
	const url = webhookUrl(target);
	if (!url) return;

	const chunks = splitContent(content);
	await Promise.all(
		chunks.map((chunk, index) =>
			sendDiscordRequest(url, chunk, index === 0 ? attachments : []),
		),
	);
}

export async function postTelegramMessageToDiscord(
	telegram: Telegram,
	target: DiscordTarget,
	message: Message,
): Promise<TelegramDiscordResult> {
	if (!discordWebhookConfigured(target)) return { attachmentPosted: false };

	const content = messageText(message) ?? "";
	const file = mediaFile(message);
	let attachment: DiscordAttachment | undefined;
	let mediaError: unknown;

	if (file) {
		try {
			attachment = await downloadTelegramFile(telegram, file);
		} catch (err) {
			mediaError = err;
			console.error("Telegram media download for Discord failed:", err);
		}
	}

	if (content || attachment) {
		try {
			await postToDiscord(target, content, attachment ? [attachment] : []);
		} catch (err) {
			if (!attachment || !content) throw err;
			await postToDiscord(target, content);
			return { attachmentPosted: false, attachmentError: err };
		}
	}
	if (mediaError) {
		if (!content && !attachment) throw mediaError;
		return { attachmentPosted: false, attachmentError: mediaError };
	}
	return { attachmentPosted: Boolean(attachment) };
}
