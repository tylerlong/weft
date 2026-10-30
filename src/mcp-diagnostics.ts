import type { McpConnection } from "./mcp-client.ts";
import { type McpService, parseMcpConfig } from "./mcp-config.ts";

export const mcpDiagnosticsTool = {
	type: "function" as const,
	name: "mcp_diagnostics",
	description:
		"Inspect current saved MCP service configuration and this Agent's actual runtime state, errors and stderr. Optionally select a stable service_id; omit it to list all configured services. Never returns credential values or HTTP header values. Does not connect, edit Settings, or replay operations. Use this supported tool instead of inspecting Weft's operational database.",
	parameters: {
		type: "object",
		properties: { service_id: { type: "string" } },
		additionalProperties: false,
	},
};

export function mcpSecrets(services: McpService[]): string[] {
	return services.flatMap((service) => {
		const config = parseMcpConfig(service.config);
		return [
			...service.env.map(({ value }) => value),
			...("url" in config
				? [
						...Object.values(config.http_headers).flatMap((value) => [
							value,
							value.replace(/^\S+\s+/, ""),
						]),
						...new URLSearchParams(
							config.url.split("?", 2)[1]?.split("#", 1)[0],
						).values(),
					]
				: []),
		].filter(Boolean);
	});
}

export function mcpDiagnostics(
	services: McpService[],
	connections: McpConnection[],
	redact: (text: string) => string,
) {
	return services.map((service) => {
		const config = parseMcpConfig(service.config);
		const runtime = connections.find((entry) => entry.id === service.id);
		return {
			id: redact(service.id),
			name: redact(service.name),
			configured: true,
			enabled: service.enabled,
			transport: "url" in config ? "streamable_http" : "stdio",
			startup_timeout_sec: config.startup_timeout_sec,
			launch:
				"url" in config
					? {
							url: redact(
								config.url.replace(/(\/\/)[^/?#]*@/, "$1").split(/[?#]/, 1)[0],
							),
							headers: Object.keys(config.http_headers).map(redact),
						}
					: {
							command: redact(config.command),
							argument_count: config.args.length,
							// Arbitrary argv can contain literal credentials; expose references, never their values.
							variable_references: [
								...new Set(
									[config.command, ...config.args].flatMap((value) =>
										[...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1]),
									),
								),
							].map(redact),
						},
			environment: service.env.map(({ name, value }) => ({
				name: redact(name),
				configured: Boolean(value),
			})),
			runtime: runtime
				? {
						status: runtime.status,
						...(runtime.error === undefined
							? {}
							: { error: redact(runtime.error) }),
						...(runtime.stderr === undefined
							? {}
							: { stderr: redact(runtime.stderr) }),
					}
				: { status: "not_started" },
		};
	});
}
