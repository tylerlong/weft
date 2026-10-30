// Deliberate paid acceptance only; never imported by ordinary tests or CI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { openDatabase } from "../src/database.ts";
import { type McpService, parseMcpConfig } from "../src/mcp-config.ts";
import type { ModelSettings } from "../src/model-settings.ts";
import { createServer } from "../src/server.ts";

type Tool = { name: string; description?: string };
const script = fileURLToPath(import.meta.url);

function completed(
	text: string,
	observe: (response: Record<string, unknown>) => void = () => {},
) {
	if (!text.trimStart().startsWith("data:") && !text.includes("\ndata:")) {
		const result = JSON.parse(text);
		observe(result);
		return result;
	}
	let response: Record<string, unknown> | undefined;
	for (const frame of text.split(/\r?\n\r?\n/)) {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		const event = JSON.parse(data);
		if (event.type === "response.completed") {
			observe(event.response);
			assert.equal(
				response,
				undefined,
				"Acceptance rejects multiple completion events",
			);
			response = event.response;
		}
	}
	assert(response, "Acceptance requires a complete provider response");
	return response;
}

function checkCalls(
	response: { output?: { type: string; name?: string }[] },
	tools: Tool[],
	serviceName: string,
) {
	assert(
		Array.isArray(response.output),
		"Acceptance requires complete task-model output",
	);
	const allowed = new Set([
		"mcp_diagnostics",
		"mcp_startup",
		...tools
			.filter((tool) =>
				tool.description?.startsWith(`[MCP ${serviceName}: jira_search]`),
			)
			.map((tool) => tool.name),
	]);
	for (const item of response.output ?? [])
		if (item.type === "function_call" && !allowed.has(item.name ?? ""))
			throw new Error(
				"Acceptance aborted before dispatch: model requested a tool outside diagnostics/startup/jira_search",
			);
}

