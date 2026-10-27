import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const channel = process.env.WEFT_TEST_EXTENSION_CHANNEL;
test("late extension authorization cannot resume Stop, Steer or shutdown tasks", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 600000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-authorization-")),
	);
	let checkpoint = 0;
	let pendingCheckpoint = 0;
	const site = createServer((req, res) => {
		if (
			["/observed", "/pending"].includes(req.url ?? "") &&
			req.method === "POST"
		) {
			if (req.url === "/pending") pendingCheckpoint++;
			else checkpoint++;
			res.writeHead(303, { location: "/" });
			res.end();
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end(
			'<title>Weft canceled authorization acceptance</title><h1>Unchanged controlled page</h1><form action="/pending" method="post"><button>Record pending authorization</button></form><form action="/observed" method="post"><button>Record failed late authorization</button></form>',
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const siteAddress = site.address();
	assert(siteAddress && typeof siteAddress !== "string");
	const url = `http://127.0.0.1:${siteAddress.port}/`;
	console.log(
		`AUTHORIZATION ACCEPTANCE: Open ${url} in ${channel}. Do not approve connections until the matching CHECKPOINT instruction.`,
	);
	const calls = new Map<string, number>();
	let output = "";
	let phase = 0;
	const tool = (name: string, args: unknown) =>
		completedResponse({
			output: [
				{
					type: "function_call",
					id: "authorization",
					call_id: `authorization-${Date.now()}`,
					name,
					arguments: JSON.stringify(args),
				},
			],
		});
	const answer = () =>
		completedResponse({
			output: [
				{
					type: "message",
					id: "answer",
					content: [
						{ type: "output_text", text: "Explicit replacement completed" },
					],
				},
			],
		});
	const fixture: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const prompt = body.input
			.filter((i: { role: string }) => i.role === "user")
			.at(-1)?.content;
		assert.equal(typeof prompt, "string");
		const operation = prompt.startsWith("Explicit replacement")
			? "replacement"
			: prompt.startsWith("Explicitly reconnect")
				? "reconnect"
				: prompt.match(
						/^Wait for controlled (stop|steer|shutdown) authorization$/,
					)?.[1];
		assert(operation, "Unexpected authorization fixture task");
		calls.set(operation, (calls.get(operation) ?? 0) + 1);
		if (operation === "replacement") return answer();
		const last = body.input
			.filter((i: { type: string }) => i.type === "function_call_output")
			.at(-1);
		const result = last ? JSON.parse(last.output) : undefined;
		output +=
			result?.output?.chunks.map((c: { text: string }) => c.text).join("") ??
			"";
		if (!result) {
			output = "";
			phase = 0;
			return tool("browser_connect", { channel });
		}
		if (result.running)
			return tool("write_stdin", {
				session_id: result.session_id,
				yield_time_ms: 1000,
			});
		assert.equal(
			operation,
			"reconnect",
			"An interrupted task resumed after late authorization",
		);
		assert.equal(result.exitCode, 0, output);
		if (phase++ === 0) {
			assert.match(output, /attached to/);
			output = "";
			return tool("exec_command", {
				cmd: `playwright-cli -s=weft-personal run-code 'async page => {if(page.url()!=="${url}") throw new Error("Select only the authorization test page"); return {heading:await page.locator("h1").textContent()};}'`,
				timeout_ms: 30000,
			});
		}
		if (phase === 2) {
			assert.deepEqual(
				JSON.parse(output.match(/### Result\r?\n(\{[^\n]+\})/)?.[1] ?? "null"),
				{ heading: "Unchanged controlled page" },
			);
			output = "";
			return tool("exec_command", {
				cmd: "playwright-cli -s=weft-personal tab-close && playwright-cli -s=weft-personal detach",
				timeout_ms: 30000,
			});
		}
		return answer();
	};
	const db = join(directory, "db.sqlite");
	let server = createTestServer(
		fixture,
		db,
		"authorization-fixture-key",
	).listen(0, "127.0.0.1");
	let base = "";
	const ready = async () => {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
	};
	await ready();
	const request = async (
		path: string,
		body?: unknown,
		method = body ? "POST" : "GET",
	) => {
		const response = await fetch(base + path, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		assert(response.ok, await response.clone().text());
		return response.json();
	};
	const idle = async (agent: number, expected: string) => {
		for (let n = 0; n < 1800; n++) {
			const state = await request(`/api/agents/${agent}`);
			if (!state.busy) {
				assert.equal(state.agents[0].status, expected, JSON.stringify(state));
				return;
			}
			await setTimeout(100);
		}
		assert.fail("Authorization test Agent did not settle");
	};
	try {
		await request("/api/execution-limits", { modelCallLimit: 300 }, "PATCH");
		const p = await request("/api/projects", {
			name: "Authorization",
			folders: [directory],
		});
		const chat = await request(`/api/projects/${p.id}/chats`, {
			name: "Authorization",
		});
		for (const operation of ["stop", "steer", "shutdown"]) {
			const { agentId } = await request(`/api/chats/${chat.id}`, {
				prompt: `Wait for controlled ${operation} authorization`,
			});
			let pending = false;
			for (let n = 0; n < 300; n++) {
				const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
				pending = tools.some(
					(t: { name: string; result: string }) =>
						t.name === "browser_connect" &&
						t.result &&
						JSON.parse(t.result).running,
				);
				if (pending) break;
				await setTimeout(100);
			}
			assert(
				pending,
				"Connection must actually be waiting before cancellation",
			);
			console.log(
				`AUTHORIZATION PENDING ${operation}: Observe the real pending picker without authorizing it, then click Record pending authorization at ${url}.`,
			);
			const expectedPending = pendingCheckpoint + 1;
			for (let n = 0; n < 1200 && pendingCheckpoint < expectedPending; n++)
				await setTimeout(100);
			assert.equal(
				pendingCheckpoint,
				expectedPending,
				"Real pending authorization was not observed",
			);
			assert.equal(
				(await request(`/api/chats/${chat.id}`)).browserTarget,
				null,
			);
			if (operation === "stop") {
				await request(`/api/agents/${agentId}/cancel`, {});
				await idle(agentId, "cancelled");
			} else if (operation === "steer") {
				const replacement = await request(`/api/chats/${chat.id}`, {
					prompt: "Explicit replacement without browser actions",
					intent: "steer",
					targetAgentId: agentId,
				});
				await idle(replacement.agentId, "succeeded");
				assert.equal(
					(await request(`/api/agents/${agentId}`)).agents[0].status,
					"cancelled",
				);
			} else {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			const oldCalls = calls.get(operation);
			console.log(
				`AUTHORIZATION CHECKPOINT ${operation}: Try the old picker only for ${url}; verify connection fails, close its obsolete picker, then click Record failed late authorization on the controlled page.`,
			);
			const expectedCheckpoint = checkpoint + 1;
			for (let n = 0; n < 1200 && checkpoint < expectedCheckpoint; n++)
				await setTimeout(100);
			assert.equal(
				checkpoint,
				expectedCheckpoint,
				"Late authorization was not observed",
			);
			await setTimeout(1000);
			assert.equal(
				calls.get(operation),
				oldCalls,
				"Late authorization must not resume the old model loop",
			);
			if (operation === "shutdown") {
				server = createTestServer(
					fixture,
					db,
					"authorization-fixture-key",
				).listen(0, "127.0.0.1");
				await ready();
				assert.equal(
					(await request(`/api/agents/${agentId}`)).agents[0].status,
					"failed",
				);
				assert.equal(
					(await request(`/api/agents/${agentId}`)).agents[0].errorCode,
					"agentInterrupted",
				);
			}
			assert.equal(
				(await request(`/api/chats/${chat.id}`)).browserTarget,
				null,
			);
			const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
			assert(
				tools.some(
					(t: {
						name: string;
						commandState: { cancelled?: boolean; interrupted?: boolean };
					}) =>
						t.name === "browser_connect" &&
						(t.commandState?.cancelled || t.commandState?.interrupted),
				),
			);
		}
		console.log(
			`AUTHORIZATION RECONNECT: Approve only ${url} for the new explicit Root.`,
		);
		const { agentId } = await request(`/api/chats/${chat.id}`, {
			prompt:
				"Explicitly reconnect the same controlled browser and inspect the page",
		});
		await idle(agentId, "succeeded");
		assert.equal(
			(await request(`/api/chats/${chat.id}`)).browserTarget.channel,
			channel,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
