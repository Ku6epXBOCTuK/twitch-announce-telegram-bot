import { errorMessage } from "./errors.js";

export function jsonError(err: unknown): Response {
	const message = errorMessage(err);
	console.error("api:", message);
	return new Response(JSON.stringify({ error: message }), {
		status: 500,
		headers: { "Content-Type": "application/json" },
	});
}
