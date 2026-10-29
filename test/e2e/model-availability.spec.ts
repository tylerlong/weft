import {
	chatPicker,
	expectEffort,
	expectModel,
	openChatPicker,
	selectEffort,
} from "./chat-picker.ts";
import { expect, test } from "./fixtures.ts";

test("credentials remain editable while model editing is disabled without a key", async ({
	page,
	app,
}) => {
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(
		settings.getByLabel("OpenRouter API key", { exact: true }),
	).toBeEnabled();
	await expect(
		settings.getByRole("button", { name: "Add model", exact: true }),
	).toBeDisabled();
	await expect(
		settings.getByRole("button", { name: "Remove model Test", exact: true }),
	).toBeDisabled();
	await expect(
		settings.getByText("Save an API key to discover available models.", {
			exact: true,
		}),
	).toBeVisible();
	await settings
		.getByLabel("OpenRouter API key", { exact: true })
		.fill("new-key");
	await settings.getByRole("heading", { name: "Models", exact: true }).click();
	await expect(
		settings.getByRole("button", { name: "Add model", exact: true }),
	).toBeEnabled();
});

test("shared discovery disables editing, preserves Chat choices, and offers explicit Retry recovery", async ({
	page,
	app,
}) => {
	await page.request.post(`${app.url}/api/model-catalog`);
	await page.request.post(`${app.url}/api/models`, { data: { id: "second" } });
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Availability", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Preserved" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await selectEffort(page, "high");
	const peer = await page.context().newPage();
	await peer.goto(`${app.url}/?chat=${chat.id}`);
	app.failCatalog();
	const held = app.holdCatalog();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Models", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await held.entered;
	await expect(
		settings.getByText("Discovering available models…", { exact: true }),
	).toBeVisible();
	await expect(
		settings.getByRole("button", { name: "Add model", exact: true }),
	).toBeDisabled();
	await expect(
		settings.getByRole("button", { name: "Remove model Test", exact: true }),
	).toBeDisabled();
	await expect(chatPicker(peer)).toBeDisabled();
	await expectModel(peer, "test");
	await expectEffort(peer, "high");
	await expect(
		peer.getByText("Unavailable for this API key", { exact: true }),
	).toHaveCount(0);
	held.release();
	await expect(settings.getByRole("alert")).toContainText(
		"Unable to discover available models.",
	);
	await expect(
		settings.getByLabel("OpenRouter API key", { exact: true }),
	).toBeEnabled();
	await expect(
		settings.getByText("Unavailable for this API key", { exact: true }),
	).toHaveCount(0);
	await expect(chatPicker(peer)).toBeDisabled();
	await peer
		.getByLabel("Prompt", { exact: true })
		.fill("Discovery does not block submission");
	await peer.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(peer.getByRole("log")).toContainText("Test answer");
	app.setCatalog([{ id: "second", name: "Second" }]);
	const retry = settings.getByRole("button", { name: "Retry", exact: true });
	await retry.focus();
	await page.keyboard.press("Enter");
	await expect(settings.getByRole("alert")).toHaveCount(0);
	await expect(
		settings.getByText("Unavailable for this API key", { exact: true }),
	).toBeVisible();
	await expect(
		settings.getByRole("button", { name: "Remove model Test", exact: true }),
	).toBeEnabled();
	await expect(
		settings.getByRole("button", {
			name: "Set Second as default",
			exact: true,
		}),
	).toBeEnabled();
	await expectModel(peer, "test");
	await expectEffort(peer, "high");
	const popup = await openChatPicker(peer);
	await expect(
		popup.getByRole("radio", { name: "Test", exact: true }),
	).toBeDisabled();
	await expect(
		popup.getByRole("radio", { name: "Second", exact: true }),
	).toBeEnabled();
	await expect(
		popup.getByRole("radio", { name: "High", exact: true }),
	).toBeDisabled();
	await peer.keyboard.press("Escape");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		page
			.getByRole("dialog", { name: "设置", exact: true })
			.getByText("此 API 密钥不可用", { exact: true }),
	).toBeVisible();
	app.setCatalog([]);
	await page.request.post(`${app.url}/api/model-catalog`);
	await expect(
		page
			.getByRole("dialog", { name: "设置", exact: true })
			.getByText("此 API 密钥未返回可用的文本模型。", { exact: true }),
	).toBeVisible();
	await peer.close();
});

test("discovery metadata changes preserve saved Chat reasoning across reload", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Metadata", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Reasoning" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await selectEffort(page, "high");
	app.setCatalog([
		{ id: "test", name: "Test", reasoning: { supported_efforts: ["low"] } },
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	await expectEffort(page, "high");
	await page.reload();
	await expectEffort(page, "high");
	const saved = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(saved.chatOptions).toEqual({
		modelId: "test",
		reasoningEffort: "high",
	});
	const popup = await openChatPicker(page);
	await expect(
		popup.getByRole("radio", { name: "High", exact: true }),
	).toHaveCount(0);
	await expect(
		popup.getByRole("radio", { name: "Low", exact: true }),
	).toBeEnabled();
});
