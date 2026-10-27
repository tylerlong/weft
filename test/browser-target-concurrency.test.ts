import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandExecutor } from "../src/command-executor.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const tool = (name: string, args: unknown) =>
	completedResponse({
		output: [
			{
				type: "function_call",
				id: "tool",
				call_id: "tool",
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
				content: [{ type: "output_text", text: "Selection checked" }],
			},
		],
	});
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

for (const scenario of [
	{
		name: "X to Y to X selections retain latest X",
		choices: [
			{ profile: "Y", explicit: true },
			{ profile: "X", explicit: true },
		],
		expected: "X",
		otherChat: false,
	},
	{
		name: "an explicit same-target X selection retains X",
		choices: [{ profile: "X", explicit: true }],
		expected: "X",
		otherChat: false,
	},
	{
		name: "an ordinary same-target reconnect does not invalidate pending Z",
		choices: [{ profile: "X", explicit: false }],
		expected: "Z",
		otherChat: false,
	},
	{
		name: "another Chat selection does not invalidate pending Z",
		choices: [],
		expected: "Z",
		otherChat: true,
	},
])
	test(scenario.name, {
		timeout: 30000,
	}, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "browser-selection-aba-"));
		const keys = [
			"PWTEST_CLI_GLOBAL_CONFIG",
			"PLAYWRIGHT_MCP_USER_DATA_DIR",
			"PLAYWRIGHT_MCP_CDP_ENDPOINT",
			"PLAYWRIGHT_MCP_ISOLATED",
			"PLAYWRIGHT_MCP_EXECUTABLE_PATH",
			"PLAYWRIGHT_MCP_CONFIG",
		];
		const original = keys.map((key) => [key, process.env[key]] as const);
		for (const key of keys) delete process.env[key];
		process.env.PWTEST_CLI_GLOBAL_CONFIG = directory;
		const delayedStarted = gate(),
			finishDelayed = gate();
		let executions = 0,
			choiceIndex = 0,
			childId = 0,
			otherChatId = 0;
		// Only the external connection is controlled; all Chat selection and Tool Call state uses the HTTP application.
		t.mock.method(
			CommandExecutor.prototype,
			"execute",
			async (options: Parameters<CommandExecutor["execute"]>[0]) => {
				if (++executions === 2) {
					delayedStarted.release();
					await finishDelayed.promise;
				}
				const result = { exitCode: 0, running: false };
				options.onState?.(result);
				return result;
			},
		);
		const target = (profile: string) => ({
			channel: "chrome",
			userDataDir: directory,
			profile,
		});
		const connect = (profile: string, change_target = false) =>
			tool("browser_connect", {
				channel: "chrome",
				user_data_dir: directory,
				profile,
				change_target,
			});
		const server = createTestServer(
			async (_url, init): Promise<Response> => {
				const body = JSON.parse(String(init?.body));
				const prompt = body.input
					.filter(
						(item: { role: string; content: unknown }) =>
							item.role === "user" &&
							[
								"Initialize X",
								"Initialize Y",
								"Delayed Z",
								"Concurrent selection changes",
							].includes(String(item.content)),
					)
					.at(-1)?.content;
				const resultText = body.input
					.filter(
						(item: { type: string }) => item.type === "function_call_output",
					)
					.at(-1)?.output;
				const result = resultText ? JSON.parse(resultText) : undefined;
				if (prompt === "Initialize X") return result ? answer() : connect("X");
				if (prompt === "Initialize Y") return result ? answer() : connect("Y");
				if (prompt === "Delayed Z")
					return result ? answer() : connect("Z", true);
				assert.equal(prompt, "Concurrent selection changes");
				if (!result) return tool("create_sub_agent", { prompt: "Delayed Z" });
				if (result.agent_id) {
					childId = result.agent_id;
					await delayedStarted.promise;
				} else
					assert.deepEqual(
						result.browserTarget,
						target(scenario.choices[choiceIndex - 1]?.profile),
					);
				if (choiceIndex < scenario.choices.length) {
					const choice = scenario.choices[choiceIndex++];
					return connect(choice.profile, choice.explicit);
				}
				if (scenario.otherChat && !otherChatId) {
					const other = await request(`/api/projects/${projectId}/chats`, {
						name: "Independent",
					});
					otherChatId = other.id;
					const { agentId } = await request(`/api/chats/${other.id}`, {
						prompt: "Initialize Y",
					});
					assert.equal((await waitForAgent(base, agentId)).status, "succeeded");
				}
				finishDelayed.release();
				return answer();
			},
			join(directory, "db.sqlite"),
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		let projectId = 0;
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
			projectId = project.id;
			const chat = await request(`/api/projects/${project.id}/chats`, {
				name: "C",
			});
			for (const prompt of ["Initialize X", "Concurrent selection changes"]) {
				const { agentId } = await request(`/api/chats/${chat.id}`, { prompt });
				const completed = await waitForAgent(base, agentId);
				assert.equal(completed.status, "succeeded");
			}
			assert.equal(
				executions,
				2 + scenario.choices.length + (scenario.otherChat ? 1 : 0),
			);
			assert.deepEqual(
				(await request(`/api/chats/${chat.id}`)).browserTarget,
				target(scenario.expected),
			);
			const delayed = (
				await request(`/api/agents/${childId}/tools`)
			).toolCalls.find(
				(call: { name: string }) => call.name === "browser_connect",
			);
			assert.deepEqual(delayed.commandState.browserTarget, target("Z"));
			assert.deepEqual(
				delayed.commandState.chatBrowserTarget,
				target(scenario.expected),
			);
			if (otherChatId)
				assert.deepEqual(
					(await request(`/api/chats/${otherChatId}`)).browserTarget,
					target("Y"),
				);
		} finally {
			delayedStarted.release();
			finishDelayed.release();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const [key, value] of original) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
