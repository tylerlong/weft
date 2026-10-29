import { guardrailRejection } from "../model-error-fixture.ts";
import { expectEffort, expectModel, selectModel } from "./chat-picker.ts";
import { expect, test } from "./fixtures.ts";

test("guardrail rejection shows safe localized diagnostics and recovers after an explicit replacement", async ({
	page,
	app,
}) => {
	const blocked = "deepseek/deepseek-v4.1-flash-1017";
	app.setCatalog([
		{ id: blocked, name: blocked, reasoning: { supported_efforts: ["high"] } },
		{ id: "second", name: "Second" },
	]);
	await page.request.post(`${app.url}/api/model-catalog`);
	for (const id of [blocked, "second"]) {
		const response = await page.request.post(`${app.url}/api/models`, {
			data: { id },
		});
		expect(response.ok()).toBeTruthy();
	}
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Errors", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Recovery" },
		})
	).json();
	await page.request.put(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: blocked, reasoningEffort: "high" },
	});
	const before = await (
		await page.request.get(`${app.url}/api/model-settings`)
	).json();
	const rejection = guardrailRejection("zkey");
	rejection.error.message +=
		' <img src=x onerror="window.providerScriptRan=true">';
	app.failModel("http", JSON.stringify(rejection), 404);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expectModel(page, blocked);
	await expectEffort(page, "high");
	await page.getByLabel("Prompt").fill("Use the saved model");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	const log = page.getByRole("log");
	await expect(log.getByRole("alert")).toContainText(
		"OpenRouter rejected this request.",
	);
	await expect(log.getByRole("alert")).toContainText(
		"Model blocked by guardrail: 40 endpoints excluded.",
	);
	await expect(log.getByRole("alert")).toContainText("[REDACTED]");
	await expect(log).not.toContainText("zkey");
	await expect(log.locator("img")).toHaveCount(0);
	expect(await page.evaluate(() => "providerScriptRan" in window)).toBe(false);
	const response = log
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response \d+/ }) });
	await expect(response).toHaveCount(1);
	await response.locator("summary").click();
	await expect(response).toContainText("HTTP 404");
	await expect(response).toContainText(
		'"failed_routing_step": "Filter by Guardrails"',
	);
	await expect(response).toContainText("model-ignored-by-guardrail");
	await expect(response).not.toContainText("zkey");
	await expectModel(page, blocked);
	await expectEffort(page, "high");
	const after = await (
		await page.request.get(`${app.url}/api/model-settings`)
	).json();
	expect(after.models).toEqual(before.models);
	expect(after.defaultModelId).toBe(before.defaultModelId);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(log.getByRole("alert")).toContainText(
		"OpenRouter 拒绝了本次请求。",
	);
	await expect(log.getByRole("alert")).toContainText(
		"Model blocked by guardrail",
	);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "en" },
	});
	await expect(page.getByLabel("Prompt")).toBeEnabled();
	await selectModel(page, "second");
	await page.getByLabel("Prompt").fill("Continue with a replacement");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(log).toContainText("Test answer");
	await expect(log).toContainText("Use the saved model");
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(
		history.agents.map((agent: { status: string }) => agent.status),
	).toEqual(["failed", "succeeded"]);
	expect(
		history.agents.map((agent: { calls: unknown[] }) => agent.calls.length),
	).toEqual([1, 1]);
});
