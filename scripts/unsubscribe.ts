import { deleteEventSub } from "../src/twitch.js";

async function main() {
	const removed = await deleteEventSub();
	console.log(
		removed === 0
			? "Подписок stream.online не было."
			: `Удалено подписок: ${removed}`,
	);
}

main().catch((err) => {
	console.error("Ошибка:", err);
	process.exit(1);
});
