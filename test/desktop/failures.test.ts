import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const supported = process.platform === "darwin" && process.arch === "arm64";
// Error dialogs are captured at the OS boundary; app/backend resources and lifecycle remain real.
test("packaged desktop reports startup, backend-exit and cleanup failures without secrets", {
	skip: !supported,
	timeout: 120000,
}, async (context) => {
	execFileSync("pnpm", ["desktop:build"], { stdio: "inherit" });
	const sandbox = await mkdtemp(join(tmpdir(), "weft desktop failures "));
	const bundle = join(sandbox, "Failure Weft.app"),
		root = join(bundle, "Contents/Resources/app");
	await cp(resolve("desktop-output/Weft.app"), bundle, {
		recursive: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
	});
	await rename(
		join(root, "desktop/main.cjs"),
		join(root, "desktop/application.cjs"),
	);
	const source = await readFile(join(root, "desktop/backend.ts"), "utf8");
	try {
		for (const name of [
			"missing-node",
			"missing-backend",
			"incompatible-schema",
			"data-directory",
			"unexpected-exit",
			"cleanup-error",
		]) {
			await context.test(name, async () => {
				const data = join(sandbox, name),
					failure = join(data, "failure.json");
				await mkdir(data);
				const backend = join(root, "desktop/backend.ts");
				await writeFile(backend, source);
				if (name === "data-directory")
					await writeFile(join(data, "Weft"), "preserve");
				if (name === "incompatible-schema") {
					await mkdir(join(data, "Weft"));
					const db = new DatabaseSync(join(data, "Weft/weft.sqlite"));
					db.exec(
						"PRAGMA user_version=1;CREATE TABLE keep(value);INSERT INTO keep VALUES('preserve')",
					);
					db.close();
				}
				const dbPath = join(data, "Weft/weft.sqlite");
				const before = await readFile(dbPath).catch(() => undefined);
				const autoQuit =
					name === "cleanup-error"
						? `app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>app.quit()));`
						: "";
				await writeFile(
					join(root, "desktop/main.cjs"),
					`const {app,dialog}=require('electron');const fs=require('node:fs');app.setPath('appData',${JSON.stringify(data)});dialog.showErrorBox=(title,message)=>fs.writeFileSync(${JSON.stringify(failure)},JSON.stringify({title,message}));${autoQuit}require('./application.cjs');`,
				);
				if (name === "missing-node")
					await rename(
						join(root, "runtime/bin/node"),
						join(root, "runtime/bin/node-hidden"),
					);
				if (name === "missing-backend") await rm(backend);
				if (name === "unexpected-exit" || name === "cleanup-error") {
					await writeFile(join(root, "desktop/failure-backend.ts"), source);
					await writeFile(
						backend,
						`import {startBackend} from './failure-backend.ts';process.once('message',async m=>{const server=await startBackend(m.databasePath,async()=>{throw Error('fixture-secret-API-key')},async()=>Response.json({data:[]}),${JSON.stringify(join(data, "empty-home"))});${name === "unexpected-exit" ? "setTimeout(()=>process.exit(7),250)" : "server.close=callback=>{process.exitCode=1;callback(new Error('fixture-secret-API-key'));setImmediate(()=>process.exit(1))}"}});`,
					);
				}
				const child = spawn(join(bundle, "Contents/MacOS/Weft"), [], {
					cwd: sandbox,
					stdio: "ignore",
					env: {
						...process.env,
						PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
						WEFT_MANAGEMENT_TOKEN: "fixture-secret-management-token",
					},
				});
				try {
					const code = await new Promise<number | null>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("Fixture app did not exit after failure")), 15000);
						child.once("error", reject);
						child.once("exit", code => { clearTimeout(timer); resolve(code); });
					});
					assert.equal(code, 1);
					const error = await readFile(failure, "utf8");
					assert.match(error, /could not|stopped unexpectedly|cleanup failed/i);
					assert.doesNotMatch(error, /fixture-secret|management=|[a-f0-9]{64}/);
					if (before) assert.deepEqual(await readFile(dbPath), before);
					if (name === "data-directory")
						assert.equal(
							await readFile(join(data, "Weft"), "utf8"),
							"preserve",
						);
				} finally {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
						await new Promise((resolve) => child.once("exit", resolve));
					}
					if (name === "missing-node")
						await rename(
							join(root, "runtime/bin/node-hidden"),
							join(root, "runtime/bin/node"),
						);
				}
			});
		}
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});
