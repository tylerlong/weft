import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
export const playwrightRoot = dirname(
	require.resolve("playwright/package.json"),
);
const playwrightRequire = createRequire(join(playwrightRoot, "package.json"));
const playwrightCoreRoot = dirname(
	playwrightRequire.resolve("playwright-core/package.json"),
);
export const browserSkill = join(
	playwrightCoreRoot,
	"lib/tools/skills/playwright-cli",
);
// Fixed Playwright's own registry supplies platform revisions and cache paths.
const { registry, utils } = require(
	join(playwrightCoreRoot, "lib/coreBundle.js"),
);
export const browserCacheDirectory: string = registry.registryDirectory;
export const browserGuide = fileURLToPath(
	new URL("../docs/browser-tools.md", import.meta.url),
);

export type BrowserTarget = {
	channel: string;
	userDataDir: string;
	profile: string;
};
const {
	findPlaywrightExtensionProfile,
	playwrightExtensionInstallUrl,
} = require(join(playwrightCoreRoot, "lib/tools/utils/extension.js"));
export async function personalBrowserCommand(
	value: Record<string, unknown>,
	current: BrowserTarget | null,
	scratch: string,
) {
	if (
		Object.keys(value).some(
			(key) =>
				!["channel", "profile", "user_data_dir", "change_target"].includes(key),
		) ||
		(value.channel !== undefined && typeof value.channel !== "string") ||
		(value.profile !== undefined &&
			(typeof value.profile !== "string" ||
				!value.profile ||
				/[\\/\0]/.test(value.profile) ||
				value.profile === "." ||
				value.profile === "..")) ||
		(value.user_data_dir !== undefined &&
			(typeof value.user_data_dir !== "string" ||
				!isAbsolute(value.user_data_dir) ||
				value.user_data_dir.includes("\0"))) ||
		(value.change_target !== undefined &&
			typeof value.change_target !== "boolean")
	)
		throw new Error("Invalid personal browser target");
	if (
		current &&
		!value.change_target &&
		((value.channel !== undefined && value.channel !== current.channel) ||
			(value.profile !== undefined && value.profile !== current.profile) ||
			(value.user_data_dir !== undefined &&
				value.user_data_dir !== current.userDataDir))
	)
		throw new Error(
			"Chat already has a personal browser target; change_target requires an explicit user request",
		);
	if (process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH)
		throw new Error(
			"Tracked browser targets require a standard channel installation; use the raw CLI for PLAYWRIGHT_MCP_EXECUTABLE_PATH",
		);
	const channel =
		value.channel ??
		current?.channel ??
		process.env.PLAYWRIGHT_MCP_BROWSER ??
		"chrome";
	if (typeof channel !== "string" || !utils.isChromiumChannelName(channel))
		throw new Error(
			"Personal target requires an installed Chrome or Edge channel",
		);
	const userDataDir =
		value.user_data_dir ??
		(current?.channel === channel ? current.userDataDir : undefined) ??
		process.env.PWTEST_EXTENSION_USER_DATA_DIR ??
		utils.defaultUserDataDirForChannel(channel);
	if (typeof userDataDir !== "string")
		throw new Error("Browser profile directory is unavailable");
	const profile =
		value.profile ??
		(current?.channel === channel && current.userDataDir === userDataDir
			? current.profile
			: undefined) ??
		process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME ??
		(await findPlaywrightExtensionProfile(userDataDir));
	if (typeof profile !== "string")
		throw new Error(
			`Playwright Extension not found in "${userDataDir}". Install it from ${playwrightExtensionInstallUrl}`,
		);
	const target: BrowserTarget = { channel, userDataDir, profile };
	const config = join(scratch, `personal-browser-${randomUUID()}.json`);
	await writeFile(
		config,
		JSON.stringify({ browser: { userDataDir }, outputMode: "stdout" }),
		{ mode: 0o600 },
	);
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
	return {
		target,
		command: `PLAYWRIGHT_MCP_PROFILE_DIR_NAME=${quote(profile)} playwright-cli -s=weft-personal attach --extension=${quote(channel)} --config=${quote(config)}`,
	};
}

export async function closeBrowserSessions(scratch: string) {
	const directory = join(scratch, "playwright-daemon");
	if (!existsSync(directory)) return;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PWTEST_DAEMON_SESSION_DIR: directory,
	};
	delete env.WEFT_MANAGEMENT_TOKEN;
	// The fixed registry caches its directory; a separate process keeps Agent cleanup scoped.
	await promisify(execFile)(
		process.execPath,
		[
			"-e",
			`
const { Registry } = require(process.argv[1] + "/lib/tools/cli-client/registry.js");
const { Session } = require(process.argv[1] + "/lib/tools/cli-client/session.js");
(async () => {
  const registry = await Registry.load();
  for (const entries of registry.entryMap().values())
    for (const entry of entries) await new Session(entry).stop();
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
			playwrightCoreRoot,
		],
		{ env, timeout: 10000, maxBuffer: 8192 },
	);
}
