import { subscribeIfNeeded } from "../src/twitch.js";

async function main() {
	const result = await subscribeIfNeeded();
	console.log(
		result.changed
			? `Подписка создана (id=${result.id ?? "?"})`
			: `Подписка уже активна (id=${result.id ?? "?"})`,
	);
}

main().catch((err) => {
	console.error("Ошибка:", err);
	process.exit(1);
});
