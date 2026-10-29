# Development and tool reference

For everyday use, start with the [README](../README.md) or [user guide](user-guide.md). This page covers building, testing, and implementation contracts. See the [documentation index](README.md) for decisions and validation records.

## Prerequisites

Use Node.js 24+ and the pnpm version pinned in `package.json` (pnpm 11). Install dependencies with `pnpm install --frozen-lockfile`. The frontend can be built and tested separately, but native command execution is macOS-only; desktop packaging supports macOS arm64 only.

## Server and browser workflow

From the checkout:

```sh
pnpm install
pnpm start
```

`pnpm start` builds the frontend, creates a management token, and runs the server with Node's watch mode. Open the management URL printed in the terminal. It authorizes app changes: keep it private, and use the newly printed URL after restarting the process. Use a browser window of at least 1280 × 720.

Stop with **Ctrl+C**. The default port is 3000; use `pnpm start --port 3001` to change it. **Startup stops existing listeners on the selected port**, so choose an unused port. The desktop entry point instead uses an available loopback port and does not stop unrelated listeners.

The server database defaults to `data/weft.sqlite` in the checkout. To use another database:

```sh
pnpm start --db /absolute/path/to/chat.sqlite
```

Its parent directory must already exist and be private to your user (for example, permissions `0700`). Server and desktop data are independent; see [local data](user-guide.md#local-data).

## Desktop builds

```sh
pnpm desktop:build
# Or build, then open only after success:
pnpm desktop:start
```

The output is `desktop-output/Weft.app`. Both commands refuse while the target Weft desktop app is running, even with no window. Quit it first; builds never stop its Agents. A failed build preserves the last successful application, and `desktop:start` does not launch stale output.

Each build captures the checkout, including local edits. Finder launch does not compile or watch source. Generated apps, staging, and runtime caches are ignored by Git. The build does not import, move, reset, or delete checkout data.

The bundle contains Electron, a checksum-verified standalone Node runtime, frontend/backend resources, production dependencies, Codex/ripgrep, and Playwright code/CLI/skill. Runtime versions are pinned in `desktop/build.ts` and `package.json`; the bundle excludes databases, credentials, personal configuration, tests, and repository metadata. Dependency links must stay inside the bundle, including after relocation.

The app starts one backend on loopback and waits for readiness. Management authority stays in the app/session boundary, outside tool environments and logs. The renderer has Node integration disabled and context isolation/sandboxing enabled. External navigation opens outside the app window.

Finder startup recovers PATH through the user's interactive login shell with a 15-second limit, preserves HOME/configuration discovery, and prepends bundled command tools. Closing a window retains the backend; single-instance activation reopens it. Quit checks application-wide active work and queues before using the existing completed-cleanup shutdown path. See [desktop behavior](user-guide.md#desktop-lifecycle-and-updates) and the [desktop ADR](adr/0012-desktop-application.md).

Public releases, installers, signing/notarization, automatic updates, Intel builds, and Windows/Linux desktop support are outside the current delivery. Do not infer backend portability from Electron support.

## Checks

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test` builds the frontend and runs unit/native tests. `pnpm test:e2e` builds and runs the frontend Playwright suite. On macOS arm64 with a graphical login session and installed Chrome/Edge, run the local packaged-app checks:

```sh
pnpm test:desktop
```

Quit the real desktop app before packaged tests; its running-app guard also applies to test builds. The tests build disposable copies, use private temporary databases and local model HTTP fixtures, and exercise real native/browser tools. They do not use your desktop or checkout database. Keep fixture ports, browser profiles, and project directories isolated. Never replace real model failures with paid calls or weaken production assertions to pass checks.

The existing [CI workflow](../.github/workflows/ci.yml) defines frontend and macOS native checks; local desktop packaging is not a release workflow. Actual packaged results, failure history, and untested limits belong in the [packaging record](desktop-packaging-check.md). The separate cancellation-race investigation is [#193](https://github.com/tylerlong/weft/issues/193); passing reruns do not establish that it is resolved.

## Skill discovery and selection

Install standard `SKILL.md` skills in `~/.agents/skills` or project `.agents/skills` directories. Within a Git repository, discovery includes the directories from the repository root to each Target Folder; outside Git, it checks the Target itself. Same-name skills retain their individual source paths.

Type `/` in the prompt to filter by name, description, or source. Use ↑/↓ and Enter to select, Esc to dismiss, and the selected markers to remove skills. Selection does not send the task. On submission the complete selected `SKILL.md` is read, including skills marked `disable-model-invocation: true` or `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. Other skills expose only their summary until the model chooses to read them.

Every new root or sub-agent discovers its own catalog; selections are not inherited by sub-agents or later tasks. Discovery/read failures appear as diagnostics in the actual model request and the picker. There is no live filesystem watcher: reopen `/` to refresh the picker. Skill directories and installed symbolic link targets are readable; scripts use the same Full Access tools and global safety review.

## Instruction loading and command environment

Each new root task and sub-agent loads user instructions from the service user's `~/.weft/`, followed by each Project folder's nearest Git root through that folder. Outside Git, only the Project folder is checked. In a directory, `AGENTS.override.md` replaces `AGENTS.md`, including when empty; a read failure is reported without falling back. Shared sources load once with each applicable scope.

The initial UTF-8 text budget is 32 KiB, shared in user-first, saved-folder and ancestor-first order. Actual model requests show source paths, scopes, truncated content, omissions and read errors. Running agents keep their initial contents; new agents reload. The model must discover and read deeper local instructions before working on files, and decide how to handle unavailable rules. References such as README, CONTEXT and ADRs are read only when needed.

Initial instruction discovery follows its named sources and reports read errors; ordinary tool reads, commands and writes use Full Access and the global review switch. Commands inherit the service user’s normal `HOME`, `PATH` and development environment; Weft prepends its bundled command tools and removes `WEFT_MANAGEMENT_TOKEN`. Commands can read that account’s configuration and credentials; Full Access provides no isolation. Agent scratch still supplies temporary directories and the browser CLI daemon registry. The exec-server process keeps its separate minimal environment and HOME.

## Text-reading tool contract

`read_file` reads complete lines as the current system user, with the same Full Access and global safety review as other tools. Pass an absolute `path`; `start_line` is a positive safe integer (default 1), and `max_lines` is a positive safe integer (default 2,000). Old `offset`/`limit` parameters and unknown fields fail. A successful result contains exactly `path`, `text`, `encoding` and `next_line`. Continue with `start_line: next_line`; only actual EOF returns `next_line: null`.

Each page contains at most 51,200 UTF-8 bytes of text, including original line endings. Lines and characters are never split; an oversized first requested line fails, while a page with earlier complete lines returns those and points to the remaining line. LF, CRLF, CR, Unicode content and an unterminated final line remain unchanged. UTF-8, UTF-8 with BOM and BOM-marked UTF-16 LE/BE are supported (`utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`); only the opening BOM is removed. Empty and BOM-only files return empty text and `null`; a starting line beyond nonempty content fails.

Binary, unsupported or malformed text fails explicitly. The model chooses any further command or MCP tool; images use `read_image`. Reads scan from the beginning without retaining skipped content, so later lines cost more scanning. Only decoded content is validated, with limited lookahead for EOF; unread tails have no validation guarantee, and edits between calls have no snapshot guarantee. Text results contain no duplicate base64. See [the text-reading decision](adr/0010-readable-file-content.md) for details.

## Command-session contract

The model can run `exec_command` with `cmd`, optional absolute `workdir` (Agent scratch by default), `shell`, `login`, `tty`, `yield_time_ms`, and `max_output_tokens`. Interactive commands yield without killing the process and return `session_id`; `write_stdin` polls, supplies PTY input, or sends Ctrl-C. Non-PTY input accepts only Ctrl-C. Explicit legacy `timeout_ms` selects OneShot execution and cannot combine with PTY or yield. Login defaults to true for interactive commands and preserves the previous false default for OneShot.

Command Output keeps complete decoded text, stream labels and chunk order with the launching Tool Call, including PTY output. Invalid or incomplete UTF-8 bytes appear as replacement characters; raw binary output is not archived. Refresh its details to see current process state and new logs; `read_tool_output` gives the model bounded historical pages. Output budgets affect the returned text only (four characters per requested token), never the saved log. Cancellation, Agent completion, and service shutdown clean up owned processes; sessions do not survive restart. New schema versions reject incompatible existing databases without deleting or migrating them.

## Image records

Image attachments and successful `read_image` results retain actual bytes with the question or Tool Result. Changing or deleting a source file does not change the saved record. User-question images remain available in later Root history; tool images stay within the Agent that read them. Copying tool results includes the original data URL. Automated checks exercise protocol and native reading with controlled responses; they do not establish paid-model visual interpretation.

## Browser integration

The pinned Playwright dependency supplies its official CLI and unmodified `playwright-cli` skill. Desktop packages include the code and skill, not an automation browser. The ordinary source/server workflow may optionally download Chrome for Testing with `pnpm exec playwright install chromium` and use `--browser=chromium`; desktop builds use installed Chrome/Edge by default through explicit upstream channels.

Commands use native unsandboxed execution. Browser actions and full command output remain recorded Tool Calls; screenshots enter model context only when explicitly read. The CLI keeps normal HOME for personal profile discovery, with its daemon registry in Agent scratch through the pinned version's `PWTEST_DAEMON_SESSION_DIR` override. Each Agent owns its sessions/connections; temporary cleanup must preserve personal pages/login state and the Chat's saved target.

`docs/browser-tools.md` is runtime guidance: `src/browser-tools.ts` loads it for model instructions, and `desktop/build.ts` copies it into the app. Keep that path and the packaged-test allowlist in sync if it ever moves. Full configuration precedence, extension flow, session semantics, and historical acceptance remain in [browser tools and compatibility](browser-tools.md).

## MCP integration

For editable service definitions, env substitution, Jira setup, and save/lifecycle behavior, see [MCP and Jira](user-guide.md#mcp-and-jira).

The Jira Docker template passes environment names with `-e NAME`, keeping credential values out of argv. Template updates do not overwrite existing service rows.

The TypeScript client version is pinned in `package.json`. Each Root Agent and Sub-agent owns connections, reuses them during its model loop, and closes them on completion/cancellation. Model calls receive every discovered tool; invocations follow the global Jev review switch. Tool results preserve ordered text/images, structured content, and `isError`; resource links remain unread links, and unsupported content is retained with an explanation. Errors return without automatic retries or operation replay.

The prior Jira check discovered 49 tools and called `jira_search` on 2026-10-14; it did not validate Jira mutations. Controlled localhost Streamable HTTP tests cover Settings save, discovery, fixed authentication, results/errors, cancellation, and cleanup without an external HTTP service or paid model. Historical validation is not a guarantee for arbitrary external integrations.

## Database compatibility

The current schema is defined in `src/database.ts` (version 28 at this reorganization). Unsupported databases are rejected without deletion or automatic migration. Do not reset a user's database to make a build/test pass. Use a separate fresh path when needed and preserve the old records.
