import type { Locator } from "@playwright/test";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const padding = "Surrounding content.\n\n".repeat(20);
const appTable = (columns: number) =>
	[
		`| ${Array.from({ length: columns }, (_, i) => `Column ${i + 1}`).join(" | ")} |`,
		`| ${Array(columns).fill("---").join(" | ")} |`,
		...Array.from(
			{ length: 8 },
			(_, i) =>
				`| App ${i + 1} | ${Array(columns - 1)
					.fill("Description")
					.join(" | ")} |`,
		),
	].join("\n");
const cases = [
	{
		name: "eight-app table",
		selector: "table",
		index: 0,
		wide: false,
		text: appTable(2),
	},
	{
		name: "wide table",
		selector: "table",
		index: 1,
		wide: true,
		text: appTable(32),
	},
	{
		name: "code block",
		selector: "pre",
		index: 0,
		wide: false,
		text: "```\nshort code\n```",
	},
	{
		name: "wide code block",
		selector: "pre",
		index: 1,
		wide: true,
		text: `\`\`\`\n${"long code ".repeat(60)}\n\`\`\``,
	},
];
const text =
	padding + cases.map((value) => `${value.text}\n\n${padding}`).join("");

async function align(block: Locator) {
	return block.evaluate(async (el) => {
		const region = el.closest("section");
		if (!region) throw new Error("Missing surrounding view");
		region.scrollTop +=
			el.getBoundingClientRect().top - region.getBoundingClientRect().top - 120;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		return region.scrollTop;
	});
}

for (const details of [false, true]) {
	for (const reasoning of [false, true]) {
		test(`${details ? "Agent details" : "Chat"} ${reasoning ? "reasoning" : "answer"} scrolls over Markdown tables and code`, async ({
			page,
			app,
		}) => {
			const project = await (
				await page.request.post(`${app.url}/api/projects`, {
					data: { name: "Markdown scrolling", folders: [] },
				})
			).json();
			const chat = await (
				await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
					data: { name: "Read apps" },
				})
			).json();
			const stream = app.rawStreamModel();
			const accepted = await (
				await page.request.post(`${app.url}/api/chats/${chat.id}`, {
					data: { prompt: "List eight apps" },
				})
			).json();
			stream.push(
				completedBody({
					output: [
						{
							id: "reason",
							type: "reasoning",
							content: [{ type: "reasoning_text", text }],
						},
						{
							id: "answer",
							type: "message",
							content: [{ type: "output_text", text }],
						},
					],
				}),
			);
			stream.end();
			await page.setViewportSize({ width: 1280, height: 720 });
			await page.goto(
				`${app.url}/?chat=${chat.id}${details ? `&agent=${accepted.agentId}` : ""}`,
			);
			const view = page.getByRole("region", {
				name: details ? "Agent details" : "Chat",
				exact: true,
			});
			if (reasoning)
				await view.getByRole("button", { name: /^Reasoning/ }).click();
			const output = view.locator(`[data-output-index="${reasoning ? 0 : 1}"]`);
			await expect(output.getByRole("table")).toHaveCount(2);
			for (const value of cases) {
				await test.step(value.name, async () => {
					const block = output.locator(value.selector).nth(value.index);
					const size = await block.evaluate((el) => ({
						width: el.clientWidth,
						fullWidth: el.scrollWidth,
						height: el.clientHeight,
						fullHeight: el.scrollHeight,
					}));
					if (value.wide) expect(size.fullWidth).toBeGreaterThan(size.width);
					else expect(size.fullWidth).toBeLessThanOrEqual(size.width);
					expect(size.fullHeight).toBeLessThanOrEqual(size.height + 1);
					const beforeBlank = await align(block);
					const bounds = await view.boundingBox();
					if (!bounds) throw new Error("Missing view bounds");
					await page.mouse.move(bounds.x + 8, bounds.y + 160);
					await page.mouse.wheel(0, 80);
					await expect
						.poll(() => view.evaluate((el) => el.scrollTop))
						.toBeCloseTo(beforeBlank + 80, 0);

					for (const edge of value.wide ? ["right", "left"] : ["left"]) {
						const before = await align(block);
						await block.hover({ position: { x: 50, y: 12 } });
						if (value.wide) {
							await page.mouse.wheel(edge === "right" ? 100000 : -100000, 0);
							await expect
								.poll(() => block.evaluate((el) => el.scrollLeft))
								.toBe(edge === "right" ? size.fullWidth - size.width : 0);
							// Reaching the far edge exposes the initially clipped columns/long line.
							expect(await view.evaluate((el) => el.scrollTop)).toBe(before);
						}
						await page.mouse.wheel(0, 80);
						await expect
							.poll(() => view.evaluate((el) => el.scrollTop))
							.toBeCloseTo(before + 80, 0);
						await align(block);
						await block.hover({ position: { x: 50, y: 12 } });
						await page.mouse.wheel(0, -80);
						await expect
							.poll(() => view.evaluate((el) => el.scrollTop))
							.toBeCloseTo(before - 80, 0);
					}
				});
			}
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(1280);
			expect(await view.evaluate((el) => el.scrollLeft)).toBe(0);
		});
	}
}
