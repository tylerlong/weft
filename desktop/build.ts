import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "desktop-output");
const identity = "local.weft.desktop";

function assertStopped() {
	// LaunchServices identifies live applications even after their last window closes.
	const count = execFileSync(
		"/usr/bin/osascript",
		[
			"-l",
			"JavaScript",
			"-e",
			`ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${identity}').count`,
		],
		{ encoding: "utf8" },
	).trim();
	if (count !== "0")
		throw new Error("Weft is running. Quit Weft and build again.");
}

async function nodeRuntime(stage: string) {
	const version = "24.21.0";
	const archive = `node-v${version}-darwin-arm64.tar.gz`;
	const base = `https://nodejs.org/dist/v${version}`;
	const cache = join(output, "cache");
	await mkdir(cache, { recursive: true });
	const sums = await fetch(`${base}/SHASUMS256.txt`);
	if (!sums.ok)
		throw new Error(`Node checksum download failed: ${sums.status}`);
	const expected = (await sums.text())
		.split("\n")
		.find((line) => line.endsWith(`  ${archive}`))
		?.split(" ")[0];
	if (!expected || !/^[a-f0-9]{64}$/.test(expected))
		throw new Error("Missing vendor checksum for Node runtime");
	const path = join(cache, archive);
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const response = await fetch(`${base}/${archive}`);
		if (!response.ok)
			throw new Error(`Node runtime download failed: ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
	}
	if (createHash("sha256").update(bytes).digest("hex") !== expected)
		throw new Error(
			"Node runtime checksum mismatch; remove the desktop runtime cache and retry",
		);
	await writeFile(path, bytes);
	const runtime = join(stage, "runtime");
	await mkdir(runtime);
	execFileSync("/usr/bin/tar", [
		"-xzf",
		path,
		"-C",
		runtime,
		"--strip-components=1",
		`node-v${version}-darwin-arm64/bin/node`,
	]);
}

async function restoreLinks(directory: string, source: string) {
	for (const entry of await readdir(source, { withFileTypes: true })) {
		const from = join(source, entry.name),
			to = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			const target = await readlink(from);
			if (isAbsolute(target))
				throw new Error(`Absolute dependency link: ${from}`);
			await unlink(to);
			await symlink(target, to);
		} else if (entry.isDirectory()) await restoreLinks(to, from);
	}
}

async function validateLinks(directory: string, bundle: string) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			const target = relative(bundle, await realpath(path));
			if (target === ".." || target.startsWith("../") || isAbsolute(target))
				throw new Error(`Dependency escapes application: ${path}`);
		} else if (entry.isDirectory()) await validateLinks(path, bundle);
	}
}

async function build() {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error(
			"Weft desktop builds require macOS Apple Silicon (darwin arm64).",
		);
	if (process.argv.slice(2).some((arg) => arg !== "--start"))
		throw new Error("Usage: pnpm desktop:build or pnpm desktop:start");
	assertStopped();
	const { packager } = await import("@electron/packager");
	await mkdir(output, { recursive: true });
	const staging = await mkdtemp(join(output, ".staging-"));
	try {
		const source = join(staging, "source");
		await mkdir(source);
		// Only runtime inputs enter the app; never copy the checkout or its data/configuration.
		for (const name of ["package.json", "pnpm-lock.yaml"])
			await cp(join(root, name), join(source, name));
		execFileSync(
			"pnpm",
			["install", "--prod", "--frozen-lockfile", "--ignore-scripts"],
			{ cwd: source, stdio: "inherit" },
		);
		await rm(join(source, "pnpm-lock.yaml"));
		for (const metadata of [
			".modules.yaml",
			".pnpm-workspace-state-v1.json",
			".pnpm/lock.yaml",
		])
			await rm(join(source, "node_modules", metadata), { force: true });
		await mkdir(join(source, "src"));
		for (const name of await readdir(join(root, "src")))
			if (name.endsWith(".ts"))
				await cp(join(root, "src", name), join(source, "src", name));
		await mkdir(join(source, "docs"));
		await cp(
			join(root, "docs/browser-tools.md"),
			join(source, "docs/browser-tools.md"),
		);
		await mkdir(join(source, "desktop"));
		for (const name of ["main.cjs", "backend.ts"])
			await cp(join(root, "desktop", name), join(source, "desktop", name));
		execFileSync("pnpm", ["build", "--outDir", join(source, "dist")], {
			cwd: root,
			stdio: "inherit",
		});
		await nodeRuntime(source);
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({
				name: "weft-desktop",
				productName: "Weft",
				version: "0.0.0",
				main: "desktop/main.cjs",
				type: "module",
			}),
		);
		const paths = await packager({
			dir: source,
			out: join(staging, "packaged"),
			name: "Weft",
			platform: "darwin",
			arch: "arm64",
			electronVersion: "45.0.0",
			appBundleId: identity,
			asar: false,
			derefSymlinks: false,
			prune: false,
		});
		const bundle = join(paths[0], "Weft.app");
		const appRoot = join(bundle, "Contents/Resources/app");
		await restoreLinks(appRoot, source);
		await validateLinks(bundle, bundle);
		// Check discovery with the app's Node, with staging resources temporarily unavailable.
		const hidden = join(staging, "source-unavailable");
		await rename(source, hidden);
		execFileSync(
			join(appRoot, "runtime/bin/node"),
			[
				"--input-type=module",
				"-e",
				`await import('./src/server.ts'); const {createRequire}=await import('node:module'); const r=createRequire(import.meta.url); r.resolve('@openai/codex/package.json'); r.resolve('playwright/package.json');`,
			],
			{
				cwd: appRoot,
				env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
				stdio: "inherit",
			},
		);
		assertStopped();
		const previous = join(output, ".previous-Weft.app");
		await rm(previous, { recursive: true, force: true });
		const app = join(output, "Weft.app");
		let replaced = false;
		try {
			await rename(app, previous);
			replaced = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(bundle, app);
		} catch (error) {
			if (replaced) await rename(previous, app);
			throw error;
		}
		await rm(previous, { recursive: true, force: true });
		console.log(`Built ${app}`);
		if (process.argv.includes("--start")) execFileSync("/usr/bin/open", [app]);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

build().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
