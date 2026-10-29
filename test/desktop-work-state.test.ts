import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestServer } from "./config-fixture.ts";

test("desktop Quit state includes active work and idle queues without changing either", async () => {
	const directory = await mkdtemp(join(tmpdir(), "weft-quit-state-"));
	const server = createTestServer(
		async (_url, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const api = async (path: string, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"x-weft-management-token": server.managementToken,
				origin: `http://127.0.0.1:${address.port}`,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert(response.ok, await response.clone().text());
		return response.json();
	};
	try {
		assert.deepEqual(server.workState(), { active: false, queued: false });
		const project = await api("/api/projects", {
			name: "Quit",
			folders: [directory],
		});
		const chat = await api(`/api/projects/${project.id}/chats`, {
			name: "Work",
		});
		const route = `/api/chats/${chat.id}`;
		const { agentId } = await api(route, { prompt: "hold" });
		assert.deepEqual(server.workState(), { active: true, queued: false });
		await api(route, { prompt: "pending", intent: "queue" });
		assert.deepEqual(server.workState(), { active: true, queued: true });
		await api(`/api/agents/${agentId}/cancel`, {});
		assert.deepEqual(server.workState(), { active: false, queued: true });
		assert.equal((await api(route)).queue.length, 1);
		assert.deepEqual(server.workState(), { active: false, queued: true });
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
