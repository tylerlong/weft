import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserSkill } from "../src/browser-tools.ts";
import { CommandExecutor } from "../src/command-executor.ts";
import { discoverSkills } from "../src/skills.ts";
import {
	browserCrashCheck,
	isRelatedBrowserCrash,
	useTemporaryHome,
} from "./browser-crash-fixture.ts";

test("bundled official CLI and skill work outside the application repository", {
	skip: process.platform !== "darwin",
}, async (t) => {
	const target = await realpath(
		await mkdtemp(join(tmpdir(), "browser-tools-")),
	);
	await useTemporaryHome(t, target);
	const executor = new CommandExecutor();
	const options = {
		cwd: target,
		agentId: `browser-tools-${process.pid}`,
		signal: new AbortController().signal,
	};
	try {
		const discovery = await discoverSkills([target], target);
		assert(
			discovery.skills.some(
				(skill) =>
					skill.name === "playwright-cli" &&
					skill.implicit &&
					skill.source === join(browserSkill, "SKILL.md"),
			),
		);
		const content = await executor.readText({
			signal: options.signal,
			path: join(browserSkill, "SKILL.md"),
			start_line: 1,
			max_lines: 2000,
		});
		assert.match(JSON.stringify(content), /playwright-cli run-code/);
		let output = "";
		const result = await executor.execute({
			...options,
			command: "playwright-cli --version",
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0, output);
		assert.match(output, /1\.63\.0/);
	} finally {
		await executor.close();
		await rm(target, { recursive: true, force: true });
	}
});

test("native commands can read outside their cwd and launch, operate and close the browser", {
	skip: process.platform !== "darwin",
	timeout: 60000,
}, async (t) => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "browser-full-access-")),
	);
	await useTemporaryHome(t, directory);
	const crashes = await browserCrashCheck();
	const page = createServer((_request, response) =>
		response.end(
			"<title>Full Access</title><button onclick=\"this.textContent='Clicked'\">Click me</button>",
		),
	);
	page.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => page.once("listening", resolve));
	const address = page.address();
	assert(address && typeof address !== "string");
	const executor = new CommandExecutor();
	const options = {
		cwd: directory,
		agentId: `browser-full-access-${process.pid}`,
		signal: new AbortController().signal,
		timeoutMs: 15000,
	};
	const execute = async (command: string, agentId = options.agentId) => {
		let output = "";
		const result = await executor.execute({
			...options,
			agentId,
			command,
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0, output);
		return output;
	};
	try {
		const outside = join(directory, "outside.txt");
		await writeFile(outside, "outside-proof");
		assert.match(await execute(`cd /; cat '${outside}'`), /outside-proof/);
		await crashes.capture(
			await execute(
				`playwright-cli open http://127.0.0.1:${address.port} --browser=chromium --persistent --profile='${join(directory, "profile")}'`,
			),
		);
		assert.doesNotMatch(
			await execute("playwright-cli list", `${options.agentId}-other`),
			/status: open/,
		);
		assert.match(
			await execute(
				`playwright-cli run-code 'async page => { await page.getByRole("button", { name: "Click me" }).click(); await page.evaluate(() => localStorage.setItem("weft-profile", "persisted-proof")); return await page.getByRole("button").textContent(); }'`,
			),
			/Clicked/,
		);
		await execute("playwright-cli close");
		await crashes.capture(
			await execute(
				`playwright-cli open http://127.0.0.1:${address.port} --browser=chromium --persistent --profile='${join(directory, "profile")}'`,
			),
		);
		assert.match(
			await execute(
				`playwright-cli run-code 'async page => await page.evaluate(() => localStorage.getItem("weft-profile"))'`,
			),
			/persisted-proof/,
		);
		await execute("playwright-cli close");
		await crashes.assertNoCrashes();
	} finally {
		await executor.execute({
			...options,
			command: "playwright-cli close",
			onOutput: () => {},
		});
		await executor.close();
		page.closeAllConnections();
		await new Promise<void>((resolve) => page.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("browser crash reports must match this run's PID and capture time", () => {
	const report = (pid: number, captureTime: string) =>
		`${JSON.stringify({ app_name: "Chromium" })}\n${JSON.stringify({ pid, captureTime })}`;
	assert.equal(
		isRelatedBrowserCrash("unfinished unrelated report", new Set([123]), 0),
		false,
	);
	const start = Date.parse("2026-10-17T12:00:00Z");
	const pids = new Set([123]);
	assert.equal(
		isRelatedBrowserCrash(report(123, "2026-10-17T12:00:01Z"), pids, start),
		true,
	);
	assert.equal(
		isRelatedBrowserCrash(report(456, "2026-10-17T12:00:01Z"), pids, start),
		false,
	);
	assert.equal(
		isRelatedBrowserCrash(report(123, "2026-10-16T12:00:00Z"), pids, start),
		false,
	);
});

test("Agent cleanup stops only its CLI daemons while another Agent keeps using its browser", {
	skip: process.platform !== "darwin",
	timeout: 60000,
}, async (t) => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "browser-cleanup-")),
	);
	await useTemporaryHome(t, directory);
	const executor = new CommandExecutor();
	const first = `bc-a-${process.pid}`;
	const second = `bc-b-${process.pid}`;
	const run = async (agentId: string, command: string) => {
		let output = "";
		const result = await executor.execute({
			agentId,
			command,
			cwd: directory,
			signal: new AbortController().signal,
			timeoutMs: 15000,
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0, output);
		return output;
	};
	try {
		for (const id of [first, second])
			await run(id, "playwright-cli open about:blank --browser=chromium");
		await executor.closeAgent(first);
		assert.doesNotMatch(
			await run(first, "playwright-cli list --all"),
			/status: open/,
		);
		assert.match(
			await run(second, "playwright-cli list --all"),
			/status: open/,
		);
		assert.match(
			await run(second, 'playwright-cli run-code "async page => page.url()"'),
			/about:blank/,
		);
	} finally {
		for (const id of [first, second]) await run(id, "playwright-cli close-all");
		await executor.close();
		await rm(directory, { recursive: true, force: true });
	}
});
