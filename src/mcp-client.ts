import { StringDecoder } from "node:string_decoder";
import {
	Client,
	ProtocolError,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ToolExecution, ToolReview } from "./file-tools.ts";
import { type InputContent, submittedImages } from "./image-content.ts";
import { type McpService, parseMcpConfig } from "./mcp-config.ts";
import { prepareMcp } from "./mcp-prerequisites.ts";
import { ModelError } from "./openrouter.ts";

export type McpConnection = {
	id: string;
	name: string;
	status: "connecting" | "connected" | "closed" | "error";
	error?: string;
	stderr?: string;
};
export type McpTool = {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};
export const mcpStartupTool: McpTool = {
	type: "function",
	name: "mcp_startup",
	description:
		"Start or reconnect one enabled MCP service for this Agent using latest saved Settings. Replaces this Agent's old tools/client before startup; failure leaves no old tools or credentials. Bounded initialization and complete discovery refresh the next model request. Does not replay business calls or change Settings. Known deterministic prerequisite preparation is part of this operation; Weft may start an existing stopped supported runtime, but never restarts running infrastructure, installs software or changes system configuration. The user-configured program itself is trusted external code with the current user's full access and may have arbitrary startup effects; its opaque arguments can contain credentials and are not exported to models. Credentials remain local.",
	parameters: {
		type: "object",
		properties: { service_id: { type: "string" } },
		required: ["service_id"],
		additionalProperties: false,
	},
};
type McpClientResource = {
	client: Client;
	transport?: StreamableHTTPClientTransport;
	close?: Promise<void>;
};
export async function connectMcp(
	services: McpService[],
	readServices: () => McpService[],
	signal: AbortSignal,
	report: (connections: McpConnection[]) => void,
) {
	const connections: McpConnection[] = [];
	const resources = new Map<string, McpClientResource>();
	const tools = new Map<string, McpTool>();
	const owners = new Map<string, string>();
	const handlers = new Map<
		string,
		(
			args: string,
			imagesSupported: boolean,
			review?: ToolReview,
		) => Promise<ToolExecution>
	>();
	let sequence = 0;
	let closing: Promise<void> | undefined;
	const update = () => {
		if (connections.length) report(connections);
	};
	const removeTools = (id: string) => {
		for (const [name, owner] of owners)
			if (owner === id) {
				tools.delete(name);
				handlers.delete(name);
				owners.delete(name);
			}
	};
	const closeResource = (resource: McpClientResource) => {
		if (!resource.close)
			resource.close = (async () => {
				if (resource.transport) {
					const transport = resource.transport;
					const timeout = setTimeout(() => void transport.close(), 1000);
					try {
						await transport.terminateSession();
					} catch {
					} finally {
						clearTimeout(timeout);
					}
				}
				await resource.client.close();
			})();
		return resource.close;
	};
	const close = () => {
		if (!closing)
			closing = (async () => {
				await Promise.allSettled([...resources.values()].map(closeResource));
				for (const connection of connections)
					if (connection.status !== "error") connection.status = "closed";
				update();
			})();
		return closing;
	};
	const cancelled = () => {
		void close().catch(() => {});
	};
	signal.addEventListener("abort", cancelled, { once: true });
	const startup = async (service: McpService) => {
		const serviceId = service.id;
		signal.throwIfAborted();
		if (closing) throw new Error("MCP manager closed");
		if (!service?.enabled)
			throw new Error(
				"MCP service disabled or deleted; startup was not executed",
			);
		removeTools(serviceId);
		const old = resources.get(serviceId);
		if (old) {
			resources.delete(serviceId);
			await closeResource(old);
		}
		signal.throwIfAborted();
		const previous = connections.findIndex((row) => row.id === serviceId);
		const connection: McpConnection = {
			id: service.id,
			name: service.name,
			status: "connecting",
		};
		if (previous === -1) connections.push(connection);
		else connections[previous] = connection;
		update();
		const client = new Client({ name: "Weft", version: "1.0.0" });
		const resource: McpClientResource = { client };
		resources.set(serviceId, resource);
		client.onerror = (error) => {
			if (resource.close) return;
			connection.error = String(error);
			connection.status = "error";
			update();
		};
		client.onclose = () => {
			if (connection.status !== "error") connection.status = "closed";
			if (resources.get(serviceId) === resource) removeTools(serviceId);
			update();
		};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let startupSignal: AbortSignal | undefined;
		try {
			const config = parseMcpConfig(service.config, service.env);
			const controller = new AbortController();
			startupSignal = AbortSignal.any([signal, controller.signal]);
			timeout = setTimeout(
				() => controller.abort(new Error("MCP service startup timed out")),
				config.startup_timeout_sec * 1000,
			);
			const abortStartup = () => {
				void closeResource(resource).catch(() => {});
			};
			startupSignal.addEventListener("abort", abortStartup, { once: true });
			try {
				startupSignal.throwIfAborted();
				if (!readServices().some((row) => row.id === serviceId && row.enabled))
					throw new Error(
						"MCP service disabled or deleted; startup was not executed",
					);
				await prepareMcp(config, service.env, startupSignal, (text) => {
					connection.stderr = (connection.stderr ?? "") + text;
					update();
				});
				startupSignal.throwIfAborted();
				if (!readServices().some((row) => row.id === serviceId && row.enabled))
					throw new Error(
						"MCP service disabled or deleted; startup was not executed",
					);
				const transport =
					"url" in config
						? new StreamableHTTPClientTransport(new URL(config.url), {
								requestInit: { headers: config.http_headers },
							})
						: new StdioClientTransport({
								command: config.command,
								args: config.args,
								env: Object.fromEntries(
									service.env.map(({ name, value }) => [name, value]),
								),
								stderr: "pipe",
							});
				if (transport instanceof StreamableHTTPClientTransport)
					resource.transport = transport;
				const stderrDecoder = new StringDecoder("utf8");
				const stderr =
					transport instanceof StdioClientTransport ? transport.stderr : null;
				stderr?.on("data", (chunk: Buffer) => {
					connection.stderr =
						(connection.stderr ?? "") + stderrDecoder.write(chunk);
					update();
				});
				stderr?.on("end", () => {
					connection.stderr = (connection.stderr ?? "") + stderrDecoder.end();
					update();
				});
				await client.connect(transport, {
					timeout: config.startup_timeout_sec * 1000,
					signal: startupSignal,
				});
				const pendingTools: McpTool[] = [];
				const pendingHandlers = new Map<
					string,
					(
						args: string,
						imagesSupported: boolean,
						review?: ToolReview,
					) => Promise<ToolExecution>
				>();
				const cursors = new Set<string>();
				let cursor: string | undefined;
				do {
					const page = await client.listTools(cursor ? { cursor } : {}, {
						signal: startupSignal,
						cacheMode: "refresh",
					});
					for (const tool of page.tools) {
						const name = `mcp_tool_${sequence++}`;
						pendingTools.push({
							type: "function",
							name,
							description: `[MCP ${service.name}: ${tool.name}] ${tool.description ?? ""}`,
							parameters: tool.inputSchema,
						});
						pendingHandlers.set(name, async (args, imagesSupported, review) => {
							const enabled = () =>
								readServices().some(
									(row) => row.id === service.id && row.enabled,
								);
							const disabled = {
								status: "failed" as const,
								result: JSON.stringify({
									mcpError: {
										kind: "disabled",
										service: service.name,
										message:
											"MCP service disabled or deleted; call was not executed",
									},
								}),
							};
							const available = () =>
								!resource.close && resources.get(service.id)?.client === client;
							const unavailable: ToolExecution = {
								status: "failed",
								result: "MCP service unavailable; explicitly start it again",
							};
							if (!enabled()) return disabled;
							if (!available()) return unavailable;
							try {
								const argumentsValue: unknown = JSON.parse(args);
								if (
									!argumentsValue ||
									typeof argumentsValue !== "object" ||
									Array.isArray(argumentsValue)
								)
									throw new TypeError("MCP tool arguments must be an object");
								await review?.({
									name: tool.name,
									description: `[MCP ${service.name}] ${tool.description ?? ""}`,
									arguments: argumentsValue,
									execution: { service: service.name },
								});
								signal.throwIfAborted();
								if (!enabled()) return disabled;
								if (!available()) return unavailable;
								// Supplying the discovered definition prevents the SDK's modern-header refresh/replay path.
								const result = await client.callTool(
									{
										name: tool.name,
										arguments: argumentsValue as Record<string, unknown>,
									},
									{ signal, toolDefinition: tool },
								);
								const content: InputContent[] = [];
								for (const block of result.content) {
									if (block.type === "image" && imagesSupported) {
										try {
											const images = submittedImages([
												{
													type: "input_image",
													image_url: `data:${block.mimeType};base64,${block.data}`,
												},
											]);
											const { data: _data, ...metadata } = block;
											content.push(
												{
													type: "input_text",
													text: JSON.stringify({ mcpImage: metadata }),
												},
												...images,
											);
											continue;
										} catch {
											/* Preserve unsupported image bytes below. */
										}
									}
									content.push({
										type: "input_text",
										text: JSON.stringify({
											mcpContent: block,
											...(!["text", "image"].includes(block.type)
												? {
														notice:
															block.type === "resource_link"
																? "Resource link only; resource has not been read"
																: "Unsupported MCP content retained as data",
													}
												: block.type === "image"
													? {
															notice: imagesSupported
																? "Unsupported image retained as data"
																: "Current model does not support image input; image retained as data",
														}
													: {}),
										}),
									});
								}
								const { content: _content, ...metadata } = result;
								content.push({
									type: "input_text",
									text: JSON.stringify({ mcpResult: metadata }),
								});
								return {
									status: result.isError ? "failed" : "succeeded",
									result: content,
								};
							} catch (error) {
								if (
									error instanceof ModelError &&
									(error.code === "modelCallLimit" ||
										error.code === "answerWriteFailed")
								)
									throw error;
								return {
									status: "failed",
									result: JSON.stringify({
										mcpError: {
											kind:
												error instanceof ProtocolError
													? "protocol"
													: error instanceof SyntaxError ||
															error instanceof TypeError
														? "input"
														: "connection",
											message: String(error),
											...(error instanceof Error && "code" in error
												? { code: error.code }
												: {}),
											...(error instanceof Error && "data" in error
												? { data: error.data }
												: {}),
										},
									}),
								};
							}
						});
					}
					cursor = page.nextCursor;
					if (cursor && cursors.has(cursor))
						throw new Error("MCP discovery repeated a pagination cursor");
					if (cursor) cursors.add(cursor);
				} while (cursor);
				startupSignal.throwIfAborted();
				if (connection.status !== "connecting")
					throw new Error(
						connection.error ?? "MCP client closed during discovery",
					);
				connection.status = "connected";
				for (const tool of pendingTools) {
					tools.set(tool.name, tool);
					owners.set(tool.name, service.id);
				}
				for (const [name, handler] of pendingHandlers)
					handlers.set(name, handler);
				update();
			} finally {
				startupSignal.removeEventListener("abort", abortStartup);
			}
		} catch (error) {
			connection.status = "error";
			connection.error = String(
				startupSignal?.aborted ? startupSignal.reason : error,
			);
			removeTools(serviceId);
			await closeResource(resource).catch(() => {});
			update();
		} finally {
			clearTimeout(timeout);
		}
		return connection;
	};
	if (signal.aborted) await close();
	else
		await Promise.all(
			services
				.filter((service) => service.enabled)
				.map((service) => startup(service)),
		);
	return {
		startup: (reviewed: McpService) => {
			const current = readServices().find(
				(service) => service.id === reviewed.id,
			);
			if (!current?.enabled)
				throw new Error(
					"MCP service disabled or deleted; startup was not executed",
				);
			if (JSON.stringify(current) !== JSON.stringify(reviewed))
				throw new Error(
					"MCP service Settings changed during review; request mcp_startup again to review the latest configuration. Existing client was not replaced",
				);
			return startup(current);
		},
		tools: () =>
			[...tools.values()].filter((tool) =>
				readServices().some(
					(service) => service.id === owners.get(tool.name) && service.enabled,
				),
			),
		connections,
		has: (name: string) => handlers.has(name),
		execute: (
			name: string,
			args: string,
			imagesSupported: boolean,
			review?: ToolReview,
		) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error("Unknown MCP tool");
			return handler(args, imagesSupported, review);
		},
		close: async () => {
			signal.removeEventListener("abort", cancelled);
			await close();
		},
	};
}
