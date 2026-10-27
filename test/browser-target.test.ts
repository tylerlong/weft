import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

test("failed personal connection records actual target without binding the Chat", {
	skip: process.platform !== "darwin",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "browser-target-"));
	let calls = 0;
	let connectedTarget: unknown;
	let output = "";
	const server = createTestServer(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++calls === 1) {
				assert(
					body.tools.some(
						(tool: { name: string }) => tool.name === "browser_connect",
					),
				);
				return completedResponse({
					output: [
						{
							type: "function_call",
							id: "connect",
							call_id: "connect",
							name: "browser_connect",
							arguments: JSON.stringify({
								channel: "chrome",
								user_data_dir: directory,
								profile: "Default",
							}),
						},
					],
				});
			}
			const result = JSON.parse(body.input.at(-1).output);
			connectedTarget ??= result.browserTarget;
			output +=
				result.output?.chunks
					.map((chunk: { text: string }) => chunk.text)
					.join("") ?? "";
			if (result.running)
				return completedResponse({
					output: [
						{
							type: "function_call",
							id: "poll",
							call_id: `poll-${calls}`,
							name: "write_stdin",
							arguments: JSON.stringify({
								session_id: result.session_id,
								yield_time_ms: 1000,
							}),
						},
					],
				});
			assert.equal(result.exitCode, 1);
			assert.deepEqual(connectedTarget, {
				channel: "chrome",
				userDataDir: directory,
				profile: "Default",
			});
			assert.match(output, /Playwright Extension not found/);
			assert.match(body.instructions, /Chat personal browser target: null/);
			return completedResponse({
				output: [
					{
						type: "message",
						id: "answer",
						content: [
							{ type: "output_text", text: "Missing profile confirmed" },
						],
					},
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (path: string, body?: unknown) => {
		const response = await fetch(base + path, {
			method: body ? "POST" : "GET",
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		assert(response.ok, await response.clone().text());
		return response.json();
	};
	try {
		const project = await request("/api/projects", {
			name: "P",
			folders: [directory],
		});
		const chat = await request(`/api/projects/${project.id}/chats`, {
			name: "C",
		});
		const { agentId } = await request(`/api/chats/${chat.id}`, {
			prompt: "Connect only the controlled missing profile.",
		});
		const agent = await waitForAgent(base, agentId);

		assert.equal(agent.status, "succeeded");
		assert.equal((await request(`/api/chats/${chat.id}`)).browserTarget, null);
		assert(calls >= 2);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("upstream recent-profile discovery changes only an unbound target", async () => {
	const { personalBrowserCommand } = await import("../src/browser-tools.ts");
	const { mkdir, writeFile } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "target-discovery-"));
	try {
		for (const profile of ["Default", "Profile 2"])
			await mkdir(
				join(root, profile, "Extensions", "mmlmfjhmonkocbjadbfplnigmagldckm"),
				{ recursive: true },
			);
		await writeFile(
			join(root, "Local State"),
			JSON.stringify({ profile: { last_used: "Profile 2" } }),
		);
		const initial = await personalBrowserCommand(
			{ channel: "chrome", user_data_dir: root },
			null,
			root,
		);
		assert.equal(initial.target.profile, "Profile 2");
		await writeFile(
			join(root, "Local State"),
			JSON.stringify({ profile: { last_used: "Default" } }),
		);
		assert.equal(
			(
				await personalBrowserCommand(
					{ channel: "chrome", user_data_dir: root },
					null,
					root,
				)
			).target.profile,
			"Default",
		);
		const retained = await personalBrowserCommand({}, initial.target, root);
		assert.deepEqual(retained.target, initial.target);
		await assert.rejects(
			personalBrowserCommand({ profile: "Default" }, initial.target, root),
			/change_target/,
		);
		assert.equal(
			(
				await personalBrowserCommand(
					{ profile: "Default", change_target: true },
					initial.target,
					root,
				)
			).target.profile,
			"Default",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("custom executable cannot be mislabeled as a tracked channel target", async () => {
	const { personalBrowserCommand } = await import("../src/browser-tools.ts");
	const original = process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
	process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = "/not-the-channel-browser";
	try {
		await assert.rejects(
			personalBrowserCommand({ channel: "chrome" }, null, tmpdir()),
			/standard channel installation/,
		);
	} finally {
		if (original === undefined)
			delete process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
		else process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = original;
	}
});
