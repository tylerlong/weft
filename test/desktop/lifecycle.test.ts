import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { configureDatabase } from "../config-fixture.ts";
import { completedBody } from "../model-fixture.ts";

const supported = process.platform === "darwin" && process.arch === "arm64";
async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 150; i++) {
		if (await check()) return;
		await delay(100);
	}
	assert.fail("Desktop condition did not become true");
}
async function exists(path: string) {
	return readFile(path).then(
		() => true,
		() => false,
	);
}
function live(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Packaged lifecycle/UI and the existing HTTP/model seam exercise real execution and cleanup.
test("desktop Quit preserves cancelled work/queues and awaits confirmed cleanup", {
	skip: !supported,
	timeout: 180000,
}, async () => {
	execFileSync("pnpm", ["desktop:build"], { stdio: "inherit" });
	const sandbox = await mkdtemp(join(tmpdir(), "weft desktop lifecycle "));
	const bundle = join(sandbox, "Lifecycle Weft.app");
	const root = join(bundle, "Contents/Resources/app");
	const choice = join(sandbox, "choice"),
		prompt = join(sandbox, "prompt"),
		failure = join(sandbox, "failure");
	const ready = join(sandbox, "native-ready"),
		browserPids = join(sandbox, "browser-pids"),
		delayed = join(sandbox, "delayed-effect");
	let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
	let calls = 0;
	let command = `node -e 'const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));console.log("command-ready");setTimeout(()=>fs.writeFileSync(${JSON.stringify(delayed)},"unexpected"),5000);setInterval(()=>{},1000)'`;
	const model = createServer(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += chunk;
		if (request.url === "/page") {
			response.end("<title>Lifecycle browser fixture</title>");
			return;
		}
		const body = JSON.parse(text);
		if (request.url === "/review") {
			response.end(
				JSON.stringify({
					id: "review",
					model: "fixture",
					answers: { safety: { type: "choice", choice: "allow" } },
				}),
			);
			return;
		}
		calls++;
		response.setHeader("content-type", "text/event-stream");
		response.end(
			completedBody({
				output: body.input.some(
					(item: { type: string }) => item.type === "function_call_output",
				)
					? [
							{
								type: "message",
								content: [{ type: "output_text", text: "done" }],
							},
						]
					: [
							{
								type: "function_call",
								name: "exec_command",
								call_id: `held-${calls}`,
								arguments: JSON.stringify({
									cmd: command,
									login: false,
									timeout_ms: 30000,
								}),
							},
						],
			}),
		);
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => model.once("listening", resolve));
	const address = model.address();
	assert(address && typeof address !== "string");
	try {
		await cp(resolve("desktop-output/Weft.app"), bundle, {
			recursive: true,
			verbatimSymlinks: true,
		});
		await rename(
			join(root, "desktop/main.cjs"),
			join(root, "desktop/application.cjs"),
		);
		await writeFile(
			join(root, "desktop/main.cjs"),
			`const {app,dialog}=require('electron');const fs=require('node:fs');app.setPath('appData',${JSON.stringify(sandbox)});dialog.showMessageBox=async options=>{fs.writeFileSync(${JSON.stringify(prompt)},JSON.stringify(options));return {response:Number(fs.readFileSync(${JSON.stringify(choice)},'utf8'))}};dialog.showErrorBox=(title,message)=>fs.writeFileSync(${JSON.stringify(failure)},JSON.stringify({title,message}));require('./application.cjs');`,
		);
		await rename(
			join(root, "desktop/backend.ts"),
			join(root, "desktop/application-backend.ts"),
		);
		await writeFile(
			join(root, "desktop/backend.ts"),
			`import {writeFileSync} from 'node:fs';import {startBackend} from './application-backend.ts';process.once('message',async m=>{await startBackend(m.databasePath,(url,init)=>fetch('http://127.0.0.1:${address.port}/'+(String(url).includes('/decisions')?'review':'model'),init),async()=>Response.json({data:[]}),${JSON.stringify(join(sandbox, "empty-home"))});writeFileSync(${JSON.stringify(join(sandbox, "backend-pid"))},String(process.pid));});`,
		);
		await mkdir(join(sandbox, "Weft"), { mode: 0o700 });
		configureDatabase(join(sandbox, "Weft/weft.sqlite"));
		const launch = async () => {
			const app = await electron.launch({
				executablePath: join(bundle, "Contents/MacOS/Weft"),
				args: [],
				cwd: sandbox,
				env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
			});
			application = app;
			const page = await app.firstWindow();
			await page.waitForFunction(() =>
				Boolean(sessionStorage.getItem("weft-management-token")),
			);
			const origin = new URL(page.url()).origin;
			const token = await page.evaluate(() =>
				sessionStorage.getItem("weft-management-token"),
			);
			assert(token);
			const api = async (path: string, body?: unknown) => {
				const response = await fetch(origin + path, {
					method: body === undefined ? "GET" : "POST",
					headers: { "x-weft-management-token": token, origin },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				assert(response.ok, await response.clone().text());
				return response.json();
			};
			return { app, page, api, origin };
		};
		let first = await launch();
		let backendPid = Number(
			await readFile(join(sandbox, "backend-pid"), "utf8"),
		);
		const project = await first.api("/api/projects", {
			name: "Lifecycle",
			folders: [sandbox],
		});
		const chat = await first.api(`/api/projects/${project.id}/chats`, {
			name: "Held work",
		});
		const route = `/api/chats/${chat.id}`;
		const start = async () => {
			await rm(ready, { force: true });
			const { agentId } = await first.api(route, { prompt: "hold" });
			await until(() => exists(ready));
			const pid = Number(await readFile(ready, "utf8"));
			assert(live(pid));
			assert.equal((await first.api(`/api/agents/${agentId}`)).busy, true);
			return { agentId, pid };
		};
		const held = await start();
		await first.app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows().forEach((window: { close(): void }) => {
				window.close();
			}),
		);
		assert(live(backendPid));
		assert(live(held.pid));
		execFileSync(join(bundle, "Contents/MacOS/Weft"), [], {
			cwd: sandbox,
			stdio: "ignore",
		});
		await first.app.evaluate(({ app }) => app.emit("activate"));
		await (await first.app.firstWindow()).waitForFunction(() =>
			Boolean(sessionStorage.getItem("weft-management-token")),
		);
		assert.equal((await first.api(`/api/agents/${held.agentId}`)).busy, true);
		const cancelQuit = async () => {
			await rm(prompt, { force: true });
			await writeFile(choice, "0");
			await first.app.evaluate(({ app }) => app.quit());
			await until(() => exists(prompt));
			await delay(100);
			const options = JSON.parse(await readFile(prompt, "utf8"));
			assert.match(options.detail, /Active Agents will stop/);
			assert.match(options.detail, /queued input is not retained/);
			assert.deepEqual(options.buttons, ["Cancel", "Quit Weft"]);
		};
		await cancelQuit();
		assert(live(held.pid));
		assert(live(backendPid));
		assert.equal((await first.api(`/api/agents/${held.agentId}`)).busy, true);
		await first.api(route, { prompt: "queued-only", intent: "queue" });
		await first.api(`/api/agents/${held.agentId}/cancel`, {});
		await until(
			async () => !(await first.api(`/api/agents/${held.agentId}`)).busy,
		);
		assert.equal(live(held.pid), false);
		const queued = await first.api(route);
		assert.equal(queued.queue.length, 1);
		await cancelQuit();
		assert.deepEqual((await first.api(route)).queue, queued.queue);
		assert.equal((await first.api(route)).busy, false);
		// An idle queue also needs confirmation, then disappears without being replayed.
		await writeFile(choice, "1");
		const queuedExit = new Promise((resolve) =>
			first.app.process().once("exit", resolve),
		);
		await first.app.evaluate(({ app }) => app.quit()).catch(() => {});
		assert.equal(await queuedExit, 0);
		application = undefined;
		assert.equal(live(backendPid), false);
		const queuedCalls = calls;
		first = await launch();
		backendPid = Number(await readFile(join(sandbox, "backend-pid"), "utf8"));
		assert.equal((await first.api(route)).queue.length, 0);
		assert.equal(calls, queuedCalls);
		command =
			`playwright-cli open http://127.0.0.1:${address.port}/page --browser=chrome && ` +
			command.replace(
				'console.log("command-ready");',
				`fs.writeFileSync(${JSON.stringify(browserPids)},JSON.stringify(require("node:child_process").execFileSync("/bin/ps",["-axo","pid=,command="],{encoding:"utf8"}).split("\\n").filter(line=>line.includes(process.env.TMPDIR)).map(line=>Number(line.trim().split(/\\s+/)[0])).filter(pid=>pid!==process.pid)));console.log("command-ready");`,
			);
		const active = await start();
		const ownedBrowserPids: number[] = JSON.parse(
			await readFile(browserPids, "utf8"),
		);
		assert(ownedBrowserPids.length > 0);
		for (const pid of ownedBrowserPids) assert(live(pid));
		await first.api(route, { prompt: "discard-on-exit", intent: "queue" });
		assert(live(active.pid));
		assert(live(backendPid));
		assert.equal((await first.api(route)).queue.length, 1);
		await writeFile(choice, "1");
		const exited = new Promise((resolve) =>
			first.app.process().once("exit", resolve),
		);
		await first.app.evaluate(({ app }) => app.quit()).catch(() => {});
		assert.equal(await exited, 0);
		application = undefined;
		assert.equal(live(active.pid), false);
		for (const pid of ownedBrowserPids) assert.equal(live(pid), false);
		assert.equal(live(backendPid), false);
		await assert.rejects(fetch(`${first.origin}/api/projects`));
		assert.equal(await exists(failure), false);
		const beforeRestart = calls;
		const second = await launch();
		assert.equal((await second.api(route)).queue.length, 0);
		assert.equal((await second.api(route)).busy, false);
		const tools = (await second.api(`/api/agents/${active.agentId}/tools`))
			.toolCalls;
		assert.equal(tools[0].status, "interrupted");
		assert.match(
			tools[0].output.map((chunk: { text: string }) => chunk.text).join(""),
			/command-ready/,
		);
		assert.equal(
			(await second.api(`/api/agents/${active.agentId}`)).agents[0].status,
			"failed",
		);
		await delay(5500);
		assert.equal(await exists(delayed), false);
		assert.equal(calls, beforeRestart);
		await second.app.close();
		application = undefined;
	} finally {
		if (application) {
			await writeFile(choice, "1");
			await application.close();
		}
		model.closeAllConnections();
		await new Promise<void>((resolve) => model.close(() => resolve()));
		await rm(sandbox, { recursive: true, force: true });
	}
});
