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

test("ordinary chat resumes real extension login and unfinished page after Root cleanup", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 600000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-handoff-")),
	);
	let authenticated = false;
	let logins = 0;
	const loginCookie = `weft_handoff_${randomUUID()}=active`;
	const site = createServer((req, res) => {
		if (req.url === "/login" && req.method === "POST") {
			authenticated = true;
			logins++;
			res.writeHead(303, {
				location: "/",
				"set-cookie": `${loginCookie}; HttpOnly; SameSite=Strict`,
			});
			res.end();
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end(
			authenticated && req.headers.cookie?.includes(loginCookie)
				? "<title>Weft login handoff acceptance</title><h1>Protected handoff content</h1>"
				: '<title>Weft login handoff acceptance</title><h1>Test login required</h1><form method="post" action="/login"><label>Unfinished step<input name="draft"></label><button>Complete controlled login</button></form>',
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const siteAddress = site.address();
	assert(siteAddress && typeof siteAddress !== "string");
	const url = `http://127.0.0.1:${siteAddress.port}/`;
	console.log(
		`HANDOFF ACCEPTANCE: Open ${url} in ${channel}. Approve only that tab on every connection. Do NOT submit login until HANDOFF LOGIN REQUESTED.`,
	);
	let scenario = "first";
	let phase = 0;
	let output = "";
	let target: unknown;
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
			output = "";
			const prepare =
				scenario === "first"
					? 'await page.getByLabel("Unfinished step").fill("pending-first-step");'
					: scenario === "expired"
						? 'await page.reload(); await page.getByLabel("Unfinished step").fill("pending-expired-step");'
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
			const pending = ["first", "not-done", "expired"].includes(scenario);
			assert.deepEqual(
				proof,
				pending
					? {
							heading: "Test login required",
							draft:
								scenario === "expired"
									? "pending-expired-step"
									: "pending-first-step",
						}
					: { heading: "Protected handoff content", draft: null },
			);
			observed.push({ scenario, ...proof });
			if (scenario !== "relogged")
				return answer(
					pending
						? "Complete the controlled login in the same retained page, then reply in this chat."
						: "Protected handoff content confirmed from the actual page.",
				);
			output = "";
			return tool("exec_command", {
				cmd: "playwright-cli -s=weft-personal tab-close && playwright-cli -s=weft-personal detach",
				timeout_ms: 30000,
			});
		}
		return answer("Protected handoff content confirmed from the actual page.");
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
	const waitForLogin = async (count: number) => {
		console.log(
			`HANDOFF LOGIN REQUESTED ${count}: Submit only the controlled login at ${url}; its unfinished field must still be populated.`,
		);
		for (let n = 0; n < 1200; n++) {
			if (logins === count) return;
			await setTimeout(100);
		}
		assert.fail("Controlled login was not completed");
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
			"Read the protected controlled page; request login if needed.",
		);
		assert.equal(logins, 0);
		await ask(
			chat.id,
			"not-done",
			"Continue, but I have not completed the login yet.",
		);
		assert.equal(logins, 0);
		await waitForLogin(1);
		await ask(chat.id, "continued", "Login completed, continue.");
		authenticated = false;
		await ask(
			chat.id,
			"expired",
			"Read the protected page again after the controlled session expires.",
		);
		await waitForLogin(2);
		await ask(
			chat.id,
			"relogged",
			"Finished the controlled login again, continue.",
		);
		assert.deepEqual(
			observed.map((x) => x.scenario),
			["first", "not-done", "continued", "expired", "relogged"],
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
