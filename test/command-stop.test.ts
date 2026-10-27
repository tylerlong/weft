import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandExecutor } from "../src/command-executor.ts";

for (const ignoresInterrupt of [false, true])
	test(`trusted browser startup cancellation allows cleanup and retains forced fallback (ignores interrupt: ${ignoresInterrupt})`, {
		skip: process.platform !== "darwin",
		timeout: 10000,
	}, async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "startup-stop-")),
		);
		const executor = new CommandExecutor();
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		try {
			await writeFile(
				join(directory, "signal.cjs"),
				`
const {writeFileSync}=require('node:fs');
process.on('SIGINT',()=>{${ignoresInterrupt ? "" : "writeFileSync('cleaned','signal-handler-finished');process.exit(0);"}});
console.log('ready-for-stop');
setTimeout(()=>writeFileSync('escaped','too-late'),5000);
setInterval(()=>{},1000);
`,
			);
			const command = executor.execute({
				command: `exec node signal.cjs`,
				cwd: directory,
				agentId: `stop-${process.pid}`,
				interruptBeforeTerminate: true,
				timeoutMs: 15000,
				signal: controller.signal,
				onOutput: (_stream, text) => {
					if (text.includes("ready-for-stop")) started();
				},
			});
			await ready;
			const before = Date.now();
			controller.abort();
			const result = await command;
			assert.equal(result.cancelled, true);
			assert(
				Date.now() - before < 5000,
				"Interrupt grace must retain bounded forced termination",
			);
			if (ignoresInterrupt)
				await assert.rejects(readFile(join(directory, "cleaned")), {
					code: "ENOENT",
				});
			else
				assert.equal(
					await readFile(join(directory, "cleaned"), "utf8"),
					"signal-handler-finished",
				);
			await assert.rejects(readFile(join(directory, "escaped")), {
				code: "ENOENT",
			});
		} finally {
			controller.abort();
			await executor.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

test("Agent cleanup marks a cooperative zero-exit startup interrupted", {
	skip: process.platform !== "darwin",
	timeout: 10000,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "startup-finish-")),
	);
	const executor = new CommandExecutor();
	let state:
		| { exitCode: number | null; cancelled?: boolean; running?: boolean }
		| undefined;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	try {
		await writeFile(
			join(directory, "startup.cjs"),
			'process.on("SIGINT",()=>process.exit(0));console.log("pending");setInterval(()=>{},1000);',
		);
		const result = await executor.execute({
			command: "exec node startup.cjs",
			cwd: directory,
			agentId: `finish-${process.pid}`,
			interruptBeforeTerminate: true,
			yieldTimeMs: 250,
			signal: new AbortController().signal,
			onOutput: (_stream, text) => {
				if (text.includes("pending")) started();
			},
			onState: (result) => {
				state = result;
			},
		});
		assert.equal(result.running, true);
		await ready;
		await executor.closeAgent(`finish-${process.pid}`);
		assert.equal(state?.exitCode, 0);
		assert.equal(
			state?.cancelled,
			true,
			"A cleanup interrupt must not look like a successful browser attach",
		);
	} finally {
		await executor.close();
		await rm(directory, { recursive: true, force: true });
	}
});
