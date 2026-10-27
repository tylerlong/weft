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
const otherChannel = channel === "chrome" ? "msedge" : "chrome";
const message = () =>
	completedResponse({
		output: [
			{
				id: "answer",
				type: "message",
				content: [
					{ type: "output_text", text: "Browser target check complete" },
				],
			},
		],
	});
const tool = (name: string, args: unknown) =>
	completedResponse({
		output: [
			{
				type: "function_call",
				id: "tool",
				call_id: `tool-${Date.now()}`,
				name,
				arguments: JSON.stringify(args),
			},
		],
	});

test("real extension target survives Roots, Sub-agents and restart without affecting temporary browsing", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 600000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-target-extension-")),
	);
	const site = createServer((_req, res) => {
		res.setHeader("content-type", "text/html");
		res.end(
			"<title>Weft Chat target acceptance</title><h1>Chat target proof</h1>",
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const address = site.address();
	assert(address && typeof address !== "string");
	const siteUrl = `http://127.0.0.1:${address.port}/`;
	console.log(
		`TARGET ACCEPTANCE: Open ${siteUrl} in ${channel} and ${otherChannel}. Select only that controlled page for each browser_connect approval.`,
	);
	type Target = { channel: string; userDataDir: string; profile: string };
	let selected: Target | null = null;
	let activePrompt = "";
	let childStarted!: () => void;
	const childStarting = new Promise<void>(
		(resolve) => (childStarted = resolve),
	);
	const runs = new Map<
		string,
		{ phase: number; accumulated: string; target?: Target }
	>();
	const connected: string[] = [];
	const fixture: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const user = body.input
			.filter((i: { role: string }) => i.role === "user")
			.at(-1)?.content;
		const stepPrompt =
			user === "child-target-check"
				? "child"
				: user === "race-child-target-check"
					? "race-child"
					: activePrompt;
		const run = runs.get(stepPrompt) ?? {
			phase: 0,
			accumulated: "",
			target: undefined,
		};
		runs.set(stepPrompt, run);
		const last = body.input
			.filter((i: { type: string }) => i.type === "function_call_output")
			.at(-1);
		const result = last ? JSON.parse(last.output) : undefined;
		run.accumulated +=
			result?.output?.chunks.map((c: { text: string }) => c.text).join("") ??
			"";
		if (result?.browserTarget) run.target = result.browserTarget;
		if (result?.error && stepPrompt !== "reject-change")
			assert.fail(JSON.stringify(result));
		const current = JSON.parse(
			body.instructions.match(
				/Chat personal browser target: (.+?)\. Use browser_connect/,
			)?.[1] ?? "null",
		);
		if (!result) {
			run.phase = 0;
			run.accumulated = "";
			if (stepPrompt === "new-chat") assert.equal(current, null);
			else if (stepPrompt === "first" || stepPrompt === "temporary-before")
				assert.equal(current, null);
			else assert.deepEqual(current, selected);
			if (stepPrompt === "race")
				return tool("create_sub_agent", { prompt: "race-child-target-check" });
			if (stepPrompt === "delegate")
				return tool("create_sub_agent", { prompt: "child-target-check" });
			if (stepPrompt.startsWith("temporary"))
				return tool("exec_command", {
					cmd: "playwright-cli -s=temporary open about:blank && playwright-cli -s=temporary close",
					workdir: directory,
					timeout_ms: 30000,
				});
			if (stepPrompt === "reject-change")
				return tool("browser_connect", { channel: otherChannel });
			return tool(
				"browser_connect",
				stepPrompt === "first" || stepPrompt === "new-chat"
					? { channel }
					: stepPrompt === "change"
						? { channel: otherChannel, change_target: true }
						: {},
			);
		}
		if (result.running) {
			if (stepPrompt === "race-child") childStarted();
			return tool("write_stdin", {
				session_id: result.session_id,
				yield_time_ms: 1000,
			});
		}
		if (stepPrompt === "race" && result.agent_id) {
			await childStarting;
			return tool("browser_connect", { channel, change_target: true });
		}
		if (stepPrompt === "delegate" && result.agent_id) return message();
		if (stepPrompt === "reject-change") {
			assert.match(result.error, /change_target/);
			return message();
		}
		if (stepPrompt.startsWith("temporary")) {
			assert.equal(result.exitCode, 0, run.accumulated);
			assert.deepEqual(current, selected);
			return message();
		}
		assert.equal(result.exitCode, 0, run.accumulated);
		if (run.phase++ === 0) {
			assert.match(run.accumulated, /attached to/);
			if (
				stepPrompt === "first" ||
				stepPrompt === "change" ||
				stepPrompt === "race"
			)
				selected = current;
			assert(current);
			assert.equal(
				current.channel,
				stepPrompt === "change"
					? otherChannel
					: stepPrompt === "new-chat"
						? channel
						: selected?.channel,
			);
			if (stepPrompt === "race-child")
				assert.equal(run.target?.channel, otherChannel);
			console.log(
				`TARGET CONNECTED ${stepPrompt}: actual=${run.target?.channel}, Chat=${current.channel}`,
			);
			connected.push(stepPrompt);
			run.accumulated = "";
			return tool("exec_command", {
				cmd: `playwright-cli -s=weft-personal run-code 'async page => {if(page.url()!=="${siteUrl}") throw new Error("Select only the localhost acceptance page"); return {url:page.url(),proof:await page.getByRole("heading",{name:"Chat target proof",exact:true}).textContent()};}'`,
				timeout_ms: 30000,
			});
		}
		if (run.phase === 2) {
			assert.deepEqual(
				JSON.parse(
					run.accumulated.match(/### Result\r?\n(\{[^\n]+\})/)?.[1] ?? "null",
				),
				{ url: siteUrl, proof: "Chat target proof" },
			);
			run.accumulated = "";
			return tool("exec_command", {
				cmd: "playwright-cli -s=weft-personal detach",
				timeout_ms: 30000,
			});
		}
		return message();
	};
	let server = createTestServer(
		fixture,
		join(directory, "db.sqlite"),
		"target-acceptance-key",
	).listen(0, "127.0.0.1");
	let base = "";
	const ready = async () => {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const a = server.address();
		assert(a && typeof a !== "string");
		base = `http://127.0.0.1:${a.port}`;
	};
	await ready();
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
	const ask = async (chatId: number, prompt: string) => {
		activePrompt = prompt;
		runs.delete(prompt);
		const { agentId } = await request(`/api/chats/${chatId}`, { prompt });
		for (let n = 0; n < 2400; n++) {
			const state = await request(`/api/agents/${agentId}`);
			if (!state.busy) {
				assert.equal(
					state.agents[0].status,
					"succeeded",
					JSON.stringify(state),
				);
				return agentId;
			}
			await setTimeout(100);
		}
		assert.fail("Acceptance Agent did not complete");
	};
	try {
		await request("/api/execution-limits", { modelCallLimit: 100 }, "PATCH");
		const p = await request("/api/projects", {
			name: "P",
			folders: [directory],
		});
		const c = await request(`/api/projects/${p.id}/chats`, { name: "C" });
		await ask(c.id, "temporary-before");
		await ask(c.id, "first");
		assert(selected);
		assert.deepEqual(
			(await request(`/api/chats/${c.id}`)).browserTarget,
			selected,
		);
		await ask(c.id, "temporary-after");
		const oldProfile = process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
		process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME =
			"Weft nonexistent recent profile";
		try {
			await ask(c.id, "followup");
		} finally {
			if (oldProfile === undefined)
				delete process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
			else process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = oldProfile;
		}
		await ask(c.id, "delegate");
		const tree = (await request(`/api/chats/${c.id}`)).agents;
		const delegate = tree.find(
			(a: { question: string }) => a.question === "delegate",
		);
		assert(delegate);
		const children = (await request(`/api/agents/${delegate.id}/tree`)).agents;
		assert(
			children.some(
				(a: { parentAgentId: number; status: string }) =>
					a.parentAgentId === delegate.id && a.status === "succeeded",
			),
		);
		await ask(c.id, "reject-change");
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createTestServer(
			fixture,
			join(directory, "db.sqlite"),
			"target-acceptance-key",
		).listen(0, "127.0.0.1");
		await ready();
		await ask(c.id, "restart");
		await ask(c.id, "change");
		await ask(c.id, "race");
		const newChat = await request(`/api/projects/${p.id}/chats`, {
			name: "Independent",
		});
		await ask(newChat.id, "new-chat");
		assert.equal(
			(await request(`/api/chats/${c.id}`)).browserTarget.channel,
			channel,
		);
		assert.deepEqual(connected, [
			"first",
			"followup",
			"child",
			"restart",
			"change",
			"race",
			"race-child",
			"new-chat",
		]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
