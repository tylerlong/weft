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
const tool = (name: string, args: unknown) =>
	completedResponse({
		output: [
			{
				type: "function_call",
				id: "tool",
				call_id: `isolation-${Date.now()}`,
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
				content: [{ type: "output_text", text: "Isolation proof complete" }],
			},
		],
	});

// Opt-in real extension: select only this test's named localhost tabs in the approval UI.
test("real extension isolates concurrent Sub-agents and another Chat through popup, tab ownership and Stop", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 600000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-isolation-")),
	);
	const actors = ["child-a", "child-b", "other-chat"];
	const gates = new Map<string, () => void>();
	const wait = (name: string) =>
		new Promise<void>((resolve) => gates.set(name, resolve));
	const attached = new Set<string>();
	const popupDone = new Map<string, () => void>();
	const popupWait = new Map(
		actors.map((name) => [
			name,
			new Promise<void>((resolve) => popupDone.set(name, resolve)),
		]),
	);
	const attachFinished = new Map<string, () => void>();
	const attachWait = new Map(
		actors.map((name) => [
			name,
			new Promise<void>((resolve) => attachFinished.set(name, resolve)),
		]),
	);
	let stopReady = false;
	let allAttached!: () => void;
	const ready = new Promise<void>((resolve) => {
		allAttached = resolve;
	});
	let stopped!: () => void;
	const afterStop = new Promise<void>((resolve) => {
		stopped = resolve;
	});
	const site = createServer((req, res) => {
		res.setHeader("content-type", "text/html");
		const name = req.url?.slice(1) ?? "";
		if (req.method === "POST" && name.startsWith("advance/")) {
			gates.get(name.slice(8))?.();
			res.end("Advanced");
			return;
		}
		res.end(
			`<title>Weft isolation ${name}</title><h1>${name}</h1><input aria-label="Own value" value="original"><a target="_blank" href="/${name}-popup">Own popup</a><button onclick="fetch('/advance/moved-out',{method:'POST'})">Moved out</button><button onclick="fetch('/advance/moved-in',{method:'POST'})">Moved in</button>`,
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const address = site.address();
	assert(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	console.log(
		`ISOLATION ACCEPTANCE: Open ${actors.map((name) => `${origin}/${name}`).join(" ")} and ${origin}/unrelated in ${channel}. Select only the actor named in the next ATTACH line.`,
	);
	const phases = new Map<string, { phase: number; output: string }>();
	const fixture: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const prompt = body.input
			.filter((i: { role: string }) => i.role === "user")
			.at(-1)?.content;
		const actor = actors.find((name) => prompt === name) ?? "supervisor";
		const state = phases.get(actor) ?? { phase: 0, output: "" };
		phases.set(actor, state);
		const last = body.input
			.filter((i: { type: string }) => i.type === "function_call_output")
			.at(-1);
		const result = last ? JSON.parse(last.output) : undefined;
		if (actor === "supervisor") {
			if (state.phase++ < 2)
				return tool("create_sub_agent", { prompt: actors[state.phase - 1] });
			return answer();
		}
		state.output +=
			result?.output?.chunks.map((c: { text: string }) => c.text).join("") ??
			"";
		if (result?.error) assert.fail(JSON.stringify(result));
		if (!result) {
			const previous = actors[actors.indexOf(actor) - 1];
			if (previous) await attachWait.get(previous);
			console.log(`ISOLATION ATTACH ${actor}`);
			return tool("browser_connect", { channel });
		}
		if (result.running) {
			if (actor === "child-a" && state.phase === 6) stopReady = true;
			return tool("write_stdin", {
				session_id: result.session_id,
				yield_time_ms: 1000,
			});
		}
		assert.equal(result.exitCode, 0, state.output);
		const cli = "playwright-cli -s=weft-personal";
		const command = (cmd: string) => {
			state.output = "";
			return tool("exec_command", {
				cmd,
				timeout_ms: 30000,
				max_output_tokens: 4000,
			});
		};
		const run = (code: string) => command(`${cli} run-code '${code}'`);
		const proof = () =>
			JSON.parse(
				state.output.match(/### Result\r?\n(\{[^\n]+\})/)?.[1] ?? "null",
			);
		const expectedUrls = [actor, `${actor}-new`, `${actor}-popup`]
			.map((p) => `${origin}/${p}`)
			.sort();
		console.log(`ISOLATION STEP ${actor} ${state.phase}`);
		if (state.phase++ === 0) {
			assert.match(state.output, /attached to/);
			attached.add(actor);
			attachFinished.get(actor)?.();
			if (attached.size === actors.length) allAttached();
			await ready;
			return run(
				`async page => { if(page.url()!=="${origin}/${actor}") throw new Error("Select only this actor localhost tab"); await page.getByLabel("Own value").fill("${actor}"); return {urls:page.context().pages().map(p=>p.url()),value:await page.getByLabel("Own value").inputValue()}; }`,
			);
		}
		if (state.phase === 2) {
			assert.deepEqual(proof(), { urls: [`${origin}/${actor}`], value: actor });
			return command(`${cli} tab-new ${origin}/${actor}-new`);
		}
		if (state.phase === 3) {
			const previous = actors[actors.indexOf(actor) - 1];
			if (previous) await popupWait.get(previous);
			assert.match(
				state.output,
				new RegExp(`Page URL: ${origin}/${actor}-new`),
			);
			return run(
				`async page => {const own=page.context().pages().find(p=>p.url()==="${origin}/${actor}"); if(!own) throw new Error("Original page missing"); await own.bringToFront(); const pending=page.context().waitForEvent("page",{timeout:5000}); await own.getByText("Own popup",{exact:true}).click({timeout:5000}); const popup=await pending; await popup.waitForLoadState("domcontentloaded",{timeout:5000}); return {urls:page.context().pages().map(p=>p.url()).sort(),value:await own.getByLabel("Own value").inputValue()};}`,
			);
		}
		if (state.phase === 4) {
			assert.deepEqual(proof(), { urls: expectedUrls, value: actor });
			popupDone.get(actor)?.();
			if (actor === "child-a") {
				const moved = wait("moved-out");
				console.log(
					`ISOLATION MOVE OUT: Move only ${origin}/child-a out of its Playwright tab group, then click Moved out in that tab.`,
				);
				await moved;
				return run(
					`async page => ({urls:page.context().pages().map(p=>p.url()).sort()})`,
				);
			}
			console.log(`ISOLATION HOLD ${actor}`);
			await afterStop;
			return run(
				`async page => {const own=page.context().pages().find(p=>p.url()==="${origin}/${actor}"); if(!own) throw new Error("Wrong actor page"); return {urls:page.context().pages().map(p=>p.url()).sort(),value:await own.getByLabel("Own value").inputValue()};}`,
			);
		}
		if (actor === "child-a" && state.phase === 5) {
			assert.deepEqual(proof(), {
				urls: expectedUrls.filter((url) => url !== `${origin}/child-a`),
			});
			const moved = wait("moved-in");
			console.log(
				`ISOLATION MOVE IN: Move only ${origin}/child-a back to its original Playwright tab group, then click Moved in in that tab.`,
			);
			await moved;
			return run(
				`async page => {const own=page.context().pages().find(p=>p.url()==="${origin}/child-a"); if(!own) throw new Error("Moved tab not reacquired"); return {value:await own.getByLabel("Own value").inputValue(),urls:page.context().pages().map(p=>p.url()).sort()};}`,
			);
		}
		if (actor === "child-a" && state.phase === 6) {
			assert.deepEqual(proof(), { value: actor, urls: expectedUrls });
			console.log("ISOLATION STOP READY child-a");
			return tool("exec_command", { cmd: "sleep 300", yield_time_ms: 1000 });
		}
		assert(actor !== "child-a");
		if (state.phase === 5) {
			assert.deepEqual(proof(), { urls: expectedUrls, value: actor });
			return run(
				`async page => {for(const p of page.context().pages()){if(p.url()!=="${origin}/${actor}"){if(!p.url().startsWith("${origin}/${actor}-")) throw new Error("Foreign page"); await p.close();}} return {urls:page.context().pages().map(p=>p.url())};}`,
			);
		}
		if (state.phase === 6) {
			assert.deepEqual(proof(), { urls: [`${origin}/${actor}`] });
			if (actor === "other-chat") return command(`${cli} detach`);
			return answer();
		}
		assert.equal(actor, "other-chat");
		if (state.phase === 7) {
			state.output = "";
			console.log("ISOLATION RECONNECT other-chat");
			return tool("browser_connect", {});
		}
		if (state.phase === 8) {
			assert.match(state.output, /attached to/);
			return run(
				`async page => {if(page.url()!=="${origin}/${actor}") throw new Error("Reselect only this Chat page"); return {urls:page.context().pages().map(p=>p.url()),value:await page.getByLabel("Own value").inputValue()};}`,
			);
		}
		assert.deepEqual(proof(), { urls: [`${origin}/${actor}`], value: actor });
		return answer();
	};
	const server = createTestServer(fixture, join(directory, "db.sqlite")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const a = server.address();
	assert(a && typeof a !== "string");
	const base = `http://127.0.0.1:${a.port}`;
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
		await request("/api/execution-limits", { modelCallLimit: 600 }, "PATCH");
		const project = await request("/api/projects", {
			name: "Isolation acceptance",
			folders: [directory],
		});
		const first = await request(`/api/projects/${project.id}/chats`, {
			name: "Sub-agents",
		});
		const second = await request(`/api/projects/${project.id}/chats`, {
			name: "Other Chat",
		});
		const root = await request(`/api/chats/${first.id}`, {
			prompt: "supervisor",
		});
		const other = await request(`/api/chats/${second.id}`, {
			prompt: "other-chat",
		});
		let childA: number | undefined;
		for (let n = 0; n < 4500; n++) {
			const state = await request(`/api/agents/${root.agentId}/tree`);
			const independent = await request(`/api/agents/${other.agentId}`);
			assert.notEqual(
				independent.agents[0].status,
				"failed",
				JSON.stringify(independent),
			);
			const failed = state.agents.find(
				(agent: { status: string }) => agent.status === "failed",
			);
			assert(!failed, JSON.stringify(failed));
			childA = state.agents.find(
				(agent: { question: string }) => agent.question === "child-a",
			)?.id;
			if (stopReady && childA) break;
			await setTimeout(100);
		}
		assert(childA, "Sub-agent did not reach Stop check");
		assert.equal(phases.get("child-a")?.phase, 6);
		await request(`/api/agents/${childA}/cancel`, {});
		stopped();
		for (const id of [root.agentId, other.agentId]) {
			let final = await request(`/api/agents/${id}`);
			for (let n = 0; n < 600; n++) {
				final = await request(`/api/agents/${id}`);
				if (!final.busy) break;
				await setTimeout(100);
			}
			assert.equal(final.agents[0].status, "succeeded", JSON.stringify(final));
		}
		const tree = await request(`/api/agents/${root.agentId}/tree`);
		assert.equal(
			tree.agents.find((agent: { id: number }) => agent.id === childA).status,
			"cancelled",
		);
		assert.equal(phases.get("child-b")?.phase, 6);
		assert.equal(phases.get("other-chat")?.phase, 9);
	} finally {
		allAttached();
		for (const finish of attachFinished.values()) finish();
		for (const finish of popupDone.values()) finish();
		stopped();
		for (const release of gates.values()) release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
