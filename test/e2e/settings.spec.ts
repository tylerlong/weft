import { mkdir } from "node:fs/promises";
import { expect, test } from "./fixtures.ts";

for (const chinese of [false, true]) {
	const words = chinese
		? {
				settings: "设置",
				key: "OpenRouter API 密钥",
				save: "保存 API 密钥",
				saving: "保存中…",
				saved: "已保存",
				configured: "已配置",
				remove: "移除 API 密钥",
				close: "关闭",
				language: "语言",
				general: "常规",
				execution: "执行",
				models: "模型",
				error: "保存 API 密钥失败，请重试。",
			}
		: {
				settings: "Settings",
				key: "OpenRouter API key",
				save: "Save API key",
				saving: "Saving…",
				saved: "Saved",
				configured: "Configured",
				remove: "Remove API key",
				close: "Close",
				language: "Language",
				general: "General",
				execution: "Execution",
				models: "Models",
				error: "Unable to save API key. Please retry.",
			};
	test(`credential autosaves replacement and clearing (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.goto(app.url);
		await page
			.getByRole("button", { name: words.settings, exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: words.settings,
			exact: true,
		});
		await dialog.getByRole("tab", { name: words.models, exact: true }).click();
		const credentials = dialog.getByRole("region", {
			name: chinese ? "凭据" : "Credentials",
			exact: true,
		});
		const key = dialog.getByLabel(words.key, { exact: true });
		await expect(key).toHaveAttribute("type", "password");
		await expect(key).toHaveValue("zkey");
		await expect(
			credentials.getByText(words.configured, { exact: true }),
		).toHaveCount(0);
		const inputBox = await key.boundingBox();
		const modelsBox = await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.boundingBox();
		if (!inputBox || !modelsBox) throw new Error("Missing settings fields");
		expect(modelsBox.y - inputBox.y - inputBox.height).toBeLessThan(100);
		await expect(
			dialog.getByRole("button", { name: words.save, exact: true }),
		).toHaveCount(0);
		await expect(
			dialog.getByRole("button", { name: words.remove, exact: true }),
		).toHaveCount(0);
		let writes = 0;
		await page.route("**/api/model-settings", async (route) => {
			if (route.request().method() === "PUT") writes++;
			await route.continue();
		});
		await key.click();
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		expect(writes).toBe(0);
		await key.fill("replacement-secret");
		expect(writes).toBe(0);
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("status")).toHaveText(words.saved);
		await expect(key).toHaveValue("replacement-secret");
		expect(
			(
				await dialog
					.getByRole("heading", { name: words.models, exact: true })
					.boundingBox()
			)?.y,
		).toBe(modelsBox.y);
		expect(writes).toBe(1);
		if (process.env.SETTINGS_SCREENSHOTS) {
			await mkdir("/tmp/weft-122-evidence", { recursive: true });
			await page.screenshot({
				path: `/tmp/weft-122-evidence/credential-saved-${chinese ? "zh" : "en"}.png`,
			});
		}
		const failure = async (route: import("@playwright/test").Route) => {
			if (route.request().method() === "PUT")
				await route.fulfill({ status: 500, json: {} });
			else await route.fallback();
		};
		await page.route("**/api/model-settings", failure);
		await key.fill("failed-secret");
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("alert")).toHaveText(words.error);
		await expect(key).toHaveValue("failed-secret");
		if (process.env.SETTINGS_SCREENSHOTS)
			await page.screenshot({
				path: `/tmp/weft-122-evidence/credential-failure-${chinese ? "zh" : "en"}.png`,
			});
		await page.unroute("**/api/model-settings", failure);
		await key.fill("");
		await dialog
			.getByRole("heading", { name: words.models, exact: true })
			.click();
		await expect(credentials.getByRole("status")).toHaveText(words.saved);
		await expect(key).toHaveValue("");
		expect(writes).toBe(2);
	});

	test(`provider routing saves all priorities, supports keyboard and recovers from failure (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		const label = chinese ? "服务方路由" : "Provider routing";
		const choices = chinese
			? ["OpenRouter 默认", "最低价格", "最高吞吐量", "最低延迟"]
			: [
					"OpenRouter default",
					"Lowest price",
					"Highest throughput",
					"Lowest latency",
				];
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		const openModels = async () => {
			await page
				.getByRole("button", { name: words.settings, exact: true })
				.click();
			await page.getByRole("tab", { name: words.models, exact: true }).click();
		};
		await page.request.post(`${app.url}/api/model-catalog`);
		await page.request.post(`${app.url}/api/models`, {
			data: { id: "second" },
		});
		await page.goto(app.url);
		await openModels();
		const dialog = page.getByRole("dialog", {
			name: words.settings,
			exact: true,
		});
		const routing = dialog.getByRole("combobox", { name: label, exact: true });
		await expect(routing).toHaveValue("default");
		await expect(routing.getByRole("option")).toHaveText(choices);
		await expect(routing).toHaveAccessibleDescription(
			chinese
				? /吞吐量.*生成.*延迟.*开始响应/
				: /throughput.*token generation.*latency.*response startup/,
		);
		const savedRouting = async () =>
			(await (await page.request.get(`${app.url}/api/model-settings`)).json())
				.providerRouting;
		for (const priority of ["price", "throughput", "latency"]) {
			await expect(routing).toBeEnabled();
			await routing.selectOption(priority);
			await expect.poll(savedRouting).toBe(priority);
			await expect(routing).toHaveValue(priority);
		}
		await page.reload();
		await openModels();
		await expect(routing).toHaveValue("latency");
		await routing.focus();
		await expect(routing).toBeFocused();
		await routing.press("o");
		await routing.press("Enter");
		await expect.poll(savedRouting).toBe("default");
		await expect(routing).toHaveValue("default");
		const fail = async (route: import("@playwright/test").Route) => {
			if (route.request().method() === "PUT")
				await route.fulfill({ status: 500, json: {} });
			else await route.continue();
		};
		await page.route("**/api/model-settings", fail);
		await routing.selectOption("price");
		await expect(dialog.getByRole("alert")).toHaveText(
			chinese
				? "保存模型配置失败，请重试。"
				: "Unable to save model settings. Please retry.",
		);
		expect(await savedRouting()).toBe("default");
		await expect(routing).toHaveValue("default");
		await expect(dialog.getByText(words.saved, { exact: true })).toHaveCount(0);
		await dialog
			.getByRole("button", {
				name: chinese ? "将 Second 设为默认" : "Set Second as default",
				exact: true,
			})
			.click();
		await expect(dialog.getByRole("alert")).toHaveCount(1);
		await dialog
			.getByRole("button", { name: words.close, exact: true })
			.click();
		await expect(dialog).toBeVisible();
		await page.unroute("**/api/model-settings", fail);
		await dialog
			.getByRole("button", { name: words.close, exact: true })
			.click();
		await expect(dialog).toBeHidden();
		expect(await savedRouting()).toBe("price");
		expect(
			(await (await page.request.get(`${app.url}/api/model-settings`)).json())
				.defaultModelId,
		).toBe("second");
		await page.reload();
		await openModels();
		await expect(routing).toHaveValue("price");
	});

	test(`fixed Settings actions with long models and notices (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		const models = Array.from({ length: 14 }, (_, index) => ({
			id: `model-${index}-${"id".repeat(55)}`,
			name: `Model ${index} ${"long name ".repeat(15)}`,
		}));
		app.setCatalog(models);
		await page.request.post(`${app.url}/api/model-catalog`);
		for (const model of models)
			await page.request.post(`${app.url}/api/models`, {
				data: { id: model.id },
			});
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.route("**/api/model-catalog", (route) =>
			route.fulfill({ status: 500, json: {} }),
		);
		await page.goto(app.url);
		await page
			.getByRole("button", { name: words.settings, exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: words.settings,
			exact: true,
		});
		await expect(
			dialog.getByRole("heading", { name: words.language, exact: true }),
		).toBeVisible();
		await dialog.getByRole("tab", { name: words.models, exact: true }).click();
		await expect(
			dialog.getByRole("heading", { name: words.models, exact: true }),
		).toBeVisible();
		await expect(dialog.getByRole("alert")).toBeVisible();
		for (const size of [
			{ width: 1280, height: 720 },
			{ width: 1600, height: 1000 },
		]) {
			await page.setViewportSize(size);
			const bounds = await dialog.boundingBox();
			for (const tab of [words.general, words.execution, words.models]) {
				await dialog.getByRole("tab", { name: tab, exact: true }).click();
				expect(await dialog.boundingBox()).toEqual(bounds);
				if (process.env.SETTINGS_SCREENSHOTS) {
					await mkdir("/tmp/weft-121-evidence", { recursive: true });
					await page.screenshot({
						path: `/tmp/weft-121-evidence/${chinese ? "zh" : "en"}-${tab}-${size.width}.png`,
					});
				}
			}
			await dialog.locator(".settings-content:visible").evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			const heading = await dialog
				.getByRole("heading", { name: words.settings, exact: true })
				.boundingBox();
			const close = await dialog
				.getByRole("button", { name: words.close, exact: true })
				.boundingBox();
			if (!heading || !close) throw new Error("Missing dialog controls");
			expect(heading.y).toBeGreaterThan(0);
			expect(close.y + close.height).toBeLessThan(size.height);
			expect(
				await dialog.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
			if (process.env.SETTINGS_SCREENSHOTS)
				await mkdir("/tmp/weft-79-evidence", { recursive: true });
			if (process.env.SETTINGS_SCREENSHOTS)
				await page.screenshot({
					path: `/tmp/weft-79-evidence/settings-${chinese ? "zh" : "en"}-${size.width}.png`,
				});
		}
	});
}

test("required Settings identifies missing key, models and both", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Setup", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Setup" },
		})
	).json();
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(
		dialog.getByRole("tab", { name: "Models", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(
		dialog.getByText("An API key is required to use this chat.", {
			exact: true,
		}),
	).toBeVisible();
	const blockedRemoval = await page.request.delete(
		`${app.url}/api/models/test`,
	);
	expect(blockedRemoval.status()).toBe(400);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { apiKey: "setup-key" },
	});
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.delete(`${app.url}/api/models/test`);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await expect(
		dialog.getByText(
			"An API key and at least one enabled model are required to use this chat.",
			{ exact: true },
		),
	).toBeVisible();
	await dialog
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("new-secret");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		dialog.getByText("Enable at least one model to use this chat.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeEnabled();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
});

test("tabs retain failed credential drafts and Close deliberately retries on the affected tab", async ({
	page,
	app,
}) => {
	let discoveries = 0;
	await page.route("**/api/model-catalog", async (route) => {
		discoveries++;
		await route.continue();
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const general = dialog.getByRole("tab", { name: "General", exact: true });
	const models = dialog.getByRole("tab", { name: "Models", exact: true });
	const execution = dialog.getByRole("tab", { name: "Execution", exact: true });
	await models.click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	let writes = 0;
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes++;
		await route.fulfill({ status: 500, json: {} });
	});
	await key.fill("retained-draft");
	await execution.click();
	await expect(execution).toHaveAttribute("aria-selected", "true");
	await models.click();
	await expect(key).toHaveValue("retained-draft");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	const synchronized = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/model-settings") &&
			response.request().method() === "GET",
	);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { apiKey: "peer-secret" },
	});
	await synchronized;
	await expect(key).toHaveValue("retained-draft");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await general.click();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(models).toHaveAttribute("aria-selected", "true");
	await expect(dialog).toBeVisible();
	await expect(key).toHaveValue("retained-draft");
	expect(writes).toBe(2);
	expect(discoveries).toBe(1);
	if (process.env.SETTINGS_SCREENSHOTS) {
		await mkdir("/tmp/weft-122-evidence", { recursive: true });
		await page.screenshot({
			path: "/tmp/weft-122-evidence/credential-failure-en.png",
		});
	}
	await page.unroute("**/api/model-settings");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(general).toHaveAttribute("aria-selected", "true");
	await models.click();
	await expect(key).toHaveValue("retained-draft");
	await expect.poll(() => discoveries).toBe(2);
});

test("Close waits for a credential save and preserves a newer draft without duplicate writes", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	const writes: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes.push(route.request().postDataJSON().apiKey);
		if (writes.length === 1) await gate;
		await route.continue();
	});
	await key.fill("first-secret");
	await dialog.getByRole("heading", { name: "Models", exact: true }).click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(
		dialog
			.getByRole("region", { name: "Credentials", exact: true })
			.getByRole("status"),
	).toHaveText("Saving…");
	await expect(key).toBeEnabled();
	await key.fill("newer-secret");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(key).toHaveValue("newer-secret");
	expect(writes).toEqual(["first-secret"]);
	release();
	await expect(dialog).toBeHidden();
	expect(writes).toEqual(["first-secret", "newer-secret"]);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	await expect(key).toHaveValue("newer-secret");
});

test("initial setup saves a still-focused first credential through Close before gating", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Initial", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Initial" },
		})
	).json();
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await key.fill("first-setup-secret");
	await expect(key).toBeFocused();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(
		await (await page.request.get(`${app.url}/api/settings/credential`)).json(),
	).toEqual({ apiKey: "first-setup-secret" });
});

test("backdrop waits for credential persistence and keeps a failed draft open", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	let writes = 0;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		writes++;
		if (writes === 1) {
			await gate;
			await route.fulfill({ status: 500, json: {} });
		} else await route.continue();
	});
	await key.fill("failed-backdrop-secret");
	await page.mouse.click(1, 1);
	await expect.poll(() => writes).toBe(1);
	await expect(dialog).toBeVisible();
	release();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Unable to save API key. Please retry.",
	);
	await expect(key).toHaveValue("failed-backdrop-secret");
	await key.fill("corrected-backdrop-secret");
	await page.mouse.click(1, 1);
	await expect(dialog).toBeHidden();
	expect(writes).toBe(2);
	expect(
		await (await page.request.get(`${app.url}/api/settings/credential`)).json(),
	).toEqual({ apiKey: "corrected-backdrop-secret" });
});

test("Close hides the candidate portal while waiting for another tab to save", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let writes = 0;
	await page.route("**/api/execution-limits", async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		writes++;
		await gate;
		await route.continue();
	});
	await dialog.getByRole("tab", { name: "Execution", exact: true }).click();
	await dialog.getByLabel("Model Calls per Agent", { exact: true }).fill("7");
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	await expect.poll(() => writes).toBe(1);
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByRole("listbox", { name: "Available models", exact: true }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("listbox", { name: "Available models", exact: true }),
	).toHaveCount(0);
	expect(writes).toBe(1);
	release();
	await expect(dialog).toBeHidden();
	expect(writes).toBe(1);
});

test("Settings help supports reading, keyboard and deliberate dismissal", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const help = dialog.getByRole("button", {
		name: "Help: Enter key behavior",
		exact: true,
	});
	const text = dialog.getByRole("tooltip");
	await expect(text).toBeHidden();
	await help.hover();
	await expect(text).toContainText("Shift+Enter to insert a newline.");
	await text.hover();
	await expect(text).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(text).toBeHidden();
	await help.focus();
	await expect(text).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(text).toBeHidden();
	await expect(help).toBeFocused();
	await expect(dialog).toBeVisible();
	await help.click();
	await expect(text).toBeVisible();
	await help.click();
	await expect(text).toBeHidden();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

for (const chinese of [false, true]) {
	test(`all Settings guidance is available on demand with visible cautions (${chinese ? "zh" : "en"})`, async ({
		page,
		app,
	}) => {
		if (chinese)
			await page.request.put(`${app.url}/api/language`, {
				data: { language: "zh-CN" },
			});
		await page.goto(app.url);
		await page
			.getByRole("button", { name: chinese ? "设置" : "Settings", exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: chinese ? "设置" : "Settings",
			exact: true,
		});
		const prefix = chinese ? "帮助：" : "Help: ";
		const tabs = chinese
			? ["常规", "模型", "执行", "MCP"]
			: ["General", "Models", "Execution", "MCP"];
		const guidance = chinese
			? [
					[
						["Enter 键行为", "Shift+Enter 插入换行。"],
						["后续发送行为", "排队"],
					],
					[
						["OpenRouter API 密钥", "离开此输入框时自动保存。清空可移除密钥。"],
						["模型", "默认模型用于新对话"],
						["服务方路由", "偏好不限制费用、不排除服务方，也不保证性能。"],
					],
					[
						["Jev 安全审核", "更改从下一次工具调用生效。"],
						["执行上限", "已经开始的工作会继续执行。"],
						[
							"每个 Agent 的模型调用上限",
							"每个子 Agent 分别计算自己的调用次数。",
						],
						["每个根 Agent 的子 Agent 总量上限", "根 Agent 本身不计入。"],
					],
					[
						["MCP", "Agent"],
						["添加 Jira 模板", "JIRA_PERSONAL_TOKEN"],
						["连接 JSON", "startup_timeout_sec"],
					],
				]
			: [
					[
						["Enter key behavior", "Shift+Enter to insert a newline."],
						["Follow-up behavior", "Queue"],
					],
					[
						[
							"OpenRouter API key",
							"Saves when you leave this field. Clear it to remove the key.",
						],
						[
							"Models",
							"The default is used for new chats and chats without a model.",
						],
						[
							"Provider routing",
							"Preferences do not limit spending, exclude providers or guarantee performance.",
						],
					],
					[
						["Jev safety review", "changes apply to the next Tool Call."],
						["Execution limits", "work already started continues."],
						["Model Calls per Agent", "Each sub-agent has its own limit."],
						["Descendants per root Agent", "the root Agent does not."],
					],
					[
						["MCP", "Agent"],
						["Add Jira template", "JIRA_PERSONAL_TOKEN"],
						["Connection JSON", "startup_timeout_sec"],
					],
				];
		for (const [index, tab] of tabs.entries()) {
			await dialog.getByRole("tab", { name: tab, exact: true }).click();
			if (index === 3)
				await dialog
					.getByRole("button", {
						name: chinese ? "添加 Jira 模板" : "Add Jira template",
						exact: true,
					})
					.click();
			await expect(dialog.getByRole("tooltip")).toHaveCount(0);
			await expect(
				dialog.getByRole("button", { name: new RegExp(`^${prefix}`) }),
			).toHaveCount(guidance[index].length);
			if (index === 2)
				await expect(
					dialog.getByText(
						chinese
							? "审核仅尽力判断，无法保证安全。"
							: "Review is best effort and cannot guarantee safety.",
						{ exact: true },
					),
				).toBeVisible();
			if (index === 3)
				await expect(
					dialog.getByText(
						chinese
							? /审核无法看到外部服务内部的所有影响/
							: /review cannot see all effects inside external services/,
					),
				).toBeVisible();
			for (const [label, content] of guidance[index]) {
				const help = dialog.getByRole("button", {
					name: `${prefix}${label}`,
					exact: true,
				});
				await help.click();
				const tooltip = dialog.getByRole("tooltip");
				await expect(tooltip).toContainText(content);
				if (label === "Connection JSON" || label === "连接 JSON") {
					const before = await help.boundingBox();
					await dialog
						.locator(".settings-content:visible")
						.evaluate((element) => element.scrollBy(0, 12));
					await expect(async () => {
						await expect(tooltip).toBeVisible();
						const anchor = await help.boundingBox();
						const box = await tooltip.boundingBox();
						const bounds = await dialog.boundingBox();
						if (!before || !anchor || !box || !bounds)
							throw new Error("Missing scrolled help layout");
						expect(anchor.y).toBeLessThan(before.y);
						expect(
							Math.min(
								Math.abs(box.y - anchor.y - anchor.height),
								Math.abs(box.y + box.height - anchor.y),
							),
						).toBeLessThan(1);
						expect(box.x).toBeGreaterThanOrEqual(bounds.x);
						expect(box.x + box.width).toBeLessThanOrEqual(
							bounds.x + bounds.width,
						);
					}).toPass({ timeout: 5000 });
				}
				await expect(help).toHaveAccessibleDescription(
					new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				);
				await page.keyboard.press("Escape");
				await expect(tooltip).toBeHidden();
				await expect(dialog).toBeVisible();
			}
		}
	});
}

test("long Settings help stays within the dialog after scrolling and resizing", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
	await dialog
		.getByRole("button", { name: "Add Jira template", exact: true })
		.click();
	const help = dialog.getByRole("button", {
		name: "Help: Add Jira template",
		exact: true,
	});
	await help.click();
	const tooltip = dialog.getByRole("tooltip");
	for (const size of [
		{ width: 1280, height: 720 },
		{ width: 1600, height: 1000 },
	]) {
		await page.setViewportSize(size);
		await expect(tooltip).toBeVisible();
		await expect(async () => {
			const bounds = await dialog.boundingBox();
			const box = await tooltip.boundingBox();
			const footer = await dialog
				.getByRole("button", { name: "Close", exact: true })
				.boundingBox();
			if (!bounds || !box || !footer) throw new Error("Missing help layout");
			expect(box.x).toBeGreaterThanOrEqual(bounds.x);
			expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
			expect(box.y).toBeGreaterThanOrEqual(bounds.y);
			expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
		}).toPass({ timeout: 5000 });
		await tooltip.hover();
		await page.waitForTimeout(1200);
		await expect(tooltip).toBeVisible();
	}
	if (process.env.SETTINGS_SCREENSHOTS)
		await page.screenshot({ path: "/tmp/weft-208-help.png" });
	await dialog.getByRole("tab", { name: "General", exact: true }).click();
	await expect(tooltip).toBeHidden();
	await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
	await expect(tooltip).toBeHidden();
	await help.click();
	await dialog.getByRole("heading", { name: "MCP", exact: true }).click();
	await expect(tooltip).toBeHidden();
	await help.click();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("help preserves drafts, descriptions and disabled-control access", async ({
	page,
	app,
}) => {
	await page.route("**/api/safety-review", (route) =>
		route.fulfill({ status: 500, json: {} }),
	);
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	const enter = dialog.getByRole("combobox", {
		name: "Enter key behavior",
		exact: true,
	});
	await expect(enter).toHaveAccessibleDescription(
		/Shift\+Enter.*Ctrl\+Enter|Shift\+Enter.*⌘\+Enter/,
	);
	await enter.focus();
	await page.keyboard.press("Shift+Tab");
	const enterHelp = dialog.getByRole("button", {
		name: "Help: Enter key behavior",
		exact: true,
	});
	await expect(enterHelp).toBeFocused();
	await expect(enterHelp).toHaveCSS("outline-style", "solid");
	await expect(dialog.getByRole("tooltip")).toBeVisible();
	await dialog.getByRole("tab", { name: "Execution", exact: true }).click();
	await expect(
		dialog.getByRole("checkbox", { name: "Jev safety review", exact: true }),
	).toBeDisabled();
	await expect(dialog.getByRole("alert")).toContainText(
		"Could not read or save safety review.",
	);
	await dialog
		.getByRole("button", { name: "Help: Jev safety review", exact: true })
		.click();
	await expect(dialog.getByRole("tooltip")).toContainText(
		"Review every Tool Call",
	);
	await dialog.getByRole("tab", { name: "Models", exact: true }).click();
	const key = dialog.getByLabel("OpenRouter API key", { exact: true });
	await expect(key).toHaveAccessibleDescription(
		"Saves when you leave this field. Clear it to remove the key.",
	);
	let writes = 0;
	await page.route("**/api/model-settings", async (route) => {
		if (route.request().method() === "PUT") writes++;
		await route.continue();
	});
	await key.fill("unsaved-draft");
	const help = dialog.getByRole("button", {
		name: "Help: OpenRouter API key",
		exact: true,
	});
	await help.click();
	await expect(key).toBeFocused();
	await expect(key).toHaveValue("unsaved-draft");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await expect(key).toBeFocused();
	expect(writes).toBe(0);
});

test.describe("touch help", () => {
	test.use({ hasTouch: true });
	test("tap opens and dismisses Settings help", async ({ page, app }) => {
		await page.goto(app.url);
		await page.getByRole("button", { name: "Settings", exact: true }).tap();
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		const help = dialog.getByRole("button", {
			name: "Help: Enter key behavior",
			exact: true,
		});
		await help.tap();
		await expect(dialog.getByRole("tooltip")).toContainText("Shift+Enter");
		await help.tap();
		await expect(dialog.getByRole("tooltip")).toBeHidden();
		await expect(dialog).toBeVisible();
	});
});

test("removing an MCP service removes its help without errors", async ({
	page,
	app,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
	await dialog
		.getByRole("button", { name: "Add service", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Help: Connection JSON", exact: true })
		.click();
	await expect(dialog.getByRole("tooltip")).toContainText("Use command/args");
	await dialog
		.getByRole("button", { name: "Remove service", exact: true })
		.click();
	await expect(dialog.getByRole("tooltip")).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Help: Connection JSON", exact: true }),
	).toHaveCount(0);
	expect(errors).toEqual([]);
});
