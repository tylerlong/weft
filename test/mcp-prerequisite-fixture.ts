// Executed as isolated docker/colima stand-ins, never the user's runtime.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const directory = process.env.WEFT_MCP_PREREQ_DIRECTORY;
if (!directory) throw new Error("Missing isolated runtime directory");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const log = (event = "command") =>
	appendFileSync(
		join(directory, "commands.jsonl"),
		`${JSON.stringify({ command, args, event, pid: process.pid })}\n`,
	);
log();
const path = join(directory, "state.json");
const state = JSON.parse(readFileSync(path, "utf8"));
process.on("SIGTERM", () => {
	log("terminated");
	if (!state.ignoreTerm) process.exit(0);
});
if (command === "docker") {
	if (args.includes("info")) {
		if (state.infoHang) {
			setInterval(() => {}, 1000);
			await new Promise(() => {});
		}
		if (state.ready) console.log("controlled Docker ready");
		else {
			console.error("controlled Docker endpoint unreachable");
			process.exitCode = 1;
		}
	} else if (args.includes("inspect"))
		console.log(
			JSON.stringify(
				state.endpoint ?? `unix://${directory}/colima-home/default/docker.sock`,
			),
		);
	else if (args.includes("run")) {
		if (!state.ready) {
			console.error("controlled Docker endpoint unreachable");
			process.exit(1);
		}
		const fixture = process.env.WEFT_MCP_FIXTURE;
		if (!fixture) throw new Error("Missing controlled MCP fixture");
		process.argv = [
			process.execPath,
			fixture,
			process.env.WEFT_MCP_LOG ?? "",
			"jira",
		];
		await import(fixture);
	} else throw new Error("Unexpected controlled Docker arguments");
} else if (command === "colima") {
	if (args[0] === "list") {
		if (state.listMalformed) console.log("not JSON");
		else if (!state.missingProfile) {
			const profile = JSON.stringify({
				name: "default",
				status: state.status,
				runtime: state.runtime,
			});
			console.log(profile);
			if (state.duplicateProfile) console.log(profile);
		}
	} else if (args[0] === "start") {
		if (state.startFailure) {
			console.error("controlled Colima start failure");
			process.exitCode = 1;
		} else {
			state.status = "Running";
			state.ready = !state.unhealthy && !state.startDelay;
			writeFileSync(path, JSON.stringify(state));
			if (state.startHang) {
				if (state.spawnChild) {
					const child = spawn(
						process.execPath,
						["-e", "setInterval(() => {}, 1000)"],
						{ stdio: "ignore" },
					);
					appendFileSync(
						join(directory, "commands.jsonl"),
						`${JSON.stringify({ command: "owned-child", args: [], event: "command", pid: child.pid })}\n`,
					);
				}
				setInterval(() => {}, 1000);
				await new Promise(() => {});
			}
			if (state.startDelay) {
				await new Promise((resolve) => setTimeout(resolve, state.startDelay));
				state.ready = !state.unhealthy;
				writeFileSync(path, JSON.stringify(state));
			}
		}
	} else throw new Error("Unexpected controlled Colima arguments");
}
