const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const { userInfo } = require("node:os");

app.setName("Weft");
const data = join(app.getPath("appData"), "Weft");
mkdirSync(data, { recursive: true, mode: 0o700 });
chmodSync(data, 0o700);
app.setPath("userData", data);
delete process.env.WEFT_MANAGEMENT_TOKEN;
let backend,
	window,
	origin,
	token,
	stopping = false,
	failed = false;

function fail(message) {
	if (failed) return;
	failed = true;
	dialog.showErrorBox("Weft could not continue", message);
	app.quit();
}

async function showWindow() {
	if (!origin || stopping) return;
	if (window) {
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
		return;
	}
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 1280,
		minHeight: 720,
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	window.on("closed", () => {
		window = undefined;
	});
	const external = (url) => {
		try {
			const parsed = new URL(url);
			if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
				parsed.hash = "";
				void shell.openExternal(parsed.href);
			}
		} catch {}
	};
	window.webContents.setWindowOpenHandler(({ url }) => {
		external(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (new URL(url).origin !== origin) {
			event.preventDefault();
			external(url);
		}
	});
	const current = window;
	window.webContents.session.setPermissionRequestHandler(
		(contents, permission, callback, details) =>
			callback(
				contents === current.webContents &&
					permission === "clipboard-sanitized-write" &&
					new URL(details.requestingUrl).origin === origin,
			),
	);
	window.webContents.session.setPermissionCheckHandler(
		(contents, permission, requestingOrigin) =>
			contents === current.webContents &&
			permission === "clipboard-sanitized-write" &&
			requestingOrigin === origin,
	);
	try {
		await current.loadURL(`${origin}/#management=${token}`);
	} catch (error) {
		if (!current.isDestroyed()) throw error;
	}
	if (!current.isDestroyed() && !stopping) current.show();
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("window-all-closed", () => {});
	app.on("activate", () => {
		void showWindow().catch(() =>
			fail("Could not reopen the application window. Quit and reopen Weft."),
		);
	});
	app.on("second-instance", () => {
		void showWindow().catch(() =>
			fail("Could not reopen the application window. Quit and reopen Weft."),
		);
	});
	app.on("before-quit", (event) => {
		event.preventDefault();
		if (stopping) return;
		stopping = true;
		if (!backend || backend.exitCode !== null || backend.signalCode !== null) {
			app.exit(failed ? 1 : (backend?.exitCode ?? 1));
			return;
		}
		backend.once("exit", (code, signal) => {
			if (!failed && (code !== 0 || signal))
				dialog.showErrorBox(
					"Weft shutdown failed",
					"The backend did not finish cleanup successfully. Inspect saved command records before reopening.",
				);
			app.exit(code === 0 && !signal && !failed ? 0 : 1);
		});
		backend.send({ type: "stop" });
	});
	app
		.whenReady()
		.then(() => {
			Menu.setApplicationMenu(
				Menu.buildFromTemplate([
					{
						label: "Weft",
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							{ role: "quit" },
						],
					},
					{ role: "editMenu" },
					{ role: "windowMenu" },
				]),
			);
			let path;
			try {
				// Shell startup output may contain notices; only the delimited PATH is inherited.
				const output = execFileSync(
					process.env.SHELL || userInfo().shell,
					["-ilc", 'printf "\\0%s\\0" "$PATH"'],
					{
						encoding: "utf8",
						timeout: 15000,
						stdio: ["ignore", "pipe", "ignore"],
					},
				);
				path = output.split("\0").at(-2);
				if (!path) throw new Error("Empty login-shell PATH");
			} catch {
				fail(
					"Could not resolve your login-shell PATH. Check your shell startup files and reopen Weft.",
				);
				return;
			}
			const root = app.getAppPath();
			backend = spawn(
				join(root, "runtime/bin/node"),
				[join(root, "desktop/backend.ts")],
				{
					cwd: data,
					env: { ...process.env, PATH: path },
					stdio: ["ignore", "ignore", "ignore", "ipc"],
				},
			);
			backend.on("error", () =>
				fail(
					"Could not launch the bundled Node backend. Rebuild Weft and try again.",
				),
			);
			backend.on("exit", () => {
				if (!stopping)
					fail(
						"The backend stopped unexpectedly. Reopen Weft to inspect saved history; operations are not replayed.",
					);
			});
			backend.on("message", (message) => {
				if (message.type === "failure") fail(message.message);
				if (message.type === "ready") {
					origin = message.origin;
					token = message.token;
					void showWindow().catch(() =>
						fail(
							"Could not load the application interface. Rebuild Weft and try again.",
						),
					);
				}
			});
			backend.send({ databasePath: join(data, "weft.sqlite") });
		})
		.catch(() =>
			fail(
				"Could not initialize the desktop application. Check application resources and permissions.",
			),
		);
}
