export const commandTools = [
	{
		type: "function",
		name: "browser_connect",
		description:
			"Connect this Agent's independent CLI session to the Chat personal Chrome/Edge target through the official extension. First connection uses upstream channel/profile discovery unless specified; only a successful attach saves the target. Later calls reuse it. Set change_target only for an explicit user request to change browser/profile. Existing Agents keep their own actual connection. Returns ordinary command output/session_id; poll with write_stdin. Use playwright-cli -s=weft-personal for all subsequent upstream actions and detach, omitting workdir or using Agent scratch; use other CLI sessions for temporary browsing, which does not change this target.",
		parameters: {
			type: "object",
			properties: {
				channel: { type: "string" },
				profile: {
					type: "string",
					description:
						"Upstream profile directory name, e.g. Default or Profile 2",
				},
				user_data_dir: {
					type: "string",
					description:
						"Explicit upstream user-data directory; otherwise upstream host default",
				},
				change_target: { type: "boolean", default: false },
			},
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "exec_command",
		description:
			"Run a command as the current system user. Defaults to interactive yield (10000ms), returning session_id if still running; continue with write_stdin. tty enables stdin; non-PTY only supports Ctrl-C. Explicit timeout_ms selects legacy OneShot: waits to completion, terminates on timeout, cannot resume. Do not combine timeout_ms with tty/yield_time_ms. No automatic replay. Full output is saved under tool_call_id; read_tool_output continues history. max_output_tokens budgets returned text using 4 characters/token, without deleting logs.",
		parameters: {
			type: "object",
			properties: {
				cmd: { type: "string" },
				workdir: {
					type: "string",
					description: "Absolute directory; defaults to Agent scratch",
				},
				command: {
					type: "string",
					description: "Legacy alias of cmd; supply only one",
				},
				cwd: {
					type: "string",
					description: "Legacy alias of workdir; supply only one",
				},
				shell: {
					type: "string",
					description: "Absolute shell executable; default /bin/sh",
				},
				login: {
					type: "boolean",
					description:
						"Default true for interactive commands, false for legacy OneShot",
				},
				tty: { type: "boolean", default: false },
				yield_time_ms: {
					type: "integer",
					minimum: 0,
					default: 10000,
				},
				max_output_tokens: { type: "integer", minimum: 0 },
				timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 },
			},
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "write_stdin",
		description:
			"Continue your own exec_command session. Omit chars to poll; tty sessions accept text or Ctrl-C (\\u0003); non-PTY sessions accept only Ctrl-C. Polls wait at least 5000ms (max 300000), nonempty writes 250–30000ms. Returns new output and actual process state; read_tool_output can reread full saved history under the original tool_call_id. No replay.",
		parameters: {
			type: "object",
			properties: {
				session_id: { type: "integer", minimum: 1 },
				chars: { type: "string" },
				yield_time_ms: { type: "integer", minimum: 0 },
				max_output_tokens: { type: "integer", minimum: 0 },
			},
			required: ["session_id"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "read_tool_output",
		description:
			"Read saved command output from your own Tool Call (Root Agents may also read any same-Chat Agent, including historical descendants) using character offsets, preserving stream and chunk order. Defaults: offset 0, limit 16000; maximum 16000.",
		parameters: {
			type: "object",
			properties: {
				tool_call_id: { type: "integer", minimum: 1 },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 16000 },
			},
			required: ["tool_call_id"],
			additionalProperties: false,
		},
	},
];

export function outputPage(
	chunks: Iterable<{ ordinal: number; stream: string; text: string }>,
	offset = 0,
	limit = 16000,
) {
	let position = 0;
	const page = [];
	for (const chunk of chunks) {
		const start = Math.max(0, offset - position);
		const end = Math.min(chunk.text.length, offset + limit - position);
		if (start < end)
			page.push({
				ordinal: chunk.ordinal,
				stream: chunk.stream,
				text: chunk.text.slice(start, end),
			});
		position += chunk.text.length;
	}
	return {
		chunks: page,
		next_offset: Math.min(position, offset + limit),
		total_chars: position,
	};
}
