import { getEventSubStatus } from "../src/twitch.js";

async function main() {
	const sub = await getEventSubStatus();
	if (!sub) {
		console.log("Подписки stream.online не найдено.");
		return;
	}
	console.log(
		[
			`id=${sub.id}`,
			`type=${sub.type}`,
			`status=${sub.status}`,
			`created=${sub.creationDate.toISOString()}`,
		].join("\n"),
	);
}

main().catch((err) => {
	console.error("Ошибка:", err);
	process.exit(1);
});
