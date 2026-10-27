import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

for (const cancel of [false, true])
	test(`failed owned browser cleanup is recorded and shutdown releases database ownership (cancel: ${cancel})`, {
		skip: process.platform !== "darwin",
		timeout: 30000,
	}, async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "browser-cleanup-error-")),
		);
		let scratch = "";
		let calls = 0;
		const secret = "cleanup-fixture-secret";
		const server = createTestServer(
			async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				if (++calls === 1)
					return completedResponse({
						output: [
							{
								type: "function_call",
								id: "tool",
								call_id: "tool",
								name: "exec_command",
								arguments: JSON.stringify({
									cmd:
										'mkdir -p "$TMPDIR/playwright-daemon"; ln -s "$TMPDIR/nonexistent-cleanup-fixture" "$TMPDIR/playwright-daemon/broken-cleanup-fixture-secret"; printf "SCRATCH:%s\n" "$TMPDIR"' +
										(cancel ? "; sleep 30" : ""),
									timeout_ms: 15000,
								}),
							},
						],
					});
				const result = JSON.parse(body.input.at(-1).output);
				assert.equal(result.exitCode, 0);
				scratch = result.output.chunks
					.map((c: { text: string }) => c.text)
					.join("")
					.slice("SCRATCH:".length)
					.trim();
				return completedResponse({
					output: [
						{
							type: "message",
							id: "answer",
							content: [
								{
									type: "output_text",
									text: "Work finished; cleanup must report its real failure",
								},
							],
						},
					],
				});
			},
			join(directory, "db.sqlite"),
			secret,
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const request = async (path: string, body: unknown) => {
			const response = await fetch(base + path, {
				method: "POST",
				body: JSON.stringify(body),
			});
			assert(response.ok, await response.clone().text());
			return response.json();
		};
		let closed = false;
		try {
			const p = await request("/api/projects", {
				name: "P",
				folders: [directory],
			});
			const c = await request(`/api/projects/${p.id}/chats`, { name: "C" });
			const { agentId } = await request(`/api/chats/${c.id}`, {
				prompt: "Create only the disposable cleanup failure fixture",
			});
			if (cancel) {
				for (let n = 0; n < 500; n++) {
					const tools = await (
						await fetch(`${base}/api/agents/${agentId}/tools`)
					).json();
					if (tools.toolCalls[0]) {
						const detail = await (
							await fetch(
								`${base}/api/agents/${agentId}/tools?toolId=${tools.toolCalls[0].id}`,
							)
						).json();
						const text = detail.toolCalls[0].output
							.map((c: { text: string }) => c.text)
							.join("");
						if (text.startsWith("SCRATCH:")) {
							scratch = text.slice(8).trim();
							break;
						}
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert(scratch);
				const stopped = await fetch(`${base}/api/agents/${agentId}/cancel`, {
					method: "POST",
					body: "{}",
				});
				assert.equal(stopped.status, 500);
				assert.equal((await stopped.json()).code, "agentCancelFailed");
			}
			const agent = await waitForAgent(base, agentId);
			assert.equal(agent.status, cancel ? "cancelled" : "failed");
			assert.equal(
				agent.errorCode,
				cancel ? "agentCancelled" : "toolCleanupFailed",
			);
			const tools = await (
				await fetch(`${base}/api/agents/${agentId}/tools`)
			).json();
			assert.match(tools.toolCalls[0].commandState.cleanupError, /ENOENT/);
			assert.doesNotMatch(
				tools.toolCalls[0].commandState.cleanupError,
				new RegExp(secret),
			);
			assert.match(
				tools.toolCalls[0].commandState.cleanupError,
				/\[REDACTED\]/,
			);
			server.closeAllConnections();
			const error = await new Promise<Error | undefined>((resolve) =>
				server.close(resolve),
			);
			closed = true;
			assert(error, "Server.close must not report successful cleanup");
			assert.match(error.message, /Tool cleanup failed/);
			const reopened = createTestServer(
				async () => {
					throw new Error("No task may run during reopen");
				},
				join(directory, "db.sqlite"),
			).listen(0, "127.0.0.1");
			await new Promise<void>((resolve) => reopened.once("listening", resolve));
			await new Promise<void>((resolve, reject) =>
				reopened.close((error) => (error ? reject(error) : resolve())),
			);
		} finally {
			if (scratch)
				await rm(
					join(scratch, "playwright-daemon", "broken-cleanup-fixture-secret"),
					{ force: true },
				);
			if (!closed) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
