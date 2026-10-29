import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { configureDatabase } from "../config-fixture.ts";
import { completedBody } from "../model-fixture.ts";

const supported = process.platform === "darwin" && process.arch === "arm64";
// The developer commands and real packaged UI/HTTP interface are the acceptance seams.
test("build, relocate, use, safely refuse rebuild, and reopen a standalone app", {
	skip: !supported,
	timeout: 180000,
}, async (context) => {
	const sandbox = await mkdtemp(join(tmpdir(), "weft desktop acceptance "));
	const checkout = join(sandbox, "checkout");
	await mkdir(checkout);
	for (const name of [
		".gitignore",
		"src",
		"desktop",
		"package.json",
		"pnpm-lock.yaml",
		"vite.config.ts",
		"index.html",
	])
		await cp(resolve(name), join(checkout, name), { recursive: true });
	await mkdir(join(checkout, "docs"));
	await cp(
		resolve("docs/browser-tools.md"),
		join(checkout, "docs/browser-tools.md"),
	);
	for (const directory of ["data", "test", ".git", ".cache"])
		await mkdir(join(checkout, directory));
	await writeFile(join(checkout, ".env"), "fixture-secret-do-not-package");
	await writeFile(join(checkout, "data/weft.sqlite"), "fixture-private-data");
	await writeFile(join(checkout, "docs/private-fixture.md"), "fixture-private");
	execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
		cwd: checkout,
		stdio: "inherit",
	});
	execFileSync("pnpm", ["desktop:build"], { cwd: checkout, stdio: "inherit" });
	const original = join(checkout, "desktop-output/Weft.app");
	const relocated = join(sandbox, "Relocated Weft.app");
	let finderRunning = false;
	let preserveFixture = false;
	const quitFinder = async (bundle = relocated, pidPath?: string) => {
		try {
			const pid = pidPath ? Number(await readFile(pidPath, "utf8")) : undefined;
			const running = () => {
				if (pid !== undefined) {
					assert(Number.isSafeInteger(pid) && pid > 0);
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				}
				return (
					execFileSync(
						"/usr/bin/osascript",
						[
							"-l",
							"JavaScript",
							"-e",
							"ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('local.weft.desktop').count",
						],
						{ encoding: "utf8" },
					).trim() !== "0"
				);
			};
			if (running())
				execFileSync("/usr/bin/osascript", [
					"-e",
					`tell application ${JSON.stringify(bundle)} to quit`,
				]);
			for (let i = 0; i < 100; i++) {
				if (!running()) {
					finderRunning = false;
					return;
				}
				await delay(100);
			}
			throw new Error("Fixture app did not finish quitting");
		} catch (error) {
			preserveFixture = true;
			throw new Error(`Fixture resources preserved at ${sandbox}`, {
				cause: error,
			});
		}
	};
	let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
	const closeApplication = async () => {
		if (!application) return;
		// Failure cleanup must also confirm Quit if a fixture Agent is still active.
		await application
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({
					response: 1,
					checkboxChecked: false,
				});
			})
			.catch(() => {});
		await application.close();
		application = undefined;
	};
	let modelCalls = 0;
	let command =
		'node --version && rg --version && git --version && pnpm --version && node -e \'console.log(process.execPath); console.log(process.env.WEFT_MANAGEMENT_TOKEN === undefined ? "authority-absent" : "authority-leaked")\'';
	await writeFile(
		join(sandbox, "package.json"),
		JSON.stringify({ packageManager: "pnpm@11.28.8" }),
	);
	const model = httpServer(async (request, response) => {
		if (request.url === "/page") {
			response.setHeader("content-type", "text/html");
			response.end(
				`<title>Desktop browser fixture</title><input aria-label="Message"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>`,
			);
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}
		let text = "";
		for await (const chunk of request) text += chunk;
		const body = JSON.parse(text);
		if (request.url === "/review") {
			response.end(
				JSON.stringify({
					id: "fixture-review",
					model: "fixture",
					answers: { safety: { type: "choice", choice: "allow" } },
				}),
			);
			return;
		}
		modelCalls++;
		const output =
			body.input.at(-1)?.type === "function_call_output"
				? [
						{
							type: "message",
							content: [{ type: "output_text", text: "Fixture complete" }],
						},
					]
				: [
						{
							type: "function_call",
							call_id: `fixture-${modelCalls}`,
							name: "exec_command",
							arguments: JSON.stringify({
								cmd: command,
								workdir: sandbox,
								login: false,
								timeout_ms: 30000,
							}),
						},
					];
		response.setHeader("content-type", "text/event-stream");
		response.end(completedBody({ output }));
	}).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => model.once("listening", resolve));
	const address = model.address();
	assert(address && typeof address !== "string");
	try {
		await cp(original, relocated, {
			recursive: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
		});
		const root = join(relocated, "Contents/Resources/app");
		assert.deepEqual((await readdir(root)).sort(), [
			"desktop",
			"dist",
			"docs",
			"node_modules",
			"package.json",
			"runtime",
			"src",
		]);
		assert.deepEqual(await readdir(join(root, "docs")), ["browser-tools.md"]);
		// Fixture wiring is confined to this disposable app. Production has no mock mode.
		await rename(
			join(root, "desktop/main.cjs"),
			join(root, "desktop/application.cjs"),
		);
		await writeFile(
			join(root, "desktop/main.cjs"),
			`const {app}=require('electron'); app.setPath('appData', ${JSON.stringify(sandbox)}); require('./application.cjs');`,
		);
		await rename(
			join(root, "desktop/backend.ts"),
			join(root, "desktop/application-backend.ts"),
		);
		await writeFile(
			join(root, "desktop/backend.ts"),
			`import {startBackend} from './application-backend.ts'; for(const key of Object.keys(process.env)) if(key.startsWith('PLAYWRIGHT_MCP_')) delete process.env[key]; process.env.PWTEST_CLI_GLOBAL_CONFIG=${JSON.stringify(join(sandbox, "empty-home"))}; process.once('message', async (m) => { await startBackend(m.databasePath, (url, init) => fetch('http://127.0.0.1:${address.port}/'+(String(url).includes('/decisions')?'review':'model'), init), async () => Response.json({data:[]}), ${JSON.stringify(join(sandbox, "empty-home"))}); });`,
		);
		const dbPath = join(sandbox, "Weft/weft.sqlite");
		await mkdir(join(sandbox, "Weft"), { mode: 0o700 });
		configureDatabase(dbPath);
		// Hide the complete disposable checkout, including its dependency installation.
		const hidden = join(sandbox, "checkout-unavailable");
		await rename(checkout, hidden);
		try {
			const launch = async () => {
				const app = await electron.launch({
					executablePath: join(relocated, "Contents/MacOS/Weft"),
					args: [],
					cwd: sandbox,
					env: {
						...process.env,
						PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
						WEFT_MANAGEMENT_TOKEN: "fixture-private-management-must-not-leak",
					},
				});
				const page = await app.firstWindow();
				await page.waitForFunction(() =>
					Boolean(sessionStorage.getItem("weft-management-token")),
				);
				assert.equal(
					await page.evaluate(
						() => typeof (globalThis as { require?: unknown }).require,
					),
					"undefined",
				);
				const origin = new URL(page.url()).origin;
				const token = await page.evaluate(() =>
					sessionStorage.getItem("weft-management-token"),
				);
				assert(token);
				const api = async (path: string, body?: unknown) => {
					const result = await fetch(origin + path, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							"x-weft-management-token": token,
							origin,
							"content-type": "application/json",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					});
					assert(
						result.ok,
						`${path} returned ${result.status}: ${await result.clone().text()}`,
					);
					return result.json();
				};
				return { app, page, origin, api };
			};
			const first = await launch();
			application = first.app;
			assert.equal((await fetch(first.origin + "/api/projects")).status, 403);
			const project = await first.api("/api/projects", {
				name: "Desktop acceptance",
				folders: [sandbox],
			});
			const chat = await first.api(`/api/projects/${project.id}/chats`, {
				name: "Native fixture",
			});
			const { agentId } = await first.api(`/api/chats/${chat.id}`, {
				prompt: "Run local fixture",
			});
			let record = await first.api(`/api/agents/${agentId}`);
			for (let i = 0; i < 300; i++) {
				record = await first.api(`/api/agents/${agentId}`);
				if (!record.busy) break;
				await delay(100);
			}
			assert.equal(
				record.agents[0].status,
				"succeeded",
				JSON.stringify(record),
			);
			assert.equal(modelCalls, 2);
			const tools = (await first.api(`/api/agents/${agentId}/tools`)).toolCalls;
			assert.equal(
				JSON.parse(tools[0].result).exitCode,
				0,
				JSON.stringify(tools[0]),
			);
			const nativeOutput = tools[0].output
				.map((chunk: { text: string }) => chunk.text)
				.join("");
			assert.match(nativeOutput, /v24\.21\.0/);
			assert.match(nativeOutput, /ripgrep/);
			assert.match(nativeOutput, /git version/);
			assert.match(nativeOutput, /11\.28\.8/);
			assert(
				nativeOutput.includes(
					"Relocated Weft.app/Contents/Resources/app/runtime/bin/node",
				),
			);
			assert.match(nativeOutput, /authority-absent/);
			await rename(hidden, checkout);
			await first.page.goto(`${first.origin}/?chat=${chat.id}`);
			const toolCard = first.page.locator(
				`[data-tool-call-id="${tools[0].id}"]`,
			);
			await toolCard.locator("summary").click();
			const copy = toolCard.getByRole("button", { name: "Copy", exact: true });
			await copy.click();
			await copy.getByText("✓").waitFor();
			command = `node -e 'const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(join(sandbox, "command-ready"))}, String(process.pid)); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(sandbox, "release-command"))})){clearInterval(t); console.log("released")}},100)'`;
			const heldChat = await first.api(`/api/projects/${project.id}/chats`, {
				name: "Active build guard",
			});
			const heldAgent = await first.api(`/api/chats/${heldChat.id}`, {
				prompt: "Hold native command",
			});
			for (let i = 0; i < 100; i++) {
				try {
					await stat(join(sandbox, "command-ready"));
					break;
				} catch {
					await delay(100);
				}
			}
			const commandPid = Number(
				await readFile(join(sandbox, "command-ready"), "utf8"),
			);
			process.kill(commandPid, 0);
			const info = await stat(
				join(original, "Contents/Resources/app/desktop/main.cjs"),
			);
			for (const closed of [false, true]) {
				if (closed)
					await application.evaluate(({ BrowserWindow }) =>
						BrowserWindow.getAllWindows().forEach(
							(window: { close(): void }) => {
								window.close();
							},
						),
					);
				for (const script of ["desktop:build", "desktop:start"]) {
					const result = spawnSync("pnpm", [script], {
						cwd: checkout,
						encoding: "utf8",
					});
					assert.notEqual(result.status, 0);
					assert.match(
						result.stderr + result.stdout,
						/Weft is running\. Quit Weft and build again/,
					);
					assert.equal(
						(
							await stat(
								join(original, "Contents/Resources/app/desktop/main.cjs"),
							)
						).mtimeMs,
						info.mtimeMs,
					);
					assert.equal((await first.api("/api/projects")).projects.length, 1);
					assert.equal(
						(await first.api(`/api/agents/${heldAgent.agentId}`)).busy,
						true,
					);
					process.kill(commandPid, 0);
				}
			}
			const secondInstance = spawn(join(relocated, "Contents/MacOS/Weft"), [], {
				cwd: sandbox,
				stdio: "ignore",
				env: {
					...process.env,
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					WEFT_MANAGEMENT_TOKEN: "fixture-private-management-must-not-leak",
				},
			});
			assert.equal(
				await new Promise((resolve) => secondInstance.once("exit", resolve)),
				0,
			);
			await application.evaluate(({ app }) => app.emit("activate"));
			const reopened = await application.firstWindow();
			await reopened.waitForFunction(() =>
				Boolean(sessionStorage.getItem("weft-management-token")),
			);
			await writeFile(join(sandbox, "release-command"), "");
			for (let i = 0; i < 100; i++) {
				if (!(await first.api(`/api/agents/${heldAgent.agentId}`)).busy) break;
				await delay(100);
			}
			assert.equal(
				(await first.api(`/api/agents/${heldAgent.agentId}`)).agents[0].status,
				"succeeded",
			);
			await closeApplication();
			await assert.rejects(fetch(first.origin + "/api/projects"));
			const savedTarget = {
				channel: "msedge",
				userDataDir: join(sandbox, "unused-personal-profile"),
				profile: "Default",
			};
			const fixtureDatabase = new DatabaseSync(dbPath);
			fixtureDatabase
				.prepare("UPDATE chats SET browser_target=? WHERE id=?")
				.run(JSON.stringify(savedTarget), chat.id);
			fixtureDatabase.close();
			await rename(checkout, hidden);
			const second = await launch();
			application = second.app;
			assert.equal(
				(await second.api("/api/projects")).projects[0].name,
				"Desktop acceptance",
			);
			const runTool = async (cmd: string) => {
				command = cmd;
				const { agentId } = await second.api(`/api/chats/${chat.id}`, {
					prompt: "Run desktop tool fixture",
				});
				let result = await second.api(`/api/agents/${agentId}`);
				for (let i = 0; i < 400; i++) {
					result = await second.api(`/api/agents/${agentId}`);
					if (!result.busy) break;
					await delay(100);
				}
				assert.equal(
					result.agents[0].status,
					"succeeded",
					JSON.stringify(result),
				);
				const tools = (await second.api(`/api/agents/${agentId}/tools`))
					.toolCalls;
				assert.equal(tools.length, 1);
				assert.deepEqual(
					(await second.api(`/api/chats/${chat.id}`)).browserTarget,
					savedTarget,
				);
				return {
					exitCode: JSON.parse(tools[0].result).exitCode,
					output: tools[0].output
						.map((chunk: { text: string }) => chunk.text)
						.join(""),
				};
			};
			for (const channel of ["chrome", "msedge"]) {
				const browser = await runTool(
					`playwright-cli open http://127.0.0.1:${address.port}/page --browser=${channel} && playwright-cli run-code 'async page => { await page.getByRole("textbox", {name:"Message"}).fill("${channel}-verified"); await page.getByRole("button", {name:"Apply"}).click(); return await page.locator("output").textContent(); }' && node -e 'const {execFileSync}=require("node:child_process"); console.log("owned-pids:"+JSON.stringify(execFileSync("/bin/ps",["-axo","pid=,command="],{encoding:"utf8"}).split("\\n").filter(line=>line.includes(process.env.TMPDIR)).map(line=>Number(line.trim().split(/\\s+/)[0])).filter(pid=>pid!==process.pid)))' && playwright-cli close`,
				);
				assert.equal(browser.exitCode, 0, browser.output);
				assert.match(browser.output, new RegExp(`${channel}-verified`));
				const pids = JSON.parse(
					browser.output.match(/owned-pids:(\[[^\n]*\])/)?.[1] ?? "[]",
				);
				assert(pids.length > 0, browser.output);
				for (const pid of pids) assert.throws(() => process.kill(pid, 0));
			}
			const missing = await runTool(
				`PLAYWRIGHT_MCP_EXECUTABLE_PATH='${join(sandbox, "missing-browser")}' playwright-cli open http://127.0.0.1:${address.port}/page --browser=chrome`,
			);
			assert.notEqual(missing.exitCode, 0, missing.output);
			assert.match(
				missing.output,
				/doesn't exist|does not exist|not found|executable/i,
			);
			const nonBrowser = await runTool(
				"node -e 'console.log(\"non-browser-still-works\")'",
			);
			assert.equal(nonBrowser.exitCode, 0, nonBrowser.output);
			assert.match(nonBrowser.output, /non-browser-still-works/);
			await assert.rejects(stat(savedTarget.userDataDir), { code: "ENOENT" });
			await closeApplication();
			await rename(hidden, checkout);
			command =
				"node --version && rg --version && git --version && pnpm --version";
			const finderScript = `(async()=>{
				let token;
				for(let i=0;i<100;i++) { token=sessionStorage.getItem('weft-management-token'); if(token) break; await new Promise(r=>setTimeout(r,100)); }
				const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-weft-management-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); if(!r.ok) throw new Error('Fixture HTTP '+r.status); return r.json();};
				const {agentId}=await api('/api/chats/${chat.id}',{prompt:'Finder native tools'});
				for(let i=0;i<300;i++){if(!(await api('/api/agents/'+agentId)).busy)break;await new Promise(r=>setTimeout(r,100));}
				const tools=(await api('/api/agents/'+agentId+'/tools')).toolCalls;
				return {status:200,exitCode:JSON.parse(tools[0].result).exitCode,output:tools[0].output.map(chunk=>chunk.text).join('')};
			})()`;
			await writeFile(
				join(root, "desktop/main.cjs"),
				`const {app}=require('electron'); const fs=require('node:fs'); app.setPath('appData', ${JSON.stringify(sandbox)}); app.on('browser-window-created', (_event,window) => { window.webContents.once('did-finish-load', async()=>{ const result=await window.webContents.executeJavaScript(${JSON.stringify(finderScript)}); fs.writeFileSync(${JSON.stringify(join(sandbox, "finder.json"))},JSON.stringify({...result,ppid:process.ppid,cwd:process.cwd(),path:process.env.PATH})); }); }); require('./application.cjs');`,
			);
			execFileSync("/usr/bin/open", ["-n", relocated], {
				cwd: sandbox,
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME },
			});
			finderRunning = true;
			let finder:
				| {
						status: number;
						ppid: number;
						cwd: string;
						path: string;
						exitCode: number;
						output: string;
				  }
				| undefined;
			for (let i = 0; i < 150; i++) {
				try {
					finder = JSON.parse(
						await readFile(join(sandbox, "finder.json"), "utf8"),
					);
					break;
				} catch {
					await delay(100);
				}
			}
			assert(finder, "LaunchServices app never became usable");
			assert.equal(finder.status, 200);
			assert.equal(finder.exitCode, 0, finder.output);
			assert.match(finder.output, /11\.28\.8/);
			assert.match(finder.output, /git version/);
			assert.match(finder.output, /v24\.21\.0/);
			assert.match(finder.output, /ripgrep/);
			assert.equal(finder.ppid, 1);
			assert.equal(finder.cwd, "/");
			await quitFinder();
			assert.equal((await stat(join(sandbox, "Weft"))).mode & 0o777, 0o700);
			assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
			const database = new DatabaseSync(dbPath);
			assert.equal(
				database.prepare("PRAGMA integrity_check").get()?.integrity_check,
				"ok",
			);
			database.close();
			assert.equal(
				(await readFile(join(root, "package.json"), "utf8")).includes(
					"devDependencies",
				),
				false,
			);
		} finally {
			if (application) {
				await closeApplication();
			}
			if (await stat(hidden).catch(() => undefined))
				await rename(hidden, checkout);
		}
		// Broken source must not replace the previous working app or launch it via desktop:start.
		const source = join(checkout, "src/main.tsx");
		const saved = await readFile(source, "utf8");
		const old = await stat(join(original, "Contents/MacOS/Weft"));
		try {
			await writeFile(source, saved + "\nthis is invalid TSX !!!\n");
			const result = spawnSync("pnpm", ["desktop:start"], {
				cwd: checkout,
				encoding: "utf8",
			});
			assert.notEqual(result.status, 0);
			assert.equal(
				(await stat(join(original, "Contents/MacOS/Weft"))).mtimeMs,
				old.mtimeMs,
			);
		} finally {
			await writeFile(source, saved);
		}
		for (const entry of ["main.cjs", "backend.ts"]) {
			const path = join(checkout, "desktop", entry);
			const savedEntry = await readFile(path, "utf8");
			const before = await stat(join(original, "Contents/MacOS/Weft"));
			try {
				await writeFile(path, "this is invalid JavaScript !!!");
				const result = spawnSync("pnpm", ["desktop:build"], {
					cwd: checkout,
					encoding: "utf8",
				});
				assert.notEqual(result.status, 0);
				assert.equal(
					(await stat(join(original, "Contents/MacOS/Weft"))).mtimeMs,
					before.mtimeMs,
				);
			} finally {
				await writeFile(path, savedEntry);
			}
		}
		const backendSource = join(checkout, "desktop/backend.ts");
		const originalBackend = await readFile(backendSource, "utf8");
		const marker = "// local-source-snapshot-acceptance";
		try {
			await writeFile(backendSource, `${originalBackend}\n${marker}\n`);
			assert.equal(
				(
					await readFile(
						join(original, "Contents/Resources/app/desktop/backend.ts"),
						"utf8",
					)
				).includes(marker),
				false,
			);
			execFileSync("pnpm", ["desktop:build"], {
				cwd: checkout,
				stdio: "inherit",
			});
			assert(
				(
					await readFile(
						join(original, "Contents/Resources/app/desktop/backend.ts"),
						"utf8",
					)
				).includes(marker),
			);
		} finally {
			await writeFile(backendSource, originalBackend);
		}
		await context.test(
			"bundled backend preserves incompatible data and rejects unsupported build hosts",
			() => backendFailures(checkout, dbPath),
		);
		await context.test(
			"desktop:start opens the successful build without disturbing unrelated services",
			async () => {
				const mainPath = join(checkout, "desktop/main.cjs");
				const main = await readFile(mainPath, "utf8");
				const started = join(sandbox, "started.json");
				const startedPid = join(sandbox, "started-pid");
				let opened = false;
				const unrelated = spawn(
					process.execPath,
					[
						"-e",
						"process.title='Weft';console.log('ready');setInterval(()=>{},1000)",
					],
					{ stdio: ["ignore", "pipe", "ignore"] },
				);
				await new Promise<void>((resolve) =>
					unrelated.stdout.once("data", () => resolve()),
				);
				try {
					await writeFile(
						mainPath,
						`const fixtureElectron=require('electron');require('node:fs').writeFileSync(${JSON.stringify(startedPid)},String(process.pid));fixtureElectron.app.setPath('appData',${JSON.stringify(join(sandbox, "start-data"))});fixtureElectron.dialog.showErrorBox=(title,message)=>require('node:fs').writeFileSync(${JSON.stringify(started)},JSON.stringify({error:title+message}));fixtureElectron.app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>{require('node:fs').writeFileSync(${JSON.stringify(started)},JSON.stringify({url:new URL(window.webContents.getURL()).origin,ppid:process.ppid,pid:process.pid}));fixtureElectron.app.quit()}));\n${main}`,
					);
					await writeFile(
						backendSource,
						originalBackend.replace("if (import.meta.main)", "if (false)") +
							`\nprocess.once('message',async m=>startBackend(m.databasePath,async()=>{throw Error('No model calls authorized')},async()=>Response.json({data:[]}),${JSON.stringify(join(sandbox, "empty-home"))}));\n`,
					);
					execFileSync("pnpm", ["desktop:start"], {
						cwd: checkout,
						stdio: "inherit",
					});
					opened = true;
					for (
						let i = 0;
						i < 150 && !(await stat(started).catch(() => false));
						i++
					)
						await delay(100);
					const launched = JSON.parse(await readFile(started, "utf8"));
					assert.equal(launched.ppid, 1);
					for (let i = 0; i < 100; i++) {
						try {
							process.kill(launched.pid, 0);
						} catch {
							break;
						}
						await delay(100);
					}
					assert.throws(() => process.kill(launched.pid, 0));
					for (let i = 0; i < 100; i++) {
						try {
							await fetch(launched.url);
						} catch {
							break;
						}
						await delay(100);
					}
					await assert.rejects(fetch(launched.url));
					assert(unrelated.pid);
					process.kill(unrelated.pid, 0);
					assert.equal(
						(await fetch(`http://127.0.0.1:${address.port}/page`)).status,
						200,
					);
				} finally {
					await writeFile(mainPath, main);
					await writeFile(backendSource, originalBackend);
					unrelated.kill();
					await new Promise((resolve) => unrelated.once("exit", resolve));
					if (opened) await quitFinder(original, startedPid);
				}
			},
		);
	} finally {
		let appCleanupComplete = false;
		try {
			await closeApplication();
			if (finderRunning) await quitFinder();
			appCleanupComplete = true;
		} finally {
			model.closeAllConnections();
			await new Promise<void>((resolve) => model.close(() => resolve()));
			if (appCleanupComplete && !preserveFixture)
				await rm(sandbox, { recursive: true, force: true });
		}
	}
});

