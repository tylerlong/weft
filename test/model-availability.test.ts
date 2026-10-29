import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";
import { createServer } from "./server-fixture.ts";

const model = (id: string, name = id) => ({
	id,
	name,
	architecture: { output_modalities: ["text"] },
	reasoning: { supported_efforts: ["low", "high"] },
});
async function fixture(catalog: typeof fetch, generate: typeof fetch = fetch) {
	const directory = await mkdtemp(join(tmpdir(), "weft-availability-"));
	const server = createServer(
		generate,
		join(directory, "db.sqlite"),
		catalog,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const request = (route: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${address.port}${route}`, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		request,
		settings: async () => (await request("/api/model-settings")).json(),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("discovery needs a saved key, authenticates complete membership and preserves configuration on key removal", async () => {
	let calls = 0;
	const f = await fixture(async (url, init) => {
		calls++;
		assert.equal(
			String(url),
			"https://openrouter.ai/api/v1/models/user?output_modalities=text",
		);
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			"Bearer saved-key",
		);
		return Response.json({
			data: Array.from({ length: 101 }, (_, i) => model(`model-${i}`)),
		});
	});
	try {
		assert.equal((await f.settings()).discovery.status, "no-key");
		assert.equal(
			(await f.request("/api/models", "POST", { id: "model-0" })).status,
			400,
		);
		await f.request("/api/model-catalog", "POST");
		assert.equal(calls, 0);
		assert.equal(
			(await f.request("/api/model-settings", "PUT", { apiKey: "saved-key" }))
				.status,
			200,
		);
		const catalog = await (await f.request("/api/model-catalog")).json();
		assert.equal(calls, 1);
		assert.equal(catalog.models.length, 101);
		assert.equal(
			(await f.request("/api/models", "POST", { id: "model-100" })).status,
			200,
		);
		const saved = await f.settings();
		await f.request("/api/model-settings", "PUT", { apiKey: "saved-key" });
		assert.equal(calls, 1);
		await f.request("/api/model-settings", "PUT", { removeApiKey: true });
		const removed = await f.settings();
		assert.equal(removed.discovery.status, "no-key");
		assert.deepEqual(removed.models, saved.models);
		assert.equal(removed.defaultModelId, "model-100");
		assert.equal(
			(await f.request("/api/models/model-100", "DELETE")).status,
			400,
		);
	} finally {
		await f.close();
	}
});

test("A-to-B-to-A discovery generations ignore late success and failure without erasing saved choices", async () => {
	const requests: {
		key: string;
		resolve: (response: Response) => void;
		reject: (error: Error) => void;
	}[] = [];
	const f = await fixture(
		async (_url, init) =>
			new Promise<Response>((resolve, reject) =>
				requests.push({
					key: new Headers(init?.headers).get("authorization") ?? "",
					resolve,
					reject,
				}),
			),
	);
	const waitRequests = async (count: number) => {
		while (requests.length < count)
			await new Promise((resolve) => setTimeout(resolve, 5));
	};
	try {
		await f.request("/api/model-settings", "PUT", { apiKey: "A" });
		await waitRequests(1);
		requests[0].resolve(
			Response.json({ data: [model("one", "Original"), model("two")] }),
		);
		await f.request("/api/model-catalog");
		await f.request("/api/models", "POST", { id: "one" });
		await f.request("/api/models", "POST", { id: "two" });
		const project = await (
			await f.request("/api/projects", "POST", { name: "P", folders: [] })
		).json();
		const chat = await (
			await f.request(`/api/projects/${project.id}/chats`, "POST", {
				name: "C",
			})
		).json();
		assert.equal(
			(
				await f.request(`/api/chats/${chat.id}`, "PUT", {
					modelId: "one",
					reasoningEffort: "high",
				})
			).status,
			200,
		);
		const original = await f.settings();
		assert.equal(
			(
				await f.request("/api/model-settings", "PUT", {
					apiKey: "B",
					defaultModelId: "two",
				})
			).status,
			400,
		);
		await f.request("/api/model-settings", "PUT", { apiKey: "B" });
		await waitRequests(2);
		assert.equal((await f.settings()).discovery.status, "loading");
		assert.equal((await f.request("/api/models/one", "DELETE")).status, 400);
		assert.equal(
			(await f.request("/api/model-settings", "PUT", { defaultModelId: "two" }))
				.status,
			400,
		);
		assert.equal(
			(await f.request(`/api/chats/${chat.id}`, "PUT", { modelId: "two" }))
				.status,
			400,
		);
		assert.equal(
			(
				await f.request(`/api/chats/${chat.id}`, "PUT", {
					modelId: "one",
					reasoningEffort: "low",
				})
			).status,
			400,
		);
		assert.equal(
			(
				await f.request(`/api/chats/${chat.id}`, "PUT", {
					name: "Renamed",
					modelId: "one",
					reasoningEffort: "high",
				})
			).status,
			200,
		);
		const staleA = f.request("/api/model-catalog");
		// The first A refresh must be in flight before switching B -> A again.
		requests[1].resolve(Response.json({ data: [model("two")] }));
		await staleA;
		await f.request("/api/model-settings", "PUT", { apiKey: "A" });
		await waitRequests(3);
		await f.request("/api/model-settings", "PUT", { apiKey: "B" });
		await waitRequests(4);
		await f.request("/api/model-settings", "PUT", { apiKey: "A" });
		await waitRequests(5);
		requests[4].resolve(Response.json({ data: [model("two", "Current")] }));
		await f.request("/api/model-catalog");
		requests[2].resolve(Response.json({ data: [model("one", "Stale name")] }));
		requests[3].reject(Error("B secret failure"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const current = await f.settings();
		assert.equal(current.discovery.status, "success");
		assert.deepEqual(
			current.discovery.models.map((row: { id: string }) => row.id),
			["two"],
		);
		assert.equal(current.models[0].name, "Original");
		assert.equal(current.models[1].name, "Current");
		assert.equal(current.defaultModelId, original.defaultModelId);
		const savedChat = await (await f.request(`/api/chats/${chat.id}`)).json();
		assert.deepEqual(savedChat.chatOptions, {
			modelId: "one",
			reasoningEffort: "high",
		});
		assert.equal(
			(
				await f.request(`/api/chats/${chat.id}`, "PUT", {
					name: "Still here",
					modelId: "one",
					reasoningEffort: "high",
				})
			).status,
			200,
		);
		assert.equal(
			(await f.request("/api/model-settings", "PUT", { defaultModelId: "one" }))
				.status,
			200,
		);
		assert.equal(
			(await f.request("/api/model-settings", "PUT", { defaultModelId: "two" }))
				.status,
			200,
		);
		assert.equal(
			(await f.request("/api/model-settings", "PUT", { defaultModelId: "one" }))
				.status,
			400,
		);
	} finally {
		for (const request of requests)
			request.resolve(Response.json({ data: [] }));
		await f.close();
	}
});

test("discovery failure is unknown, preserves credentials and selections, and Retry accepts an empty catalog", async () => {
	let fail = false;
	let data = [model("one"), model("two")];
	let calls = 0;
	const f = await fixture(async () => {
		calls++;
		if (fail) throw Error("private-key provider failure");
		return Response.json({ data });
	});
	try {
		await f.request("/api/model-settings", "PUT", { apiKey: "private-key" });
		await f.request("/api/model-catalog");
		await f.request("/api/models", "POST", { id: "one" });
		const saved = await f.settings();
		fail = true;
		await f.request("/api/model-settings", "PUT", { apiKey: "replacement" });
		const error = await f.request("/api/model-catalog");
		assert.equal(error.status, 502);
		assert.doesNotMatch(await error.text(), /private-key|provider/);
		const failed = await f.settings();
		assert.equal(failed.apiKeyConfigured, true);
		assert.equal(failed.discovery.status, "error");
		assert.deepEqual(failed.discovery.models, []);
		assert.deepEqual(failed.models, saved.models);
		assert.equal(failed.defaultModelId, saved.defaultModelId);
		assert.equal((await f.request("/api/models/one", "DELETE")).status, 400);
		const attempts = calls;
		assert.equal((await f.request("/api/model-catalog")).status, 502);
		assert.equal(calls, attempts);
		fail = false;
		data = [];
		assert.equal((await f.request("/api/model-catalog", "POST")).status, 200);
		assert.equal((await f.settings()).discovery.status, "success");
		assert.equal((await f.request("/api/models/one", "DELETE")).status, 200);
		assert.deepEqual((await f.settings()).models, []);
	} finally {
		await f.close();
	}
});

test("preserved Root and inherited Sub-agent selections still run while explicit overrides use current availability", async () => {
	let data = [model("one"), model("two")];
	let fail = false;
	let rootCalls = 0;
	const requested: string[] = [];
	const toolResults: unknown[] = [];
	const f = await fixture(
		async () => {
			if (fail) throw Error("discovery down");
			return Response.json({ data });
		},
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			requested.push(body.model);
			const prompt = body.input.find(
				(part: { role?: string }) => part.role === "user",
			)?.content;
			if (prompt === "Root" && rootCalls++ === 0) {
				const advertised = body.instructions
					.split(
						"Configured models for create_sub_agent overrides (IDs, names, allowed reasoning efforts): ",
					)[1]
					.split(".\n")[0];
				assert.deepEqual(
					JSON.parse(advertised).map((row: { id: string }) => row.id),
					["two"],
				);
				return completedResponse({
					output: [
						{
							type: "function_call",
							name: "create_sub_agent",
							call_id: "blocked",
							arguments: JSON.stringify({ prompt: "Blocked", model_id: "one" }),
						},
						{
							type: "function_call",
							name: "create_sub_agent",
							call_id: "inherited",
							arguments: JSON.stringify({ prompt: "Inherited" }),
						},
						{
							type: "function_call",
							name: "create_sub_agent",
							call_id: "available",
							arguments: JSON.stringify({
								prompt: "Available",
								model_id: "two",
							}),
						},
					],
				});
			}
			toolResults.push(
				...body.input.filter(
					(part: { type?: string }) => part.type === "function_call_output",
				),
			);
			return completedResponse({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "Done" }] },
				],
			});
		},
	);
	try {
		await f.request("/api/model-settings", "PUT", { apiKey: "key" });
		await f.request("/api/model-catalog");
		await f.request("/api/models", "POST", { id: "one" });
		await f.request("/api/models", "POST", { id: "two" });
		const project = await (
			await f.request("/api/projects", "POST", { name: "P", folders: [] })
		).json();
		const chat = await (
			await f.request(`/api/projects/${project.id}/chats`, "POST", {
				name: "C",
			})
		).json();
		data = [model("two")];
		await f.request("/api/model-catalog", "POST");
		const accepted = await f.request(`/api/chats/${chat.id}`, "POST", {
			prompt: "Root",
		});
		assert.equal(accepted.status, 202);
		const root = await waitForAgent(
			new URL(accepted.url).origin,
			(await accepted.json()).agentId,
		);
		assert.equal(root.status, "succeeded");
		assert(requested.includes("two"));
		assert(requested.filter((id) => id === "one").length >= 2);
		assert.match(JSON.stringify(toolResults), /invalidModel/);
		fail = true;
		assert.equal((await f.request("/api/model-catalog", "POST")).status, 502);
		const next = await f.request(`/api/chats/${chat.id}`, "POST", {
			prompt: "After failed discovery",
		});
		assert.equal(next.status, 202);
		assert.equal(
			(
				await waitForAgent(
					new URL(next.url).origin,
					(
						await next.json()
					).agentId,
				)
			).status,
			"succeeded",
		);
		assert.equal((await f.settings()).defaultModelId, "one");
	} finally {
		await f.close();
	}
});
