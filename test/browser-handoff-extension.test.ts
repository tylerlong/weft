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

const channel = process.env.WEFT_TEST_EXTENSION_CHANNEL;
const tool = (name: string, args: unknown) =>
	completedResponse({
		output: [
			{
				type: "function_call",
				id: "handoff",
				call_id: `handoff-${Date.now()}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	});
const answer = (text: string) =>
	completedResponse({
		output: [
			{
				type: "message",
				id: "answer",
				content: [{ type: "output_text", text }],
			},
		],
	});

test("ordinary chat continues a human handoff and unfinished page after Root cleanup", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 600000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-handoff-")),
	);
	let completions = 0;
	let profileClosed = false;
	const stateCookie = `weft_handoff_${randomUUID()}=active`;
	const site = createServer((req, res) => {
		if (req.url === "/profile-closed" && req.method === "POST") {
			profileClosed = true;
			res.end("Recorded");
			return;
		}
		if (req.url === "/complete" && req.method === "POST") {
			completions++;
			res.writeHead(303, {
				location: "/",
				"set-cookie": `${stateCookie}; Max-Age=3600; HttpOnly; SameSite=Strict`,
			});
			res.end();
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end(
			completions === 1 && req.headers.cookie?.includes(stateCookie)
				? "<title>Weft human handoff acceptance</title><h1>Human handoff content</h1>"
				: '<title>Weft human handoff acceptance</title><h1>Human action required</h1><form method="post" action="/complete"><label>Unfinished step<input name="draft"></label><button>Complete controlled human step</button></form>',
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const siteAddress = site.address();
	assert(siteAddress && typeof siteAddress !== "string");
	const url = `http://127.0.0.1:${siteAddress.port}/`;
	console.log(
		`HANDOFF ACCEPTANCE: Open ${url} in ${channel}. Approve only that tab on every connection. Do NOT complete the human step until HANDOFF HUMAN ACTION REQUESTED.`,
	);
	let scenario = "first";
	let phase = 0;
	let output = "";
	let target:
		| { channel: string; userDataDir: string; profile: string }
		| undefined;
	const observed: {
		scenario: string;
		heading: string;
		draft: string | null;
	}[] = [];
	const fixture: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const last = body.input
			.filter((i: { type: string }) => i.type === "function_call_output")
			.at(-1);
		const result = last ? JSON.parse(last.output) : undefined;
		output +=
			result?.output?.chunks.map((c: { text: string }) => c.text).join("") ??
			"";
		if (result?.error) assert.fail(JSON.stringify(result));
		const current = JSON.parse(
			body.instructions.match(
				/Chat personal browser target: (.+?)\. Use browser_connect/,
			)?.[1] ?? "null",
		);
		if (!result) {
			phase = 0;
			output = "";
			assert.deepEqual(current, target ?? null);
			return tool("browser_connect", target ? {} : { channel });
		}
		if (result.running)
			return tool("write_stdin", {
				session_id: result.session_id,
				yield_time_ms: 1000,
			});
		assert.equal(result.exitCode, 0, output);
		if (phase++ === 0) {
			assert.match(output, /attached to/);
			target ??= current;
			assert.deepEqual(current, target);
			assert(current);
			if (process.env.PWTEST_EXTENSION_USER_DATA_DIR)
				assert.equal(
					current.userDataDir,
					process.env.PWTEST_EXTENSION_USER_DATA_DIR,
				);
			if (process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME)
				assert.equal(
					current.profile,
					process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME,
				);
			output = "";
			const prepare =
				scenario === "first"
					? 'await page.getByLabel("Unfinished step").fill("pending-first-step");'
					: "";
			return tool("exec_command", {
				cmd: `playwright-cli -s=weft-personal run-code 'async page => {if(page.url()!=="${url}") throw new Error("Select only the localhost handoff page"); ${prepare} return {heading:await page.locator("h1").textContent(),draft:await page.getByLabel("Unfinished step").count()?await page.getByLabel("Unfinished step").inputValue():null};}'`,
				timeout_ms: 30000,
			});
		}
		if (phase === 2) {
			const proof = JSON.parse(
				output.match(/### Result\r?\n(\{[^\n]+\})/)?.[1] ?? "null",
			);
			const pending = ["first", "not-done"].includes(scenario);
			assert.deepEqual(
				proof,
				pending
					? {
							heading: "Human action required",
							draft: "pending-first-step",
						}
					: { heading: "Human handoff content", draft: null },
			);
			observed.push({ scenario, ...proof });
			if (pending)
				return answer(
					"Complete the controlled human step in the same retained page, then reply in this chat.",
				);
			output = "";
			return tool("exec_command", {
				cmd: "playwright-cli -s=weft-personal tab-close && playwright-cli -s=weft-personal detach",
				timeout_ms: 30000,
			});
		}
		return answer("Human handoff content confirmed from the actual page.");
	};
	const server = createTestServer(
		fixture,
		join(directory, "db.sqlite"),
		"handoff-fixture-key",
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
		const r = await fetch(base + path, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		assert(r.ok, await r.clone().text());
		return r.json();
	};
	const ask = async (chat: number, next: string, prompt: string) => {
		scenario = next;
		const { agentId } = await request(`/api/chats/${chat}`, { prompt });
		for (let n = 0; n < 1800; n++) {
			const state = await request(`/api/agents/${agentId}`);
			if (!state.busy) {
				assert.equal(
					state.agents[0].status,
					"succeeded",
					JSON.stringify(state),
				);
				const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
				assert(
					tools.some(
						(t: { name: string; arguments: string; result: string }) =>
							t.name === "exec_command" &&
							t.arguments.includes("run-code") &&
							JSON.parse(t.result).exitCode === 0,
					),
				);
				return;
			}
			await setTimeout(100);
		}
		assert.fail("Handoff Root did not finish");
	};
	const waitForHumanAction = async () => {
		console.log(
			`HANDOFF HUMAN ACTION REQUESTED: Complete only the controlled human step at ${url}; its unfinished field must still be populated.`,
		);
		for (let n = 0; n < 1200; n++) {
			if (completions === 1) return;
			await setTimeout(100);
		}
		assert.fail("Controlled human step was not completed");
	};
	try {
		await request("/api/execution-limits", { modelCallLimit: 200 }, "PATCH");
		const project = await request("/api/projects", {
			name: "Handoff",
			folders: [directory],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: "Handoff",
		});
		await ask(
			chat.id,
			"first",
			"Read the controlled page; request human action if needed.",
		);
		assert.equal(completions, 0);
		await ask(
			chat.id,
			"not-done",
			"Continue, but I have not completed the human step yet.",
		);
		assert.equal(completions, 0);
		await waitForHumanAction();
		assert.match(
			await (await globalThis.fetch(url)).text(),
			/<h1>Human action required<\/h1>/,
			"a fresh browser without the fixture Cookie must remain incomplete",
		);
		if (process.env.WEFT_TEST_EXTENSION_REOPEN_PROFILE === "1") {
			assert.equal(channel, "chrome");
			assert(
				process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME,
				"Reopen acceptance requires an explicitly selected disposable Chrome profile",
			);
			console.log(
				`HANDOFF PROFILE REOPEN: Close only the disposable Chrome profile window and verify its closure, then POST ${url}profile-closed. The next Root must reopen the same profile through upstream attach; select only ${url}.`,
			);
			for (let n = 0; n < 1200 && !profileClosed; n++) await setTimeout(100);
			assert(
				profileClosed,
				"Disposable profile window closure was not observed",
			);
		}
		await ask(chat.id, "continued", "Human step completed, continue.");
		assert.equal(completions, 1);
		assert.deepEqual(
			observed.map((x) => x.scenario),
			["first", "not-done", "continued"],
		);
		assert.deepEqual(
			(await request(`/api/chats/${chat.id}`)).browserTarget,
			target,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