async function backendFailures(checkout: string, persistentPath: string) {
	const directory = await mkdtemp(join(tmpdir(), "weft desktop failures "));
	try {
		const path = join(directory, "incompatible.sqlite");
		const db = new DatabaseSync(path);
		db.exec(
			"PRAGMA user_version=1; CREATE TABLE keep_me(value TEXT); INSERT INTO keep_me VALUES('preserve')",
		);
		db.close();
		const before = await readFile(path);
		const root = join(
			checkout,
			"desktop-output/Weft.app/Contents/Resources/app",
		);
		const backend = spawn(
			join(root, "runtime/bin/node"),
			[join(root, "desktop/backend.ts")],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: {
					...process.env,
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					WEFT_MANAGEMENT_TOKEN: "fixture-private-management-must-not-leak",
				},
			},
		);
		const messages: unknown[] = [];
		backend.on("message", (message) => messages.push(message));
		const exited = new Promise<number | null>((resolve) =>
			backend.once("exit", resolve),
		);
		backend.send({ databasePath: path });
		assert.equal(await exited, 1);
		assert.match(JSON.stringify(messages), /incompatible schema/);
		assert.deepEqual(await readFile(path), before);
		const orphan = spawn(
			join(root, "runtime/bin/node"),
			[join(root, "desktop/backend.ts")],
			{ cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		const orphanExited = new Promise<number | null>((resolve) =>
			orphan.once("exit", resolve),
		);
		const ready = new Promise<{ type: string; origin: string; token: string }>(
			(resolve) => orphan.once("message", resolve),
		);
		orphan.send({ databasePath: persistentPath });
		const status = await ready;
		assert.equal(status.type, "ready");
		const persisted = await fetch(`${status.origin}/api/projects`, {
			headers: { "x-weft-management-token": status.token },
		});
		assert.equal(persisted.status, 200);
		assert.equal(
			(await persisted.json()).projects[0].name,
			"Desktop acceptance",
		);
		orphan.disconnect();
		assert.equal(await orphanExited, 0);
		await assert.rejects(fetch(`${status.origin}/api/projects`));
		const override = join(directory, "unsupported.cjs");
		await writeFile(
			override,
			"Object.defineProperty(process, 'platform', {value:'linux'})",
		);
		const appBefore = await stat(join(root, "desktop/main.cjs"));
		const result = spawnSync(
			process.execPath,
			["--require", override, "desktop/build.ts"],
			{ cwd: checkout, encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /require macOS Apple Silicon/);
		assert.equal(
			(await stat(join(root, "desktop/main.cjs"))).mtimeMs,
			appBefore.mtimeMs,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