// This wrapper changes only the isolated service's first launch, not Docker or Jira.
async function service(file: string) {
	if (!existsSync(`${file}.attempted`)) {
		writeFileSync(`${file}.attempted`, "controlled initial MCP failure", {
			mode: 0o600,
		});
		process.stderr.write(
			"Controlled acceptance-only initial MCP failure; explicit startup can retry.\n",
		);
		process.exitCode = 1;
		return;
	}
	const config = JSON.parse(readFileSync(file, "utf8"));
	const child = spawn(config.command, config.args, {
		stdio: "inherit",
		env: process.env,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	process.on("SIGTERM", () => {
		child.kill("SIGTERM");
		timer ??= setTimeout(() => child.kill("SIGKILL"), 250);
	});
	child.on("error", () => {
		process.exitCode = 1;
	});
	const [code] = await once(child, "close").catch(() => [1]);
	clearTimeout(timer);
	process.exitCode = code ?? 1;
}

function cliSignal() {
	const controller = new AbortController();
	const stop = () => controller.abort(new Error("Acceptance interrupted"));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return {
		signal: controller.signal,
		dispose: () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		},
	};
}

async function selfCheck() {
	const interruption = cliSignal();
	try {
		process.emit("SIGTERM");
		assert(interruption.signal.aborted);
	} finally {
		interruption.dispose();
	}
	const tools = [
		{ name: "mcp_tool_7", description: "[MCP Jira: jira_search] Search" },
	];
	const response = { output: [{ type: "function_call", name: "mcp_tool_7" }] };
	checkCalls(
		completed(
			`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n`,
		),
		tools,
		"Jira",
	);
	checkCalls(
		{ output: [{ type: "function_call", name: "mcp_startup" }] },
		tools,
		"Jira",
	);
	assert.throws(() =>
		checkCalls(
			{ output: [{ type: "function_call", name: "exec_command" }] },
			tools,
			"Jira",
		),
	);
	assert.throws(() =>
		checkCalls(
			{ output: [{ type: "function_call", name: "jira_update_issue" }] },
			tools,
			"Jira",
		),
	);
	assert.throws(() => completed('data: {"type":"response.created"}\n'));
	assert.throws(() =>
		completed(
			`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "function_call", name: "jira_update_issue" }] } })}\n\n`,
		),
	);
	const paidUsage: unknown[] = [];
	assert.throws(() =>
		checkCalls(
			completed(
				JSON.stringify({
					output: [{ type: "function_call", name: "jira_update_issue" }],
					usage: { cost: 0.01 },
				}),
				(value) => paidUsage.push(value.usage),
			),
			tools,
			"Jira",
		),
	);
	assert.deepEqual(paidUsage, [{ cost: 0.01 }]);
	const directory = await mkdtemp(join(tmpdir(), "weft-accept-check-"));
	try {
		const file = join(directory, "service.json");
		writeFileSync(
			file,
			JSON.stringify({
				command: process.execPath,
				args: ["-e", "console.log('second launch')"],
			}),
			{ mode: 0o600 },
		);
		assert.throws(() =>
			execFileSync(process.execPath, [script, "--service", file], {
				stdio: "pipe",
			}),
		);
		assert.equal(
			execFileSync(process.execPath, [script, "--service", file], {
				encoding: "utf8",
			}).trim(),
			"second launch",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	console.log(
		"Acceptance self-check passed; no network, paid model, or Docker access.",
	);
}

async function accept(interruption: AbortSignal) {
	assert.equal(
		process.env.WEFT_ACCEPT_PAID,
		"1",
		"Set WEFT_ACCEPT_PAID=1 to deliberately invoke paid acceptance",
	);
	const source = new URL(process.env.WEFT_ACCEPT_SOURCE ?? "");
	assert(
		["127.0.0.1", "localhost", "[::1]"].includes(source.hostname) &&
			source.protocol === "http:",
		"Source must be the existing loopback Weft server",
	);
	const sourceToken = process.env.WEFT_ACCEPT_TOKEN;
	assert(
		sourceToken,
		"Supply the existing session's management token locally; never commit it",
	);
	const get = async (route: string) => {
		const response = await fetch(new URL(route, source), {
			headers: { "x-weft-management-token": sourceToken },
			signal: AbortSignal.any([interruption, AbortSignal.timeout(10000)]),
		});
		assert(response.ok, `Source GET ${route} failed: ${response.status}`);
		return response.json();
	};
	const [settings, credential, mcp, safety] = await Promise.all([
		get("/api/model-settings") as Promise<ModelSettings>,
		get("/api/settings/credential"),
		get("/api/mcp-settings"),
		get("/api/safety-review"),
	]);
	const model = settings.models.find(
		(item) => item.id === settings.defaultModelId,
	);
	assert(
		model && credential.apiKey,
		"Configure a default model and OpenRouter key in the source Settings first",
	);
	const candidates: McpService[] = mcp.services.filter(
		(item: McpService) =>
			item.enabled && item.config.includes("ghcr.io/sooperset/mcp-atlassian"),
	);
	const selected = process.env.WEFT_ACCEPT_SERVICE_ID
		? candidates.find((item) => item.id === process.env.WEFT_ACCEPT_SERVICE_ID)
		: candidates.length === 1
			? candidates[0]
			: undefined;
	assert(
		selected,
		"Select exactly one enabled configured Jira Docker service via WEFT_ACCEPT_SERVICE_ID",
	);
	const config = parseMcpConfig(selected.config, selected.env);
	assert(
		"command" in config,
		"Acceptance currently supports the configured Jira Docker stdio integration",
	);
	assert.equal(config.command.split("/").at(-1), "docker");
	const runIndex = config.args.indexOf("run");
	assert(runIndex >= 0, "Expected configured Docker run command");
	// Readiness only: wrapper launch bypasses automatic preparation, so it cannot start Colima.
	execFileSync(
		config.command,
		[
			...config.args.slice(0, runIndex),
			"info",
			"--format",
			"{{json .ServerVersion}}",
		],
		{
			env: {
				...getDefaultEnvironment(),
				...Object.fromEntries(
					selected.env.map(({ name, value }) => [name, value]),
				),
			},
			timeout: 10000,
			killSignal: "SIGKILL",
			stdio: "pipe",
		},
	);
	const directory = await mkdtemp(join(tmpdir(), "weft-accept-mcp-"));
	let ownedServer: ReturnType<typeof createServer> | undefined;
	const usage: unknown[] = [];
	let modelCalls = 0;
	let outcome = "failed";
	let sequence: { name: string; status: string }[] = [];
	let readSequence:
		| (() => Promise<{ name: string; status: string }[]>)
		| undefined;
	const deadline = AbortSignal.any([interruption, AbortSignal.timeout(240000)]);
	try {
		const databasePath = join(directory, "acceptance.sqlite");
		const file = join(directory, "service.json");
		writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
		const database = openDatabase(databasePath, false);
		database
			.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)")
			.run(model.id, model.name, JSON.stringify(model));
		database
			.prepare(
				"UPDATE settings SET api_key=?,default_model_id=?,provider_routing=?,safety_review=?,model_call_limit=16 WHERE id=1",
			)
			.run(
				credential.apiKey,
				model.id,
				settings.providerRouting,
				Number(safety.safetyReview),
			);
		database.close();
		const server = createServer(
			async (url, init) => {
				assert(modelCalls < 16, "Acceptance Model Call bound exceeded");
				modelCalls++;
				const request = JSON.parse(String(init?.body));
				const response = await fetch(url, {
					...init,
					signal: AbortSignal.any([
						deadline,
						...(init?.signal ? [init.signal] : []),
					]),
				});
				const text = await response.text();
				if (response.ok) {
					const result = completed(text, (value) =>
						usage.push({ model: value.model, usage: value.usage }),
					);
					if (request.tools) checkCalls(result, request.tools, selected.name);
				}
				return new Response(text, {
					status: response.status,
					headers: response.headers,
				});
			},
			databasePath,
			(url, init) => fetch(url, { ...init, signal: deadline }),
			undefined,
			undefined,
			join(directory, "no-user-config"),
		);
		ownedServer = server;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert(address && typeof address !== "string");
		const send = async (
			route: string,
			body?: unknown,
			method = body ? "POST" : "GET",
		) => {
			const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
				method,
				headers: { "x-weft-management-token": server.managementToken },
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: deadline,
			});
			assert(response.ok, `Isolated ${route} failed: ${response.status}`);
			return response.json();
		};
		await send(
			"/api/mcp-settings",
			{
				services: [
					{
						...selected,
						config: JSON.stringify({
							command: process.execPath,
							args: [script, "--service", file],
							startup_timeout_sec: config.startup_timeout_sec,
						}),
					},
				],
			},
			"PUT",
		);
		await send("/api/model-catalog");
		const project = await send("/api/projects", {
			name: "Deliberate MCP acceptance",
			folders: [],
		});
		const chat = await send(`/api/projects/${project.id}/chats`, {
			name: "Read-only Jira recovery",
		});
		const accepted = await send(`/api/chats/${chat.id}`, {
			prompt:
				"Perform this bounded read-only acceptance exercise. First call mcp_diagnostics to inspect this Agent's MCP runtime. The configured Jira service initially failed in an isolated controlled launch wrapper; use mcp_startup with its stable service_id to recover in this SAME Agent. Then explicitly call the discovered jira_search to list up to 5 tickets assigned to currentUser() updated in the past 24 hours, returning keys and summaries. Do not call any other tools, create sub-agents, access files/databases, modify Settings, run commands, write to Jira, or start/restart infrastructure. Stop and accurately report any unresolved failure; do not invent success. This is an explicitly requested diagnostics/startup/search sequence for acceptance, not an autonomous discovery test.",
		});
		readSequence = async () => {
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/agents/${accepted.agentId}/tools`,
				{
					headers: { "x-weft-management-token": server.managementToken },
					signal: AbortSignal.timeout(1000),
				},
			);
			assert(response.ok);
			return (await response.json()).toolCalls.map(
				(item: { name: string; status: string }) => ({
					name: item.name,
					status: item.status,
				}),
			);
		};
		let state = await send(`/api/agents/${accepted.agentId}`);
		while (state.agentBusy || state.busy) {
			await delay(100, undefined, { signal: deadline });
			state = await send(`/api/agents/${accepted.agentId}`);
		}
		const { toolCalls } = await send(`/api/agents/${accepted.agentId}/tools`);
		sequence = toolCalls.map((item: { name: string; status: string }) => ({
			name: item.name,
			status: item.status,
		}));

		assert.equal(state.agents[0].status, "succeeded", "Agent did not complete");
		assert.equal(sequence[0]?.name, "mcp_diagnostics");
		assert(
			JSON.stringify(toolCalls[0].result).includes(
				"Controlled acceptance-only initial MCP failure",
			),
			"Diagnostics did not expose the controlled initial failure",
		);
		assert(
			sequence.some(
				(item: { name: string; status: string }) =>
					item.name === "mcp_startup" && item.status === "succeeded",
			),
			"No successful startup observed",
		);
		assert(
			sequence.some(
				(item: { name: string; status: string }) =>
					/^mcp_tool_/.test(item.name) && item.status === "succeeded",
			),
			"No successful Jira search observed",
		);
		outcome = "succeeded";
	} finally {
		if (readSequence) sequence = await readSequence().catch(() => sequence);
		console.log(
			JSON.stringify(
				{
					model: model.id,
					safetyReview: safety.safetyReview,
					modelCalls,
					usage,
					outcome,
					sequence,
					sequenceSnapshotBeforeCleanup: true,
					controlledFailure: true,
					realPrerequisiteRecovery: false,
				},
				null,
				2,
			),
		);
		if (ownedServer) {
			const server = ownedServer;
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--service") await service(process.argv[3]);
else if (process.argv[2] === "--check") await selfCheck();
else {
	const interruption = cliSignal();
	try {
		await accept(interruption.signal);
	} catch {
		console.error(
			"MCP acceptance failed. No credentials or Jira content are printed. Inspect the controlled invocation and source availability; no success is claimed.",
		);
		process.exitCode = 1;
	} finally {
		interruption.dispose();
	}
}
