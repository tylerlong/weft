import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { guardrailRejection } from "./model-error-fixture.ts";
import { completedResponse } from "./model-fixture.ts";
import { createServer } from "./server-fixture.ts";

const blocked = "deepseek/deepseek-v4.1-flash-1017";
const available = "replacement";
const credential = "controlled-private-key";
const message = (text: string) => ({
	type: "message",
	content: [{ type: "output_text", text }],
});

async function fixture(model: typeof fetch) {
	const directory = await mkdtemp(join(tmpdir(), "model-errors-"));
	const server = createServer(model, join(directory, "db.sqlite"), async () =>
		Response.json({
			data: [blocked, available].map((id) => ({
				id,
				name: id,
				architecture: { output_modalities: ["text"] },
				reasoning: { supported_efforts: ["high"] },
			})),
		}),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (path: string, method = "GET", body?: unknown) => {
		const response = await fetch(base + path, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert(
			response.ok,
			`${path}: ${response.status} ${await response.clone().text()}`,
		);
		return response.json();
	};
	await request("/api/model-settings", "PUT", { apiKey: credential });
	await request("/api/model-catalog");
	await request("/api/models", "POST", { id: blocked });
	await request("/api/models", "POST", { id: available });
	const project = await request("/api/projects", "POST", {
		name: "Errors",
		folders: [],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, "POST", {
		name: "Recovery",
	});
	await request(`/api/chats/${chat.id}`, "PUT", {
		modelId: blocked,
		reasoningEffort: "high",
	});
	return {
		request,
		chat,
		ask: async (prompt: string) => {
			const accepted = await request(`/api/chats/${chat.id}`, "POST", {
				prompt,
			});
			return waitForAgent(base, accepted.agentId);
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("guardrail rejection fails the accepted Agent with inspectable redacted details and explicit recovery", async () => {
	const requested: string[] = [];
	const f = await fixture(async (_url, init) => {
		const model = JSON.parse(String(init?.body)).model;
		requested.push(model);
		return model === blocked
			? Response.json(guardrailRejection(credential), { status: 404 })
			: completedResponse({ output: [message("Recovered")] });
	});
	try {
		const before = await f.request("/api/model-settings");
		const failed = await f.ask("Use the saved model");
		assert.equal(failed.status, "failed");
		assert.equal(failed.errorCode, "modelRequestRejected");
		assert.match(
			failed.errorDetails,
			/HTTP 404.*Model blocked by guardrail: 40 endpoints excluded/,
		);
		assert.doesNotMatch(JSON.stringify(failed), new RegExp(credential));
		assert.deepEqual(failed.toolCalls, []);
		assert.equal(failed.calls.length, 1);
		assert.equal(failed.calls[0].status, "failed");
		const records = await f.request(
			`/api/agents/${failed.id}/calls?kind=response`,
		);
		assert.equal(records.calls[0].httpStatus, 404);
		const body = JSON.parse(records.calls[0].responseBody);
		assert.equal(
			body.error.metadata.failed_routing_step,
			"Filter by Guardrails",
		);
		assert.deepEqual(body.error.metadata.ineligibility_reasons, [
			{ code: "model-ignored-by-guardrail", count: 40 },
		]);
		assert.match(body.error.message, /\[REDACTED\]/);
		assert.doesNotMatch(JSON.stringify(records), new RegExp(credential));
		assert.deepEqual(await f.request("/api/model-settings"), before);
		const chat = await f.request(`/api/chats/${f.chat.id}`);
		assert.equal(chat.chatOptions.modelId, blocked);
		assert.equal(chat.chatOptions.reasoningEffort, "high");
		assert.deepEqual(requested, [blocked]);
		await f.request(`/api/chats/${f.chat.id}`, "PUT", { modelId: available });
		const recovered = await f.ask("Continue with the replacement");
		assert.equal(recovered.status, "succeeded");
		assert.equal(recovered.answer, "Recovered");
		assert.deepEqual(requested, [blocked, available]);
		assert.equal((await f.request(`/api/chats/${f.chat.id}`)).agents.length, 2);
	} finally {
		await f.close();
	}
});

for (const body of [
	"<html>upstream failed</html>",
	'{"error":',
	'{"error":{"message":42}}',
	'{"error":{"message":"   "}}',
]) {
	test(`malformed or missing rejection reason retains generic failure: ${body}`, async () => {
		let requests = 0;
		const f = await fixture(async () => {
			requests++;
			return new Response(body, { status: 404 });
		});
		try {
			const failed = await f.ask("Rejected");
			assert.equal(failed.status, "failed");
			assert.equal(failed.errorCode, "modelRequestFailed");
			assert.equal(requests, 1);
			const records = await f.request(
				`/api/agents/${failed.id}/calls?kind=response`,
			);
			assert.equal(records.calls[0].httpStatus, 404);
			assert.equal(records.calls[0].responseBody, body);
		} finally {
			await f.close();
		}
	});
}

test("non-policy JSON rejection uses the provider reason without claiming a policy block", async () => {
	const f = await fixture(async () =>
		Response.json(
			{ error: { message: "Rate limit exceeded" } },
			{ status: 429 },
		),
	);
	try {
		const failed = await f.ask("Rejected");
		assert.equal(failed.errorCode, "modelRequestRejected");
		assert.equal(failed.errorDetails, "HTTP 429: Rate limit exceeded");
		assert.doesNotMatch(failed.errorDetails, /guardrail|company|block/i);
	} finally {
		await f.close();
	}
});

test("inherited Sub-agent rejection leaves parent and sibling responsive without retries", async () => {
	let roots = 0;
	let rejected = 0;
	const f = await fixture(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		assert.equal(request.model, blocked);
		const prompt = request.input.find(
			(item: { role?: string }) => item.role === "user",
		)?.content;
		if (prompt === "rejected child") {
			rejected++;
			return Response.json(guardrailRejection(credential), { status: 404 });
		}
		if (prompt === "healthy sibling")
			return completedResponse({ output: [message("Sibling succeeded")] });
		roots++;
		return completedResponse({
			output:
				roots === 1
					? ["rejected child", "healthy sibling"].map((prompt, index) => ({
							type: "function_call",
							name: "create_sub_agent",
							call_id: `child-${index}`,
							arguments: JSON.stringify({ prompt }),
						}))
					: [message("Parent handled child results")],
		});
	});
	try {
		const parent = await f.ask("Delegate");
		assert.equal(parent.status, "succeeded");
		assert.equal(rejected, 1);
		const tools = await f.request(`/api/agents/${parent.id}/tools`);
		assert.equal(tools.toolCalls.length, 2);
		const children = await Promise.all(
			tools.toolCalls.map(async (tool: { result: string }) => {
				const id = JSON.parse(tool.result).agent_id;
				return (await f.request(`/api/agents/${id}`)).agents[0];
			}),
		);
		assert.deepEqual(
			children.map((child) => child.status),
			["failed", "succeeded"],
		);
		assert.equal(children[0].errorCode, "modelRequestRejected");
		assert.match(children[0].errorDetails, /Model blocked by guardrail/);
		assert.doesNotMatch(JSON.stringify(children), new RegExp(credential));
	} finally {
		await f.close();
	}
});
