import { randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp"]);

const STREAM_ONLINE_DIR = path.join(
	import.meta.dirname,
	"../assets/stream_online",
);

/**
 * Возвращает поток случайной картинки из assets/stream_online или null,
 * если подходящих файлов нет. Расширения сканируются на месте — готовый
 * список не нужен, достаточно положить файл в папку.
 */
export async function randomStreamOnlineImage(): Promise<{
	path: string;
	source: NodeJS.ReadableStream;
} | null> {
	let entries;
	try {
		entries = await readdir(STREAM_ONLINE_DIR, { withFileTypes: true });
	} catch (err) {
		console.warn("stream_online assets dir missing:", err);
		return null;
	}
	const images = entries.filter(
		(entry) =>
			entry.isFile() &&
			IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
	);
	if (images.length === 0) {
		return null;
	}
	const chosen = images[randomInt(images.length)];
	const imagePath = path.join(STREAM_ONLINE_DIR, chosen.name);
	return { path: imagePath, source: createReadStream(imagePath) };
}
