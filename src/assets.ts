import { randomInt } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp"]);
const IMAGE_CONTENT_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".jfif": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

export type StreamOnlineImage = {
	path: string;
	filename: string;
	contentType: string;
	data: Buffer;
};

const STREAM_ONLINE_DIR = path.join(
	import.meta.dirname,
	"../assets/stream_online",
);

/**
 * Возвращает данные случайной картинки из assets/stream_online или null,
 * если подходящих файлов нет. Расширения сканируются на месте — готовый
 * список не нужен, достаточно положить файл в папку.
 */
export async function randomStreamOnlineImage(): Promise<StreamOnlineImage | null> {
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
	try {
		const data = await readFile(imagePath);
		const extension = path.extname(chosen.name).toLowerCase();
		const normalizedName =
			extension === ".jfif"
				? `${chosen.name.slice(0, -extension.length)}.jpg`
				: chosen.name;
		return {
			path: imagePath,
			filename: normalizedName,
			contentType: IMAGE_CONTENT_TYPES[extension] ?? "image/jpeg",
			data,
		};
	} catch (err) {
		console.warn("stream_online image read failed:", err);
		return null;
	}
}
