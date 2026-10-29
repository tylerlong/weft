# Weft

A local coding agent with a web interface. Ask it to explore projects, edit files, run commands, and delegate tasks.
- **Transparent model communication:** inspect model HTTP requests, responses, request counts, and provider-reported usage, with credentials redacted.
- **Flexible delegation:** run concurrent sub-agents with different models and reasoning levels; inspect and stop tasks individually.
- **Full local access:** tools run as your system user, with optional Jev safety review.
- **Local history:** keep projects, chats, settings, and task records on your machine. The interface supports English and Chinese.

## Quick start

Requires **macOS**, **Node.js 24+**, **pnpm 11**, and a browser window of at least **1280 × 720**.

```sh
pnpm install
pnpm start
```

Open the management URL printed in the terminal. Keep it private: it authorizes app changes. After restarting, open the newly printed URL.
1. In **Settings → Models**, enter your OpenRouter API key and add a model.
2. Create a **Project** and select folders on the machine running the service.
3. Create a **Chat**, choose a model and reasoning level, and submit a task.

**Settings → Models → Provider routing** saves one global preference for every model and Chat, including Root Agents, Sub-agents using other models, and Safety Review:

| Choice                       | Priority                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| OpenRouter default (initial) | Let OpenRouter manage routing; send no explicit sorting preference. |
| Lowest price                 | Favor cheaper providers of the selected model.                      |
| Highest throughput           | Favor faster token generation.                                      |
| Lowest latency               | Favor earlier response startup.                                     |

Changes apply to the next model request, including in running tasks; requests already sent and their recorded configuration stay unchanged. The choice persists across reloads and supported-database restarts. It expresses a priority, without excluding providers, setting spending limits, guaranteeing performance, changing the model or overriding OpenRouter’s fallback behavior. These controls save automatically; save failures show an error and Close retries the failed change.

While a Chat is running, the send menu offers **Queue** to save the next message, or **Steer** to stop the current Root and its descendants, wait for cleanup, and start the new message ahead of the queue. **Settings → General → Follow-up behavior** saves the global default (Queue initially); a send-menu choice applies once. Idle Chats show **Send**. Steer starts a separate Root with the interrupted task’s history, just like Stop followed by Send. View or remove pending messages near the composer. Success starts the next message after cleanup; failure, Stop or an execution limit leaves the queue waiting. **Continue queue** or a new Send resumes the chain. Pending messages survive browser refresh but are lost when the service restarts, including watch restarts.

Stop with **Ctrl+C**. The default port is 3000; use `pnpm start --port 3001` to change it. Startup stops existing listeners on the selected port, so choose an unused port.

## Local desktop app (macOS Apple Silicon)

From this checkout, with Node.js 24+ and pnpm 11 installed:

```sh
pnpm install
pnpm desktop:build
# Or build and open only after a successful build:
pnpm desktop:start
```

The output is `desktop-output/Weft.app`. Open it from Finder after building; it includes Electron, a checksum-verified standalone Node 24.21.0 runtime, the current UI/backend, production dependencies, Codex/ripgrep and Playwright code/CLI/skill. The first build downloads runtimes. Generated applications, staging and runtime caches are ignored by Git. Only macOS arm64 builds are supported; there are no public releases, installers, automatic updates, Developer ID signing or notarization.

Each app is a snapshot of the checkout, including local edits. Rebuild to apply changes; Finder launch does not compile or watch source. Both commands refuse while the Weft desktop app is running, including with its window closed: **Quit Weft and build again.** They never stop the app or its Agents. A failed build preserves the last successful app, and `desktop:start` does not open stale output.

The built app needs neither the checkout, pnpm nor a separate Node installation. Configure models in its existing Settings interface. Git, project runtimes/package managers, Docker and external MCP services remain user prerequisites; Chrome/Edge are optional browser-task prerequisites. At startup the app recovers PATH through your interactive login shell, so existing developer tools can be found from Finder. HOME and inherited configuration remain available; shell startup must finish within 15 seconds, otherwise the app reports a startup error. Weft keeps its bundled Node, ripgrep and CLI ahead of that PATH. It does not install project dependencies or configure external tools.

