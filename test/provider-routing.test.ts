import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestModel } from "../src/openrouter.ts";
import { createServer } from "../src/server.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase } from "./config-fixture.ts";
import { localFetch, managementTokens } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const responsesUrl = "https://openrouter.ai/api/v1/responses";
const decisionsUrl = "https://openrouter.ai/api/alpha/decisions";
const answer = () =>
	completedResponse({
		output: [
			{ type: "message", content: [{ type: "output_text", text: "Done" }] },
		],
	});
const tool = (
	name = "read_file",
	args: unknown = { path: "/controlled/file" },
	callId = "tool",
) => ({
	type: "function_call",
	name,
	call_id: callId,
	arguments: JSON.stringify(args),
});
const decision = () =>
	Response.json({ answers: { safety: { type: "choice", choice: "allow" } } });
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function fixture(transport: typeof fetch, apiKey = "routing-secret") {
	const directory = await mkdtemp(join(tmpdir(), "weft-routing-"));
	const path = join(directory, "db.sqlite");
	configureDatabase(path, apiKey, "child-model");
	configureDatabase(path, apiKey, "root-model");
	const start = async () => {
		const server = createServer(
			transport,
			path,
			async () => {
				throw Error("Unexpected catalog request");
			},
			async () => ({ status: "succeeded", result: "controlled result" }),
			"a".repeat(64),
			directory,
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		managementTokens.set(base, server.managementToken);
		return { server, base };
	};
	let current = await start();
	const raw = (route: string, method = "GET", body?: unknown) =>
		localFetch(current.base + route, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const request = async (route: string, method = "GET", body?: unknown) => {
		const response = await raw(route, method, body);
		assert(
			response.ok,
			`${method} ${route}: ${response.status} ${await response.clone().text()}`,
		);
		return response.json();
	};
	const stop = async () => {
		current.server.closeAllConnections();
		await new Promise<void>((resolve) => current.server.close(() => resolve()));
		managementTokens.delete(current.base);
	};
	const project = await request("/api/projects", "POST", {
		name: "Routing",
		folders: [],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, "POST", {
		name: "Routing",
	});
	return {
		raw,
		request,
		settings: () => request("/api/model-settings"),
		setRouting: (providerRouting: string) =>
			request("/api/model-settings", "PUT", { providerRouting }),
		ask: async () =>
			(
				await request(`/api/chats/${chat.id}`, "POST", {
					prompt: "Controlled routing task",
				})
			).agentId as number,
		wait: (id: number) => waitForAgent(current.base, id),
		calls: async (id: number) =>
			(await request(`/api/agents/${id}/calls`)).calls as {
				url: string;
				requestBody: string;
				responseBody: string;
			}[],
		restart: async () => {
			await stop();
			current = await start();
		},
		close: async () => {
			await stop();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("provider routing validates whole settings updates atomically and survives restart without disturbing other settings", async () => {
	const f = await fixture(async () => {
		throw Error("Settings must not call OpenRouter");
	});
	try {
		assert.equal((await f.settings()).providerRouting, "default");
		for (const value of ["price", "throughput", "latency", "default"]) {
			assert.equal((await f.setRouting(value)).providerRouting, value);
			await f.restart();
			assert.equal((await f.settings()).providerRouting, value);
		}
		await f.setRouting("latency");
		const before = await f.settings();
		for (const providerRouting of [
			null,
			"",
			"fast",
			"PRICE",
			0,
			false,
			{},
			[],
		]) {
			const invalid = await f.raw("/api/model-settings", "PUT", {
				providerRouting,
				apiKey: "replacement-secret",
				defaultModelId: "child-model",
			});
			assert.equal(invalid.status, 400);
			assert.deepEqual(await f.settings(), before);
			assert.deepEqual(await f.request("/api/settings/credential"), {
				apiKey: "routing-secret",
			});
		}
		assert.deepEqual(await f.request("/api/model-settings", "PUT", {}), before);
		await f.request("/api/model-settings", "PUT", {
			defaultModelId: "child-model",
		});
		assert.equal((await f.settings()).providerRouting, "latency");
		assert.deepEqual(await f.request("/api/settings/credential"), {
			apiKey: "routing-secret",
		});
		await f.restart();
		assert.equal((await f.settings()).defaultModelId, "child-model");
		assert.equal((await f.settings()).providerRouting, "latency");
	} finally {
		await f.close();
	}
});

test("each routing priority and reset map to only provider.sort on Responses and actual Safety Review requests and records", async () => {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	let tasks = 0;
	let priority = "default";
	let credential = "provider";
	const f = await fixture(async (url, init) => {
		const body = JSON.parse(String(init?.body));
		sent.push({ url: String(url), body });
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			`Bearer ${credential}`,
		);
		if (String(url) === decisionsUrl)
			return Response.json({
				answers: { safety: { type: "choice", choice: "allow" } },
				extension: { [credential]: credential, provider: { sort: credential } },
			});
		assert.equal(String(url), responsesUrl);
		if (++tasks % 2 === 1) return completedResponse({ output: [tool()] });
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Done" }] },
			],
			extension: { [credential]: credential, provider: { sort: credential } },
		});
	});
	try {
		for ([priority, credential] of [
			["default", "provider"],
			["price", "price"],
			["throughput", "throughput"],
			["latency", "latency"],
			["price", "sort"],
			["throughput", "provider"],
			["default", "default"],
		]) {
			await f.request("/api/model-settings", "PUT", {
				providerRouting: priority,
				apiKey: credential,
			});
			const start = sent.length;
			const id = await f.ask();
			assert.equal((await f.wait(id)).status, "succeeded");
			const actual = sent.slice(start);
			assert.deepEqual(
				actual.map((call) => call.url),
				[responsesUrl, decisionsUrl, responsesUrl],
			);
			const recorded = await f.calls(id);
			assert.equal(recorded.length, 3);
			for (const [index, call] of actual.entries()) {
				const expectedProvider =
					priority === "default" ? undefined : { sort: priority };
				assert.deepEqual(call.body.provider, expectedProvider);
				assert.equal(
					Object.hasOwn(call.body, "provider"),
					priority !== "default",
				);
				assert.equal(
					call.body.model,
					call.url === responsesUrl ? "root-model" : "~typesafe/jev-latest",
				);
				assert.deepEqual(
					Object.keys(call.body).sort(),
					[
						"model",
						...(call.url === responsesUrl
							? ["input", "instructions", "stream", "tools"]
							: ["questions", "state"]),
						...(priority === "default" ? [] : ["provider"]),
					].sort(),
				);
				const stored = JSON.parse(recorded[index].requestBody);
				assert.deepEqual(stored.provider, expectedProvider);
				assert.equal(Object.hasOwn(stored, "provider"), priority !== "default");
				assert.equal(stored.model, call.body.model);
				if (index > 0) {
					const extension = JSON.parse(recorded[index].responseBody).extension;
					assert.doesNotMatch(
						JSON.stringify(extension),
						new RegExp(credential),
					);
					assert.match(JSON.stringify(extension), /REDACTED/);
				}
			}
		}
	} finally {
		await f.close();
	}
});

test("an in-flight Responses request retains its routing while later Safety Review and task requests read the changed preference", async () => {
	const entered = gate();
	const released = gate();
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const f = await fixture(async (url, init) => {
		sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		if (sent.length === 1) {
			entered.release();
			await released.promise;
			return completedResponse({ output: [tool()] });
		}
		return String(url) === decisionsUrl ? decision() : answer();
	});
	try {
		await f.setRouting("price");
		const id = await f.ask();
		await entered.promise;
		const before = await f.calls(id);
		assert.deepEqual(JSON.parse(before[0].requestBody).provider, {
			sort: "price",
		});
		await f.setRouting("latency");
		released.release();
		assert.equal((await f.wait(id)).status, "succeeded");
		assert.deepEqual(
			sent.map((call) => [call.url, call.body.provider]),
			[
				[responsesUrl, { sort: "price" }],
				[decisionsUrl, { sort: "latency" }],
				[responsesUrl, { sort: "latency" }],
			],
		);
		const stored = await f.calls(id);
		assert.equal(stored[0].requestBody, before[0].requestBody);
		assert.deepEqual(
			stored.map((call) => JSON.parse(call.requestBody).provider),
			[{ sort: "price" }, { sort: "latency" }, { sort: "latency" }],
		);
	} finally {
		released.release();
		await f.close();
	}
});

test("an in-flight Safety Review retains its routing and the next review and task request use the new preference", async () => {
	const entered = gate();
	const released = gate();
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	let reviews = 0;
	let tasks = 0;
	const f = await fixture(async (url, init) => {
		sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		if (String(url) !== decisionsUrl)
			return ++tasks === 1
				? completedResponse({
						output: [
							tool(),
							tool("read_file", { path: "/controlled/next" }, "next"),
						],
					})
				: answer();
		if (++reviews === 1) {
			entered.release();
			await released.promise;
		}
		return decision();
	});
	try {
		await f.setRouting("throughput");
		const id = await f.ask();
		await entered.promise;
		const before = await f.calls(id);
		assert.equal(before.length, 2);
		await f.setRouting("default");
		released.release();
		assert.equal((await f.wait(id)).status, "succeeded");
		assert.deepEqual(
			sent.map((call) => [call.url, call.body.provider]),
			[
				[responsesUrl, { sort: "throughput" }],
				[decisionsUrl, { sort: "throughput" }],
				[decisionsUrl, undefined],
				[responsesUrl, undefined],
			],
		);
		const stored = await f.calls(id);
		assert.equal(stored[1].requestBody, before[1].requestBody);
		assert.deepEqual(
			stored.map((call) => JSON.parse(call.requestBody).provider),
			[{ sort: "throughput" }, { sort: "throughput" }, undefined, undefined],
		);
	} finally {
		released.release();
		await f.close();
	}
});

test("Root Agents and Sub-agents with inherited or overridden models use the current global routing preference", async () => {
	const entered = gate();
	const released = gate();
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	let started = false;
	const f = await fixture(async (url, init) => {
		const body = JSON.parse(String(init?.body));
		sent.push({ url: String(url), body });
		if (String(url) === decisionsUrl) return decision();
		if (!started) {
			started = true;
			entered.release();
			await released.promise;
			return completedResponse({
				output: [
					tool(
						"create_sub_agent",
						{ prompt: "Inherited routing task" },
						"inherited",
					),
					tool(
						"create_sub_agent",
						{ prompt: "Overridden routing task", model_id: "child-model" },
						"overridden",
					),
				],
			});
		}
		return answer();
	});
	try {
		await f.setRouting("price");
		const id = await f.ask();
		await entered.promise;
		await f.setRouting("throughput");
		released.release();
		assert.equal((await f.wait(id)).status, "succeeded");
		const tools = (await f.request(`/api/agents/${id}/tools`)).toolCalls;
		assert.equal(tools.length, 2);
		const children = tools.map((call: { status: string; result: string }) => {
			assert.equal(call.status, "succeeded");
			return JSON.parse(call.result).agent_id as number;
		});
		for (const [index, child] of children.entries()) {
			assert.equal((await f.wait(child)).status, "succeeded");
			const calls = await f.calls(child);
			assert.equal(calls.length, 1);
			const body = JSON.parse(calls[0].requestBody);
			assert.equal(body.model, index === 0 ? "root-model" : "child-model");
			assert.deepEqual(body.provider, { sort: "throughput" });
		}
		assert.deepEqual(sent[0].body.provider, { sort: "price" });
		for (const call of sent.slice(1))
			assert.deepEqual(call.body.provider, { sort: "throughput" });
		assert(sent.some((call) => call.url === decisionsUrl));
		assert(sent.some((call) => call.body.model === "child-model"));
		const recorded = await f.calls(id);
		assert.deepEqual(JSON.parse(recorded[0].requestBody).provider, {
			sort: "price",
		});
		for (const call of recorded.slice(1))
			assert.deepEqual(JSON.parse(call.requestBody).provider, {
				sort: "throughput",
			});
	} finally {
		released.release();
		await f.close();
	}
});

test("multiple Safety Reviews within one tool refresh routing but retain their starting safety setting and redact arbitrary content", async () => {
	const entered = gate();
	const released = gate();
	let priority: "price" | "latency" = "price";
	let safetyReview = true;
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const recorded: Record<string, unknown>[] = [];
	const config = () => ({
		apiKey: "sort",
		model: "root-model",
		providerRouting: priority,
		safetyReview,
	});
	const pending = requestModel(
		[],
		"Controlled task",
		async (url, init) => {
			sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			if (sent.length === 1) return completedResponse({ output: [tool()] });
			if (sent.length === 2) {
				entered.release();
				await released.promise;
			}
			return String(url) === decisionsUrl ? decision() : answer();
		},
		{
			request: (call) => {
				recorded.push(JSON.parse(call.requestBody));
			},
			result: () => {},
		},
		config,
		async (_name, _args, _roots, _signal, review) => {
			assert(review);
			const operation = {
				name: "controlled",
				description: "Controlled operation",
				arguments: { provider: { sort: "sort" } },
			};
			await review(operation);
			await review(operation);
			return { status: "succeeded", result: "done" };
		},
		{
			reviewConfig: config,
			targetFolders: () => [],
			limit: () => 16,
			pending: () => false,
			events: () => [],
			wait: async () => {},
		},
	);
	try {
		await entered.promise;
		priority = "latency";
		safetyReview = false;
		released.release();
		assert.equal(await pending, "Done");
		assert.deepEqual(
			sent.map((call) => [call.url, call.body.provider]),
			[
				[responsesUrl, { sort: "price" }],
				[decisionsUrl, { sort: "price" }],
				[decisionsUrl, { sort: "latency" }],
				[responsesUrl, { sort: "latency" }],
			],
		);
		assert.deepEqual(
			recorded.map((body) => body.provider),
			[
				{ sort: "price" },
				{ sort: "price" },
				{ sort: "latency" },
				{ sort: "latency" },
			],
		);
		for (const body of recorded.slice(1, 3))
			assert.deepEqual(body.state, {
				name: "controlled",
				description: "Controlled operation",
				arguments: { provider: { "[REDACTED]": "[REDACTED]" } },
			});
	} finally {
		released.release();
		await pending;
	}
});
