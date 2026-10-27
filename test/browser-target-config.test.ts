import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

async function attempt(directory: string, args: unknown) {
	let result: Record<string, unknown> = {};
	let scratch = "";
	const server = createTestServer(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			scratch = JSON.parse(
				body.instructions.match(
					/Your private command scratch directory: ("[^\n]+?")\./,
				)?.[1] ?? '""',
			);
			const last = body.input
				.filter(
					(item: { type: string }) => item.type === "function_call_output",
				)
				.at(-1);
			if (last) result = JSON.parse(last.output);
			const name = last
				? result.running
					? "write_stdin"
					: undefined
				: "browser_connect";
			return completedResponse({
				output: name
					? [
							{
								type: "function_call",
								id: "tool",
								call_id: `tool-${body.input.length}`,
								name,
								arguments: JSON.stringify(
									name === "write_stdin"
										? { session_id: result.session_id, yield_time_ms: 1000 }
										: args,
								),
							},
						]
					: [
							{
								type: "message",
								id: "answer",
								content: [{ type: "output_text", text: "Connection checked" }],
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
		const r = await fetch(base + path, {
			method: body ? "POST" : "GET",
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		assert(r.ok, await r.clone().text());
		return r.json();
	};
	try {
		const p = await request("/api/projects", {
			name: "P",
			folders: [directory],
		});
		const c = await request(`/api/projects/${p.id}/chats`, { name: "C" });
		const { agentId } = await request(`/api/chats/${c.id}`, {
			prompt: "Connect only the designated controlled target.",
		});
		assert.equal((await waitForAgent(base, agentId)).status, "succeeded");
		const tools = (await request(`/api/agents/${agentId}/tools`)).toolCalls;
		const target = (await request(`/api/chats/${c.id}`)).browserTarget;
		return { result, tools, target, scratch };
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

for (const inherited of [
	"cdp-env",
	"cdp-global",
	"remote-global",
	"isolated-global",
	"executable-global",
]) {
	test(`tracked connection rejects incompatible ${inherited} before contacting another browser`, {
		skip: process.platform !== "darwin",
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "target-config-"));
		let requests = 0;
		const endpoint = createServer((_req, res) => {
			requests++;
			res.writeHead(404);
			res.end();
		}).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => endpoint.once("listening", resolve));
		const address = endpoint.address();
		assert(address && typeof address !== "string");
		const secret = "fixture-endpoint-must-not-appear";
		const url = `http://127.0.0.1:${address.port}/${secret}`;
		const original = {
			global: process.env.PWTEST_CLI_GLOBAL_CONFIG,
			cdp: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
			timeout: process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT,
		};
		process.env.PWTEST_CLI_GLOBAL_CONFIG = directory;
		let browser: unknown = {};
		if (inherited === "cdp-env") {
			process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = url;
			process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT = "1000";
		} else if (inherited === "cdp-global")
			browser = { cdpEndpoint: url, cdpTimeout: 1000 };
		else if (inherited === "remote-global") browser = { remoteEndpoint: url };
		else if (inherited === "isolated-global") browser = { isolated: true };
		else
			browser = {
				launchOptions: { executablePath: "/unavailable-custom-browser" },
			};
		await mkdir(join(directory, ".playwright"));
		await writeFile(
			join(directory, ".playwright/cli.config.json"),
			JSON.stringify({ browser }),
		);
		try {
			const check = await attempt(directory, {
				channel: "chrome",
				...(inherited === "isolated-global"
					? {}
					: { user_data_dir: join(directory, "selected") }),
				profile: "Default",
			});
			assert.equal(
				requests,
				0,
				"an incompatible endpoint must never be contacted",
			);
			assert.match(
				String(check.result.error),
				/incompatible inherited browser configuration/,
			);
			assert(
				!JSON.stringify(check).includes(secret),
				"configuration endpoint secrets must not enter tool results",
			);
			assert.equal(check.target, null);
		} finally {
			for (const [key, value] of [
				["PWTEST_CLI_GLOBAL_CONFIG", original.global],
				["PLAYWRIGHT_MCP_CDP_ENDPOINT", original.cdp],
				["PLAYWRIGHT_MCP_CDP_TIMEOUT", original.timeout],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			endpoint.closeAllConnections();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const source of ["environment", "global config", "relative environment"]) {
	test(`first tracked target honors the ${source} user-data root through the actual CLI`, {
		skip: process.platform !== "darwin",
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "target-default-"));
		const root =
			source === "relative environment"
				? "relative-upstream-root"
				: join(directory, "upstream-root");
		const original = {
			global: process.env.PWTEST_CLI_GLOBAL_CONFIG,
			root: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
		};
		process.env.PWTEST_CLI_GLOBAL_CONFIG = directory;
		delete process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
		await mkdir(join(directory, ".playwright"));
		if (source === "environment" || source === "relative environment")
			process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = root;
		else
			await writeFile(
				join(directory, ".playwright/cli.config.json"),
				JSON.stringify({ browser: { userDataDir: root } }),
			);
		try {
			const check = await attempt(directory, {
				channel: "chrome",
				profile: "Default",
			});
			const connection = JSON.parse(
				check.tools.find((t: { name: string }) => t.name === "browser_connect")
					.result,
			);
			assert.deepEqual(connection.browserTarget, {
				channel: "chrome",
				userDataDir:
					source === "relative environment" ? join(check.scratch, root) : root,
				profile: "Default",
			});
			const output = check.tools
				.map(
					(t: { result: string }) =>
						JSON.parse(t.result)
							.output?.chunks.map((c: { text: string }) => c.text)
							.join("") ?? "",
				)
				.join("");
			assert(
				output.includes(
					`"${join(source === "relative environment" ? join(check.scratch, root) : root, "Default")}"`,
				),
			);
			assert.equal(check.target, null);
		} finally {
			if (original.global === undefined)
				delete process.env.PWTEST_CLI_GLOBAL_CONFIG;
			else process.env.PWTEST_CLI_GLOBAL_CONFIG = original.global;
			if (original.root === undefined)
				delete process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
			else process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = original.root;
			await rm(directory, { recursive: true, force: true });
		}
	});
}

const channel = process.env.WEFT_TEST_EXTENSION_CHANNEL;
test("real extension connects through resolved and pinned tracked configuration", {
	skip: process.platform !== "darwin" || !channel,
	timeout: 180000,
}, async () => {
	assert(channel === "chrome" || channel === "msedge");
	const directory = await mkdtemp(join(tmpdir(), "target-pinned-live-"));
	const site = createServer((_req, res) => {
		res.setHeader("content-type", "text/html");
		res.end(
			"<title>Weft pinned config acceptance</title><h1>Pinned config proof</h1>",
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => site.once("listening", resolve));
	const address = site.address();
	assert(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	console.log(
		`PINNED CONFIG ACCEPTANCE: Open ${url} in ${channel}; select only that controlled page in the ordinary extension picker.`,
	);
	try {
		const check = await attempt(directory, { channel });
		assert.equal(check.result.exitCode, 0);
		assert.equal(check.target.channel, channel);
		const connection = check.tools.find(
			(t: { name: string }) => t.name === "browser_connect",
		);
		assert.deepEqual(connection.commandState.browserTarget, check.target);
		const output = check.tools
			.map(
				(t: { result: string }) =>
					JSON.parse(t.result)
						.output?.chunks.map((c: { text: string }) => c.text)
						.join("") ?? "",
			)
			.join("");
		assert(output.includes(url));
		const snapshot = output.match(
			/\[Snapshot\]\((\.playwright-cli\/page-[\dTZ.-]+\.yml)\)/,
		)?.[1];
		assert(snapshot, "the real CLI must retain its page snapshot");
		assert.match(
			await readFile(join(check.scratch, snapshot), "utf8"),
			/heading "Pinned config proof"/,
		);
	} finally {
		site.closeAllConnections();
		await new Promise<void>((resolve) => site.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("saved tracked identity remains authoritative when inherited config changes after resolution", {
	skip: process.platform !== "darwin",
}, async () => {
	const { personalBrowserCommand } = await import("../src/browser-tools.ts");
	const { CommandExecutor } = await import("../src/command-executor.ts");
	const directory = await mkdtemp(join(tmpdir(), "target-runtime-pin-"));
	let contacts = 0;
	const endpoint = createServer((_req, res) => {
		contacts++;
		res.writeHead(404);
		res.end();
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => endpoint.once("listening", resolve));
	const address = endpoint.address();
	assert(address && typeof address !== "string");
	const secret = "runtime-endpoint-must-not-appear";
	const url = `http://127.0.0.1:${address.port}/${secret}`;
	const keys = [
		"PWTEST_CLI_GLOBAL_CONFIG",
		"PLAYWRIGHT_MCP_USER_DATA_DIR",
		"PLAYWRIGHT_MCP_CDP_ENDPOINT",
		"PLAYWRIGHT_MCP_ISOLATED",
		"PLAYWRIGHT_MCP_EXECUTABLE_PATH",
	];
	const original = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) delete process.env[key];
	process.env.PWTEST_CLI_GLOBAL_CONFIG = directory;
	const executor = new CommandExecutor();
	try {
		const saved = {
			channel: "chrome",
			userDataDir: join(directory, "saved-root"),
			profile: "Default",
		};
		const prepared = await personalBrowserCommand({}, saved, directory);
		await mkdir(join(directory, ".playwright"));
		await writeFile(
			join(directory, ".playwright/cli.config.json"),
			JSON.stringify({
				browser: {
					remoteEndpoint: url,
					cdpEndpoint: url,
					isolated: true,
					launchOptions: { executablePath: "/different-browser" },
				},
			}),
		);
		process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = join(
			directory,
			"different-root",
		);
		process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = url;
		process.env.PLAYWRIGHT_MCP_ISOLATED = "true";
		process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = "/different-browser";
		let output = "";
		const result = await executor.execute({
			command: prepared.command,
			cwd: directory,
			agentId: `runtime-pin-${process.pid}`,
			timeoutMs: 10000,
			signal: new AbortController().signal,
			onOutput: (_stream, text) => (output += text),
		});
		assert.equal(result.exitCode, 1);
		assert(
			output.includes(`"${join(saved.userDataDir, "Default")}"`),
			"runtime must attempt exactly the saved profile",
		);
		assert.match(output, /Playwright Extension not found/);
		assert.equal(contacts, 0);
		assert(!output.includes(secret));
	} finally {
		await executor.close();
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
