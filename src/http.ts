export function jsonError(err: unknown): Response {
	const message = err instanceof Error ? err.message : String(err);
	console.error("api:", message);
	return new Response(JSON.stringify({ error: message }), {
		status: 500,
		headers: { "Content-Type": "application/json" },
	});
}
