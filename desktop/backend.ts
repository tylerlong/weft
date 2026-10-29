import { once } from "node:events";
import { createServer } from "../src/server.ts";

// IPC carries readiness/authority only to the owning desktop process, never tool environments.
export async function startBackend(
	databasePath: string,
	fetchModel: typeof fetch = fetch,
	fetchCatalog: typeof fetch = fetch,
	userHome?: string,
) {
	delete process.env.WEFT_MANAGEMENT_TOKEN;
	const server = createServer(
		fetchModel,
		databasePath,
		fetchCatalog,
		undefined,
		undefined,
		userHome,
	);
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		server.closeAllConnections();
		server.close((error) => {
			if (error)
				process.send?.({
					type: "failure",
					message:
						"Backend cleanup failed. Inspect saved command records before reopening.",
				});
			process.exitCode = error ? 1 : 0;
			if (process.connected) process.disconnect?.();
		});
	};
	process.on("message", (message) => {
		if (typeof message === "object" && message !== null && "type" in message) {
			if (message.type === "stop") stop();
			if (message.type === "work-state")
				process.send?.({ type: "work-state", ...server.workState() });
		}
	});
	process.on("disconnect", stop);
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Backend has no loopback listener");
	process.send?.({
		type: "ready",
		origin: `http://127.0.0.1:${address.port}`,
		token: server.managementToken,
	});
	return server;
}

if (import.meta.main) {
	process.once("message", async (message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("databasePath" in message) ||
			typeof message.databasePath !== "string"
		)
			throw new Error("Missing desktop database path");
		try {
			await startBackend(message.databasePath);
		} catch (error) {
			const message =
				error instanceof Error && error.message === "Unknown database schema"
					? "The desktop database uses an incompatible schema. Keep it for its records and use a compatible Weft build; no data was changed."
					: "The desktop backend could not start. Check application resources and permissions; your database has been preserved.";
			process.send?.({ type: "failure", message });
			if (process.connected) process.disconnect?.();
			process.exitCode = 1;
		}
	});
}
