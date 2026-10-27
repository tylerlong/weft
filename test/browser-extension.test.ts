import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

// Explicit opt-in: the operator selects only this test's page in the real extension UI.
const channel = process.env.WEFT_TEST_EXTENSION_CHANNEL;
test("real extension reuses a controlled website login through HTTP and retains command records", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 180000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-extension-")),
	);
	const loginCookie = `weft_test_${randomUUID()}=active`;
	const site = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		if (request.url === "/login" && request.method === "POST") {
			response.writeHead(303, {
				"set-cookie": `${loginCookie}; HttpOnly; SameSite=Strict`,
				location: "/",
			});
			response.end();
		} else if (request.headers.cookie?.includes(loginCookie)) {
			response.end(
				"<title>Weft extension acceptance</title><h1>Protected extension proof</h1>",
			);
		} else {
			response.end(
				'<title>Weft extension acceptance</title><form method="post" action="/login"><button>Test login</button></form>',
			);
		}
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const siteAddress = site.address();
	assert(siteAddress && typeof siteAddress !== "string");
	const siteUrl = `http://127.0.0.1:${siteAddress.port}/`;
	console.log(
		`EXTENSION ACCEPTANCE: Open ${siteUrl} in ${channel}, click Test login, then select that page in the extension connection UI.`,
	);
	const cli = "playwright-cli -s=weft-extension-acceptance";
	let phase = "attach",
		session = 0,
		polls = 0,
		commandOutput = "";
	const server = createTestServer(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			const result = last ? JSON.parse(last.output) : undefined;
			commandOutput +=
				result?.output?.chunks
					?.map((chunk: { text: string }) => chunk.text)
					.join("") ?? "";
			const text = commandOutput;
			if (result?.error) assert.fail(JSON.stringify(result));
			let name = "exec_command";
			const command = (cmd: string) => ({
				cmd,
				workdir: directory,
				timeout_ms: 30000,
				max_output_tokens: 4000,
			});
			let args: unknown;
			if (!result) {
				args = {
					cmd: `${cli} attach --extension=${channel}`,
					workdir: directory,
					yield_time_ms: 1000,
					max_output_tokens: 4000,
				};
			} else if (result.running) {
				assert(++polls <= 120, "Extension authorization did not finish");
				session = result.session_id;
				name = "write_stdin";
				args = {
					session_id: session,
					yield_time_ms: 1000,
					max_output_tokens: 4000,
				};
			} else {
				assert.equal(result.exitCode, 0, text);
				if (phase === "attach") {
					assert.match(text, /attached to/);
					phase = "proof";
					args = command(
						`${cli} run-code 'async page => { if (page.url() !== "${siteUrl}") throw new Error("Select only the localhost acceptance tab"); await page.goto("${siteUrl}"); return {url: page.url(), proof: await page.getByRole("heading", {name: "Protected extension proof", exact: true}).textContent()}; }'`,
					);
				} else if (phase === "proof") {
					assert.deepEqual(
						JSON.parse(
							text.match(/### Result\r?\n(\{[^\n]+\})/)?.[1] ?? "null",
						),
						{ url: siteUrl, proof: "Protected extension proof" },
					);
					phase = "close-page";
					args = command(`${cli} tab-close`);
				} else if (phase === "close-page") {
					phase = "detach";
					args = command(`${cli} detach`);
				} else {
					phase = "complete";
					return completedResponse({
						output: [
							{
								id: "answer",
								type: "message",
								content: [
									{
										type: "output_text",
										text: "Extension acceptance complete",
									},
								],
							},
						],
					});
				}
			}
			if (!result?.running) commandOutput = "";
			return completedResponse({
				output: [
					{
						id: `tool-${phase}-${polls}`,
						call_id: `tool-${phase}-${polls}`,
						type: "function_call",
						name,
						arguments: JSON.stringify(args),
					},
				],
			});
		},
		join(directory, "db.sqlite"),
		"extension-fixture-api-key",
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
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
	try {
		await request("/api/execution-limits", { modelCallLimit: 300 }, "PATCH");
		const project = await request("/api/projects", {
			name: "Extension acceptance",
			folders: [directory],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: "Extension acceptance",
		});
		const { agentId } = await request(`/api/chats/${chat.id}`, {
			prompt:
				"Read only the controlled protected page using the installed browser extension, then close only that test page and detach.",
		});
		let agent: { status: string } | undefined;
		for (let attempt = 0; attempt < 1600; attempt++) {
			agent = (await request(`/api/agents/${agentId}`)).agents[0];
			if (agent && !["pending", "running"].includes(agent.status)) break;
			await setTimeout(100);
		}
		assert.equal(agent?.status, "succeeded", JSON.stringify(agent));
		assert.equal(phase, "complete");
		const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
		const proof = tools.find((tool: { arguments: string }) =>
			tool.arguments.includes("run-code"),
		);
		assert(proof);
		assert(
			JSON.parse(proof.result).output.chunks.some((chunk: { text: string }) =>
				chunk.text.includes('"proof":"Protected extension proof"'),
			),
		);
		const detail = (
			await request(`/api/agents/${agentId}/tools?toolId=${proof.id}`)
		).toolCalls[0];
		assert(
			detail.output.some((chunk: { text: string }) =>
				chunk.text.includes('"proof":"Protected extension proof"'),
			),
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
