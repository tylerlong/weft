import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { McpConfig, McpService } from "./mcp-config.ts";

const preparing = new Map<string, Promise<void>>();

// Recognize only known Docker argument shapes; unknown launches retain their normal protocol path.
function jiraDocker(config: McpConfig) {
	if (!("command" in config) || basename(config.command) !== "docker") return;
	let index = 0;
	let host: string | undefined;
	let context: string | undefined;
	while (index < config.args.length && config.args[index] !== "run") {
		const flag = config.args[index++];
		const [name, inline] = flag.split(/=(.*)/s);
		if (!["-H", "--host", "-c", "--context", "--config"].includes(name)) return;
		const value = inline ?? config.args[index++];
		if (!value || value.startsWith("-")) return;
		if (name === "-H" || name === "--host") {
			if (host) return;
			host = value;
		}
		if (name === "-c" || name === "--context") context = value;
	}
	if (config.args[index++] !== "run" || (host && context)) return;
	const global = config.args.slice(0, index - 1);
	for (; index < config.args.length; index++) {
		const arg = config.args[index];
		if (["-i", "--interactive", "--rm", "--rm=true"].includes(arg)) continue;
		if (["-e", "--env"].includes(arg)) {
			if (!config.args[++index]) return;
			continue;
		}
		if (arg.startsWith("--env=") || /^-e.+/.test(arg)) continue;
		if (
			!/^ghcr\.io\/sooperset\/mcp-atlassian(?::[^/@]+|@sha256:[a-f0-9]{64})?$/.test(
				arg,
			)
		)
			return;
		return { command: config.command, global, host, context };
	}
}

async function run(
	command: string,
	args: string[],
	env: Record<string, string>,
	signal: AbortSignal,
	report: (text: string) => void,
) {
	signal.throwIfAborted();
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(done, reject) => {
			const child = spawn(command, args, {
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let stdout = "";
			let stderr = "";
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const kill = (kind: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && child.pid)
						process.kill(-child.pid, kind);
					else child.kill(kind);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH")
						child.kill(kind);
				}
			};
			const abort = () => {
				kill("SIGTERM");
				killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
			};
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.setEncoding("utf8").on("data", (text: string) => {
				stdout = (stdout + text).slice(-1_000_000);
			});
			child.stderr.setEncoding("utf8").on("data", (text: string) => {
				stderr = (stderr + text).slice(-1_000_000);
				report(text);
			});
			child.once("error", reject);
			child.once("close", (code) => {
				// The leader can exit while a child with separate stdio still ignores SIGTERM.
				if (signal.aborted) kill("SIGKILL");
				clearTimeout(killTimer);
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else done({ code, stdout, stderr });
			});
			if (signal.aborted) abort();
		},
	);
}

function failure(
	operation: string,
	result: { code: number | null; stdout: string; stderr: string },
) {
	return new Error(
		`${operation} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
	);
}

export async function prepareMcp(
	config: McpConfig,
	variables: McpService["env"],
	signal: AbortSignal,
	report: (text: string) => void,
) {
	const launch = jiraDocker(config);
	if (!launch) return;
	const env = {
		...getDefaultEnvironment(),
		...Object.fromEntries(variables.map(({ name, value }) => [name, value])),
	};
	const docker = (args: string[]) =>
		run(launch.command, [...launch.global, ...args], env, signal, report);
	const ready = () => docker(["info", "--format", "{{json .ServerVersion}}"]);
	const initial = await ready();
	if (initial.code === 0) return;
	let endpoint = launch.host;
	if (!endpoint && !launch.context && !env.DOCKER_CONTEXT)
		endpoint = env.DOCKER_HOST;
	if (!endpoint) {
		const inspected = await docker([
			"context",
			"inspect",
			...(launch.context || env.DOCKER_CONTEXT
				? [launch.context || env.DOCKER_CONTEXT]
				: []),
			"--format",
			"{{json .Endpoints.docker.Host}}",
		]);
		if (inspected.code !== 0)
			throw failure("Docker endpoint inspection", inspected);
		try {
			endpoint = JSON.parse(inspected.stdout);
		} catch {
			throw new Error(
				"Docker endpoint inspection returned invalid JSON; no runtime was started",
			);
		}
	}
	const home =
		env.COLIMA_HOME || (env.HOME ? join(env.HOME, ".colima") : undefined);
	if (!home || typeof endpoint !== "string" || !endpoint.startsWith("unix:///"))
		throw failure(
			"Docker readiness; no confidently identified Colima profile",
			initial,
		);
	const socket = resolve(endpoint.slice("unix://".length));
	const relative = socket.slice(resolve(home).length + 1);
	const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/docker\.sock$/.exec(relative);
	if (!socket.startsWith(`${resolve(home)}/`) || !match || match[1] === "..")
		throw failure(
			"Docker readiness; endpoint is not a supported Colima profile socket",
			initial,
		);
	const profile = match[1];
	const key = join(await realpath(home), profile);
	const previous = preparing.get(key);
	const work = (async () => {
		if (previous) {
			await new Promise<void>((done, reject) => {
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				void previous
					.catch(() => {})
					.then(() => {
						signal.removeEventListener("abort", abort);
						done();
					});
				if (signal.aborted) abort();
			});
			signal.throwIfAborted();
			if ((await ready()).code === 0) return;
		}
		const profileConfig = await stat(join(home, profile, "colima.yaml")).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return;
				throw error;
			},
		);
		if (!profileConfig?.isFile())
			throw new Error(
				`Colima profile ${profile} has no existing configuration; no runtime was started. ${initial.stderr}`,
			);
		const listed = await run(
			"colima",
			["list", "--json", "--profile", profile],
			env,
			signal,
			report,
		);
		if (listed.code !== 0) throw failure("Colima profile inspection", listed);
		let rows: { name?: string; status?: string; runtime?: string }[];
		try {
			rows = listed.stdout
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line));
		} catch {
			throw new Error(
				"Colima profile inspection returned invalid JSON; no runtime was started",
			);
		}
		const profiles = rows.filter((row) => row?.name === profile);
		if (
			profiles.length !== 1 ||
			!["docker", "docker+k3s"].includes(profiles[0].runtime ?? "")
		)
			throw new Error(
				`Colima profile ${profile} is missing, ambiguous or not a Docker runtime; no runtime was started. ${initial.stderr}`,
			);
		if (profiles[0].status !== "Stopped")
			throw new Error(
				`Colima profile ${profile} status is ${profiles[0].status}; Docker is unreachable. Running/unknown runtimes are not restarted. ${initial.stderr}`,
			);
		if ((await ready()).code === 0) return;
		report(
			`Colima profile ${profile} start requested. Cancellation does not roll back a shared runtime that has started.\n`,
		);
		const started = await run(
			"colima",
			[
				"start",
				profile,
				"--activate=false",
				"--save-config=false",
				"--ssh-config=false",
			],
			env,
			signal,
			report,
		);
		if (started.code !== 0)
			throw failure(`Colima profile ${profile} startup`, started);
		report(
			`Colima profile ${profile} start completed. The shared runtime is not Agent-owned and will not be stopped during cleanup.\n`,
		);
		while (true) {
			const result = await ready();
			if (result.code === 0) return;
			await delay(250, undefined, { signal });
		}
	})();
	// A cancelled waiter must not release the lock while an earlier owner's start is still running.
	const tail = Promise.allSettled([previous, work]).then(() => {});
	preparing.set(key, tail);
	try {
		await work;
	} finally {
		void tail.then(() => {
			if (preparing.get(key) === tail) preparing.delete(key);
		});
	}
}
