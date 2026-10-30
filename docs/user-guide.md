# Using Weft

Start with the [README](../README.md#get-started) to build and open the desktop app. This guide covers everyday usage; [development](development.md) covers the source/server workflow and implementation details.

## Your first task

1. In **Settings → Models**, save your OpenRouter API key, wait for discovery, and add an available model.
2. Create a **Project** and select folders on the machine running Weft.
3. Create a **Chat**, choose a model and reasoning level, and describe the task.

For example: “Explore this project and explain how it starts. Do not change files.” Tasks can also edit files, run commands, and delegate to Sub-agents. Install the project runtimes and tools those tasks need yourself; Weft does not install or configure your development environment automatically.

The interface supports English and Chinese. It needs a window of at least 1280 × 720.

## Models and provider routing

Each Chat selects a model and reasoning level. Sub-agents can use different models. Inspect an Agent's model-call records to see actual requests, responses, request counts, and provider-reported usage, including Safety Review calls. Prompts, file contents, images, and tool results may be sent to the configured provider; local history does not mean offline model execution.

Settings explanations are available from the ⓘ help buttons beside labels and headings. Hover or focus a help button to read it; click or tap to keep it open or dismiss it. You can move the pointer onto the explanation to keep reading. Escape dismisses help first, leaving Settings open; a subsequent Escape closes Settings normally. Warnings, errors, save/discovery statuses, and recovery actions remain visible.

Save your OpenRouter key before adding models. Weft discovers the complete text-output catalog allowed by that key’s current provider preferences, privacy settings, and guardrails. Discovery refreshes at backend startup, when Settings opens, after a different key is saved, and on **Retry**. Saving the same key does not trigger another refresh. The public catalog is not a fallback.

Configured models are your saved models. Available models come from the latest successful discovery for the current key; availability does not guarantee a later request succeeds. Settings retains configured models absent from that result and marks them **Unavailable**. They cannot be selected as new defaults, Chat models, or explicit Sub-agent overrides; an existing selection remains visible and can still be submitted. Sub-agents without an override inherit their existing selection normally.

Changing or removing the key never deletes configured models, defaults, history, or Chat model/reasoning selections. Without a key, or while discovery loads or fails, availability is unknown: model addition/removal, default selection, Chat model selection, and model options are disabled. Key editing and discovery **Retry** stay accessible. A saved key remains saved even when discovery fails. Existing selections can still be submitted while discovery fails; missing credentials still prevent submission. A successful empty catalog means no models are currently available, rather than a discovery error; explicit removal of configured models is still possible after success.

**Settings → Models → Provider routing** saves one global preference:

| Choice                       | Priority                                       |
| ---------------------------- | ---------------------------------------------- |
| OpenRouter default (initial) | Let OpenRouter manage routing.                 |
| Lowest price                 | Favor cheaper providers of the selected model. |
| Highest throughput           | Favor faster token generation.                 |
| Lowest latency               | Favor earlier response startup.                |

The preference applies to the next model request, including requests in running tasks, Sub-agents using other models, and Safety Review. Requests already sent keep their recorded configuration. The choice persists across reloads and compatible database restarts.

It expresses a priority: it does not set spending limits, exclude providers, guarantee performance, change the selected model, or override OpenRouter's fallback behavior. Changes save automatically; a failed save shows an error, and Close retries it.

## Working with Chats

Your submitted task starts a Root Agent, which can delegate work to Sub-agents. Inspect their requests and Tool Calls to follow progress, outputs, and failures. Complete command output is retained even when the text returned to the model is shortened.

While a Chat is running, its send menu offers:
- **Queue:** save a message to run later.
- **Steer:** stop the current Root and its descendants, wait for cleanup, then start your new message ahead of queued messages.

**Settings → General → Follow-up behavior** saves the default (Queue initially). A send-menu choice applies once. Idle Chats show **Send**. Steer starts a separate Root with the interrupted task's history, like Stop followed by Send; it does not resume the old command.

View or remove pending messages near the composer. Success starts the next queued message after cleanup. Failure, Stop, or an execution limit leaves the queue waiting; use **Continue queue** or a new Send to resume it. Queued input survives browser refresh but is lost when Weft's backend exits or restarts.

Stopping work does not undo completed file changes or external effects. Cleanup is best effort for independently detached processes; do not treat Stop as a rollback.

## Access and Safety Review

Tools run with your system user's **Full Access**. They can access files, commands, account configuration, and credentials available to that user. A Project's selected folders provide task context, not a filesystem sandbox.

**Settings → Execution** provides one global Jev Safety Review switch, enabled by default for all Chats and Agents. Each Tool Call is reviewed before execution; disabling review sends no Jev review request. Changes affect subsequent Tool Calls, and Stop directly cancels work. Blocked or failed reviews do not execute the operation.

Safety Review evaluates operational risk, not task relevance. It does not isolate files/processes or reveal every effect inside scripts and external services. Review requests/results appear in ordinary model-call records and count toward the Agent's model-call limit. Weft does not automatically retry paid requests or replay tool operations. Save wanted results in project folders; temporary workspaces are disposable.

## Skills

Install standard `SKILL.md` skills in `~/.agents/skills` or a project's `.agents/skills` directory. Within Git, discovery covers directories from the repository root to each selected Target Folder; outside Git, it checks the Target itself.

Type `/` in the prompt to filter Skills by name, description, or source. Use ↑/↓ and Enter to select, Esc to dismiss, and the selected markers to remove them. Selecting a Skill does not send your task. Submit the prompt to have its selected instructions read.

Every new Root and Sub-agent discovers its own catalog. Skill selections do not carry over automatically to Sub-agents or later tasks. Reopen `/` to refresh the picker; there is no live filesystem watcher. Discovery/read failures are shown as diagnostics. Skill scripts use the same Full Access tools and global Safety Review as other work.

## User and project instructions

Put shared instructions in `~/.weft/AGENTS.md`. Put project-specific rules in `AGENTS.md` files within the project directory hierarchy. In a directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, even when the override is empty.

New tasks load user instructions first, then project instructions from the nearest Git root through each selected Project folder. Outside Git, only the selected folder is checked initially. Running Agents keep the instructions they started with; new Agents reload them. The model is instructed to discover deeper local instructions before working on those files.

Request details show which sources were loaded, omitted, truncated, or unreadable. For exact discovery and size limits, see [instruction loading](development.md#instruction-loading-and-command-environment).

## Images

Use **Attach images** or paste PNG, JPEG, GIF, or WebP images into the prompt. Preview and remove attachments before sending. Up to ten images are accepted, each at most 10 MiB.

Choose a model that supports images. A model known to lack image input is rejected without discarding your draft; unknown capabilities are left to the provider, and failures are recorded without automatic retries or model changes.

The model can also read local pictures and screenshots. Actual image bytes are saved with questions and Tool Results, so changing or deleting the original file does not change history. Images increase local storage and model input size. Request and Tool Call details retain the visual content; copying Tool Results may include original image data.

## Browser tasks

For independent temporary browsing, install Chrome or Edge and ask Weft to use it. Weft includes the official Playwright CLI and Skill, but the desktop app does not include an automation browser. Temporary sessions need neither an extension nor personal login, and they do not change a Chat's saved personal-browser target.

Select `playwright-cli` with `/` or ask the model to use the Skill. Browsers launch headlessly by default; ask for a visible window if needed. Missing browsers affect the requested browser task, not Weft startup or non-browser tasks. Install the requested browser or explicitly select another available channel; Weft does not silently switch browsers or profiles. Safari is not a substitute for Playwright's patched WebKit.

### Reusing a personal login

Ask Weft to connect to the intended Chrome or Edge profile. Connection approval, extension installation, and website login are separate steps:
1. If the extension is missing, install the [official Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in that same profile and keep it enabled. Edge may ask you to allow extensions from other stores. Weft does not install it automatically.
2. Approve the browser connection in the upstream authorization page, and hand over only the task-relevant page.
3. If the website requires login, complete authentication yourself in the browser. Then return to the Chat and tell Weft to continue.

A successful connection saves the actual browser/profile target on the Chat. Later Roots, Sub-agents, and restarts reuse that identity with separate connections and page groups; restarting does not restore a live command or connection. Changing the target requires an explicit request. A connection failure does not silently select another profile or account.

Agent cleanup releases its own connection while preserving personal pages and login state; owned temporary browsers close. Browser authorization does not grant access to unrelated pages. Technical setup, configuration precedence, and measured compatibility remain in [browser tools and compatibility](browser-tools.md).

## MCP and Jira

**Settings → MCP** stores global external-service definitions and their environment values. These integrations are trusted: the service, account, and token determine access, and Safety Review does not isolate their internal effects.

New services from **Add Jira template** or **Add service** start with **Enabled** checked and environment values visible. Uncheck **Enabled** if you do not want a service used yet. Existing saved enabled/disabled states are preserved. Incomplete custom definitions remain drafts under the normal validation rules.

Each service has **Show values / Hide values**, including disabled services. It reveals or masks all environment values for that service, including credentials; newly added variables follow its current visibility. Existing services start masked. Visibility survives autosaving, but leaving MCP or successfully closing Settings resets every service to masked without clearing invalid or failed-save drafts. Returning to MCP or reopening Settings starts masked. Visibility is temporary and is not saved with configuration. Showing values can expose credentials during screen sharing; hiding is only a display convenience, not access control or encryption. The OpenRouter key and Connection JSON retain their existing behavior.

### Jira

Choose **Add Jira template** for an editable Docker/PAT template. Fill `JIRA_URL` and `JIRA_PERSONAL_TOKEN`; the template sets `TOOLSETS=all` and `READ_ONLY_MODE=false`, so all configured Jira tools, including writes, can be available. Startup checks Docker readiness and can start a confidently identified existing stopped Colima profile; a running VM with an unavailable Docker endpoint remains an error. Use credentials with the access you intend to grant.

The template starts `ghcr.io/sooperset/mcp-atlassian:latest` over stdio with a 120-second startup timeout. Existing service rows are not overwritten by later template updates. For MCP Atlassian 0.21.1, an older saved `TOOLSETS=jira` selects no tools because `jira` is not a recognized toolset; correct it in Settings to `all` (or a supported named group). See the [acceptance evidence](mcp-acceptance.md) for the pinned upstream contract.

### Custom services

For a local stdio service, enter JSON such as:

```json
{ "command": "program", "args": [], "startup_timeout_sec": 120 }
```

Store environment names/values in the separate fields. For a Streamable HTTP service, use:

```json
{
	"url": "http://localhost:3000/mcp",
	"http_headers": { "Authorization": "Bearer <MCP_AUTH>" },
	"startup_timeout_sec": 120
}
```

Add `MCP_AUTH` in that row's environment fields. HTTPS URLs work the same way. Use another API-key header such as `X-API-Key`, or omit `http_headers` for no authentication. Configure either command/args or url/http_headers in a row. Browser OAuth and legacy SSE fallback are not supported.

The startup timeout defaults to 120 seconds. `<NAME>` in a JSON string expands from the same row's env values once after parsing, including within string fragments. Keys and substituted values are not expanded again; missing names prevent service startup.

Invalid JSON and failed saves remain as drafts. Close retries retained saves and stays open on failure. No separate MCP configuration file is needed. Like your OpenRouter key, env values are stored in plaintext SQLite; masked fields do not encrypt them.

### Changes and diagnostics

Editing or enabling a service does not replace an active client automatically. An Agent can use `mcp_diagnostics` for safe current Settings/runtime facts and `mcp_startup` with the stable service ID to adopt the latest saved configuration in the same Agent; otherwise the next Agent uses it during initialization. Replacement removes old tools first, publishes only complete discovery, and leaves the selected service unavailable on failure without fallback or replay. A selected-service edit during Safety Review returns a retry result before replacing the old client. Enabled does not mean connected, and connected does not guarantee any tools or later call success. Jira templates with empty credentials can fail at connection time through normal diagnostics. Disabling/deleting a service blocks subsequent calls immediately, although in-flight calls may return. Each Root and Sub-agent owns and closes its connections. Separate connections/processes do not isolate shared Jira account data.

Agent details show that Agent's connection status, errors, and server stderr. Settings shows configuration feedback only. Calls and errors remain inspectable; Weft does not automatically retry operations.

## Local data

| How you run Weft       | Database                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| Desktop app            | `~/Library/Application Support/Weft/weft.sqlite`                     |
| Source/server workflow | `data/weft.sqlite` in the checkout, unless a custom path is selected |

The database stores Projects, Chats, history, settings, records, and **unencrypted API keys/integration env values**. Keep it private. A fresh desktop installation starts independently of checkout data; Weft does not import, move, reset, or delete the checkout database. Desktop data persists across app restarts and rebuilds.

If a build cannot open an incompatible database, it reports an error and preserves the file. Weft does not automatically migrate or delete it. Use a compatible build; if a new database is needed, use a separate fresh path and retain the old file for its records. See [custom server paths](development.md#server-and-browser-workflow).

## Desktop lifecycle and updates

Closing the window leaves the app, backend, and Agents running. Click the Dock icon or launch Weft again to reopen/focus that same instance.

**Quit / Cmd+Q** checks all Chats for active Agents and queued input. If either exists, the confirmation offers Cancel or Quit. Cancel preserves the windows, execution, and queues. Confirmed Quit stops active work, discards unstarted in-memory queued input, and waits for existing cleanup. Completed effects are not undone; work is not replayed on restart. Idle Quit also waits for cleanup, and cleanup failures remain visible.

Each desktop build is a snapshot of its source. Finder launch does not compile or watch changes. To update it, **quit Weft**, then run `pnpm desktop:build` or `pnpm desktop:start` from the checkout. Both commands refuse a running app, including one with its window closed. Build failure preserves the last successful app, and the start command does not open stale output. Your desktop data remains outside the app/build directory.

The built app runs without a separate Node installation or pnpm. Git, project runtimes/package managers, Docker, and external MCP services remain your responsibility. There is no automatic updater or signed/notarized public installer in the current delivery.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build says Weft is running                           | Use Quit / Cmd+Q; closing its window is not enough. Then rebuild.                                                                                                                                                       |
| Source changes are not visible                       | Rebuild the app after quitting. Opening it from Finder uses the last successful snapshot.                                                                                                                               |
| Finder-launched app cannot start or find tools       | Read the startup dialog. Weft obtains PATH from your interactive login shell; fix shell startup errors or startup taking longer than 15 seconds. Install required tools yourself. Bundled Node/ripgrep take precedence. |
| Browser task fails because an executable is missing  | Install the requested Chrome/Edge channel or explicitly select an available one. Non-browser tasks can continue.                                                                                                        |
| Personal login is not available                      | Confirm the intended browser/profile, extension, connection approval, and website login separately. Reconnect to the same target; do not assume another profile is appropriate.                                         |
| MCP service is unavailable                           | Inspect the Agent's connection error/stderr. Check the command or URL, env values, authentication, startup timeout, and Docker if applicable.                                                                           |
| Database is incompatible or already owned            | Preserve the data. Use a compatible build or close the other owner; do not delete/reset the database as a troubleshooting shortcut.                                                                                     |
| Source/server interface rejects access after restart | Open the newly printed management URL; keep it private.                                                                                                                                                                 |

A model can pass discovery and still have a request rejected after a policy, credential, budget, or provider change. The failed Agent shows OpenRouter's reason when supplied; expand its **Response** to inspect the sanitized HTTP status, response body, and structured policy details. A guardrail rejection can return HTTP 404, but 404 alone does not prove an organization block. Failed requests preserve your configured models, defaults, Chat choices, and history. Choose an available replacement explicitly and send again when appropriate; Weft does not automatically replace models or retry failed requests.

For implementation details or recorded validation limits, use the [documentation index](README.md).