Desktop data lives in `~/Library/Application Support/Weft/weft.sqlite`, separately from `data/weft.sqlite` in the checkout. It starts fresh and persists across app restarts and rebuilds. It includes unencrypted settings/API keys; keep it private. The app does not import, move, reset or delete checkout data. An incompatible schema fails startup while preserving the database; use a compatible build and retain the old data for its records.

Closing the window leaves the app/backend running. Dock activation or launching the app again opens/focuses that instance. Idle Quit waits for existing server, tool and database cleanup. Active-work/queued-input Quit confirmation and the complete failure-path checks remain [#201](https://github.com/tylerlong/weft/issues/201); until that lands, Quit stops work without confirmation and loses unstarted queued input. See [the packaging evidence and limits](docs/desktop-packaging-check.md).

Run `pnpm test:desktop` on a Mac with a graphical login session for the local packaged-app checks. They build the app, use disposable copies and private temporary data, inject local model HTTP fixtures and run real native commands. They do not use your desktop or checkout database. Existing unit/native and frontend checks remain `pnpm test` and `pnpm test:e2e`.

## Skills

Install standard `SKILL.md` skills in `~/.agents/skills` or project `.agents/skills` directories. Within a Git repository, discovery includes the directories from the repository root to each Target Folder; outside Git, it checks the Target itself. Same-name skills retain their individual source paths.

Type `/` in the prompt to filter by name, description, or source. Use ↑/↓ and Enter to select, Esc to dismiss, and the selected markers to remove skills. Selection does not send the task. On submission the complete selected `SKILL.md` is read, including skills marked `disable-model-invocation: true` or `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. Other skills expose only their summary until the model chooses to read them.

Every new root or sub-agent discovers its own catalog; selections are not inherited by sub-agents or later tasks. Discovery/read failures appear as diagnostics in the actual model request and the picker. There is no live filesystem watcher: reopen `/` to refresh the picker. Skill directories and installed symbolic link targets are readable; scripts use the same Full Access tools and global safety review.

## Permissions

Tools access files and run commands with your system user's Full Access. **Settings → Execution** provides one global Jev safety review switch, enabled by default for all chats and agents. Each Tool Call is reviewed before execution; disabling review sends no Jev request. Review changes affect subsequent Tool Calls, and Stop directly cancels work.

Jev reviews operational risk, not task relevance. Blocked or failed reviews do not execute the operation, and Weft never automatically retries a paid request or replays a tool operation. Review is best effort: it does not isolate files or processes or reveal every effect inside scripts and external services. Model requests and results remain visible in ordinary API call records and count toward the owning Agent's model call limit. Temporary workspaces are disposable; save wanted results in project folders.

## Browser diagnostics

The installation includes Playwright **1.64.1**'s official CLI and `playwright-cli` skill. The desktop app includes its code and skill, but no automation browser. For independent temporary browsing use an installed Chrome or Edge: `playwright-cli open <url> --browser=chrome` or `--browser=msedge`. These sessions use temporary profiles and need neither an extension nor personal login. Missing browser executables produce task errors; install the requested browser or explicitly choose an available channel. Weft does not silently switch browsers/profiles, and non-browser tasks still work. Safari is not Playwright's patched WebKit.

Target repositories need no browser package. Select the skill with `/` or ask the model to use it; `playwright-cli` forwards every upstream argument, including intentional browser/config/profile choices. CLI launches are headless by default; add `--headed` to show a window. Sessions remain available after `open`; inspect them with `playwright-cli list` and end them with `playwright-cli close`. For the ordinary source/server workflow, downloading a separate Chrome for Testing remains optional with `pnpm exec playwright install chromium` and `--browser=chromium`; desktop builds do not download or require it.

Commands use the native unsandboxed execution path. The model starts and checks the website through ordinary command sessions, then chooses browser actions, console/network details and request/response bodies, trace, screenshots, `run-code`, and `read_image` as needed. Browser operations and full command output remain inspectable Tool Calls. Screenshots enter model context only when explicitly read.

Sessions, profiles and connections retain upstream behavior. The CLI retains normal user `HOME` for personal profile discovery; its daemon registry is kept in Agent scratch through the pinned version’s `PWTEST_DAEMON_SESSION_DIR` override. For a task that needs an existing personal login, `browser_connect` uses the official Chrome or Edge extension and saves the actual successful browser/profile target on the Chat. Later Roots and Sub-agents reuse that target with independent connections and page groups; temporary browsing needs no extension or login and does not change the target. Use the upstream picker to hand over only a task-relevant page and inspect its actual state. An ordinary chat reply creates a new Root that reconnects and reselects a retained task page after human handoff; it does not resume an old command. Website authentication belongs to the human and the website; controlled handoff tests check browser-state continuity, not authentication mechanisms. Agent cleanup releases its own CLI sessions, preserving personal pages and login state; temporary browsers close. Do not close the user browser or sign out. [Setup, installation and validation](docs/browser-tools.md) records the exact tested scope and shared-account limits.

## Reading local text

`read_file` reads complete lines as the current system user, with the same Full Access and global safety review as other tools. Pass an absolute `path`; `start_line` is a positive safe integer (default 1), and `max_lines` is a positive safe integer (default 2,000). Old `offset`/`limit` parameters and unknown fields fail. A successful result contains exactly `path`, `text`, `encoding` and `next_line`. Continue with `start_line: next_line`; only actual EOF returns `next_line: null`.

Each page contains at most 51,200 UTF-8 bytes of text, including original line endings. Lines and characters are never split; an oversized first requested line fails, while a page with earlier complete lines returns those and points to the remaining line. LF, CRLF, CR, Unicode content and an unterminated final line remain unchanged. UTF-8, UTF-8 with BOM and BOM-marked UTF-16 LE/BE are supported (`utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`); only the opening BOM is removed. Empty and BOM-only files return empty text and `null`; a starting line beyond nonempty content fails.

Binary, unsupported or malformed text fails explicitly. The model chooses any further command or MCP tool; images use `read_image`. Reads scan from the beginning without retaining skipped content, so later lines cost more scanning. Only decoded content is validated, with limited lookahead for EOF; unread tails have no validation guarantee, and edits between calls have no snapshot guarantee. Text results contain no duplicate base64. See [the text-reading decision](docs/adr/0010-readable-file-content.md) for details.

## Images

Attach PNG, JPEG, GIF or WebP files with **Attach images**, or paste an image into the prompt. Preview and remove attachments before sending a text task. Up to ten images are accepted, each at most 10 MiB. A model known to lack image input is rejected without discarding the draft; unknown capabilities are left to the provider, whose failures are recorded without automatic retries or model changes.

The model can call `read_image` for local pictures and screenshots with the same Full Access and safety review as `read_file`. Actual image bytes are saved with the question or Tool Result, so changing or deleting the source does not change the record. Successful user questions retain their images in later Root Agent history; tool images stay within the Agent that read them. Images increase saved records and model input size. Model request details and Tool Call details retain the actual visual content; copying tool results includes the original data URL.

Automated checks use controlled model responses to verify the visual protocol and native file reading. They do not establish that a paid model interpreted an image.

## User and project instructions

Each new root task and sub-agent loads user instructions from the service user's `~/.weft/`, followed by each Project folder's nearest Git root through that folder. Outside Git, only the Project folder is checked. In a directory, `AGENTS.override.md` replaces `AGENTS.md`, including when empty; a read failure is reported without falling back. Shared sources load once with each applicable scope.

The initial UTF-8 text budget is 32 KiB, shared in user-first, saved-folder and ancestor-first order. Actual model requests show source paths, scopes, truncated content, omissions and read errors. Running agents keep their initial contents; new agents reload. The model must discover and read deeper local instructions before working on files, and decide how to handle unavailable rules. References such as README, CONTEXT and ADRs are read only when needed.

Initial instruction discovery follows its named sources and reports read errors; ordinary tool reads, commands and writes use Full Access and the global review switch. Commands inherit the service user’s normal `HOME`, `PATH` and development environment; Weft prepends its bundled command tools and removes `WEFT_MANAGEMENT_TOKEN`. Commands can read that account’s configuration and credentials; Full Access provides no isolation. Agent scratch still supplies temporary directories and the browser CLI daemon registry. The exec-server process keeps its separate minimal environment and HOME.

## Local data

`data/weft.sqlite` stores history, settings, and your **unencrypted API key**. Keep it private. To use another database, run `pnpm start --db /absolute/path/to/chat.sqlite`; its parent directory must already exist and be private to your user (for example, permissions `0700`).

The current database schema version is 28, including Chat personal browser targets and provider routing. Unsupported databases are rejected without deletion or automatic migration. If an update requires a new database, use a fresh path and keep the old database for its records.

### Command sessions

The model can run `exec_command` with `cmd`, optional absolute `workdir` (Agent scratch by default), `shell`, `login`, `tty`, `yield_time_ms`, and `max_output_tokens`. Interactive commands yield without killing the process and return `session_id`; `write_stdin` polls, supplies PTY input, or sends Ctrl-C. Non-PTY input accepts only Ctrl-C, matching Codex 0.162.0. Explicit legacy `timeout_ms` selects OneShot execution and cannot combine with PTY or yield. Login defaults to true for interactive commands and preserves the previous false default for OneShot.

Command Output keeps complete decoded text, stream labels and chunk order with the launching Tool Call, including PTY output. Invalid or incomplete UTF-8 bytes appear as replacement characters; raw binary output is not archived. Refresh its details to see current process state and new logs; `read_tool_output` gives the model bounded historical pages. Output budgets affect the returned text only (four characters per requested token), never the saved log. Cancellation, Agent completion, and service shutdown clean up owned processes; sessions do not survive restart. New schema versions reject incompatible existing databases without deleting or migrating them.
## MCP / Jira

Settings → MCP stores global service definitions and env values in the existing SQLite database. Add Jira fills the editable Docker/PAT template; fill JIRA_URL and JIRA_PERSONAL_TOKEN. TOOLSETS=jira exposes the server’s Jira tools; READ_ONLY_MODE=false permits the account’s write tools. Docker must be running (for example the existing Colima instance). The template starts `ghcr.io/sooperset/mcp-atlassian:latest` over stdio with a 120-second startup timeout and `-e NAME` arguments; credentials are not placed in argv. Existing rows are never overwritten by template updates.

Custom stdio services use JSON `{ "command": "program", "args": [], "startup_timeout_sec": 120 }` and separate env name/password fields. URL services use `{ "url": "http://localhost:3000/mcp", "http_headers": { "Authorization": "Bearer <MCP_AUTH>" }, "startup_timeout_sec": 120 }`; HTTPS remote URLs work the same way. Add `MCP_AUTH` in that row’s masked env fields, use any API-key header such as `X-API-Key`, or omit `http_headers` for no authentication. Use either command/args or url/http_headers in a row. Startup timeout defaults to 120 seconds. Browser OAuth and legacy SSE transport fallback are not supported. JSON string values may contain `<NAME>` from that same row’s env; substitution happens once after parsing, including string fragments, without changing keys or expanding substituted values. Missing names prevent that service from starting. Invalid JSON and failed saves remain as drafts; Close retries retained saves and stays open on failure. No separate MCP configuration file is needed. Like the OpenRouter key, env values are stored in plaintext SQLite and edited with populated masked fields.

Enabled MCP services are trusted external integrations. The server process, account and token determine access. Model calls receive every discovered tool; each invocation follows the global Jev review switch. Review does not isolate the service’s internal effects. Errors return to the model without automatic retries or operation replay. Resource links remain unread links; unsupported content is retained with an explanation. Tool results preserve ordered text/images, structuredContent and isError.

Each Root Agent and Sub-agent starts its own connections, reuses them during its model loop and closes them on completion/cancellation. Agent details show that Agent’s connection status, errors and server stderr; Settings shows configuration feedback only. Editing or enabling applies to the next Agent. Disabling/deleting blocks subsequent calls immediately while in-flight calls can return; saving never restarts connections. Separate processes do not isolate shared Jira account data.

The official TypeScript client is pinned to 2.3.1. Current Jira compatibility was verified by discovering 49 tools and safely calling jira_search on 2026-10-14; actual Jira mutations were not used for verification. Controlled localhost Streamable HTTP tests verify Settings save, model tool discovery, fixed authentication, results/errors, cancellation and connection cleanup; no external HTTP service or paid model was used.
