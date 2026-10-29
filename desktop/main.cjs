const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const { userInfo } = require("node:os");

app.setName("Weft");
const data = join(app.getPath("appData"), "Weft");
let dataFailure;
try {
	mkdirSync(data, { recursive: true, mode: 0o700 });
	chmodSync(data, 0o700);
	app.setPath("userData", data);
} catch {
	dataFailure = true;
}
delete process.env.WEFT_MANAGEMENT_TOKEN;
let backend,
	window,
	origin,
	token,
	stopping = false,
	quitPending = false,
	startupTimer,
	failed = false;

function fail(message) {
	if (failed) return;
	failed = true;
	clearTimeout(startupTimer);
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
		if (stopping || quitPending) return;
		quitPending = true;
		void (async () => {
			if (!failed && origin && backend?.connected) {
				const state = await new Promise((resolve, reject) => {
					const receive = (message) => {
						if (message.type !== "work-state") return;
						clearTimeout(timer);
						backend.removeListener("message", receive);
						resolve(message);
					};
					const timer = setTimeout(() => {
						backend.removeListener("message", receive);
						reject(new Error("Backend did not report current work"));
					}, 5000);
					backend.on("message", receive);
					backend.send({ type: "work-state" });
				});
				if (state.active || state.queued) {
					const choice = await dialog.showMessageBox({
						type: "warning",
						buttons: ["Cancel", "Quit Weft"],
						defaultId: 0,
						cancelId: 0,
						message: "Quit Weft?",
						detail:
							"Active Agents will stop. Unstarted queued input is not retained after exit. Completed effects are not undone.",
					});
					if (choice.response !== 1) return;
				}
			}
			stopping = true;
			clearTimeout(startupTimer);
			if (
				!backend ||
				backend.exitCode !== null ||
				backend.signalCode !== null
			) {
				app.exit(failed ? 1 : (backend?.exitCode ?? 0));
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
			backend.send({ type: "stop" }, (error) => {
				if (error && backend.exitCode === null && backend.signalCode === null)
					fail(
						"Could not request backend cleanup. Keep saved records and quit again after checking the backend.",
					);
			});
		})()
			.catch(() => {
				dialog.showErrorBox(
					"Weft could not quit",
					"Could not check active work. The application has been left running; try Quit again.",
				);
			})
			.finally(() => {
				quitPending = false;
				if (failed && !stopping) app.quit();
			});
	});
	app
		.whenReady()
		.then(() => {
			if (dataFailure) {
				fail(
					"Could not open the desktop data directory. Check its permissions and reopen Weft; no database was replaced.",
				);
				return;
			}
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
			startupTimer = setTimeout(
				() =>
					fail(
						"The desktop backend did not become ready. Check application resources and reopen Weft.",
					),
				30000,
			);
			backend.on("error", () =>
				fail(
					"Could not launch the bundled Node backend. Rebuild Weft and try again.",
				),
			);
			backend.on("exit", () => {
				clearTimeout(startupTimer);
				if (!stopping)
					fail(
						"The backend stopped unexpectedly. Reopen Weft to inspect saved history; operations are not replayed.",
					);
			});
			backend.on("message", (message) => {
				if (message.type === "failure") fail(message.message);
				if (message.type === "ready") {
					clearTimeout(startupTimer);
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
