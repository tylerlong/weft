# Browser tools and compatibility

The installation pins `playwright` 1.63.0 as a runtime dependency. This is the
same version already installed for the application tests. It includes the
official `playwright cli` implementation and its `playwright-cli` skill; the
separate `@playwright/cli` 0.1.22 package would install a different
1.64.0-alpha build, so it is not needed.

The command environment provides `playwright-cli` as a transparent executable
alias for the installed `playwright cli`, forwarding every argument. The
unmodified upstream skill and references appear through the existing skill
catalog. Targets need no browser-tool installation.
Commands, including the CLI, inherit the normal user HOME, PATH and development environment, with
Weft’s CLI wrapper, Node and ripgrep paths prepended and
`WEFT_MANAGEMENT_TOKEN` removed. Agent scratch supplies `TMPDIR`, `TMP`, `TEMP`
and `XDG_CACHE_HOME` (`scratch/cache`). The `playwright-cli` wrapper sets
`PWTEST_DAEMON_SESSION_DIR` to `scratch/playwright-daemon`, keeping CLI registry,
daemon sessions and sockets per Agent while host HOME remains available for
personal profile discovery. This is the only registry-directory override in the
pinned 1.63.0 implementation; its internal name must be rechecked on upgrades.
The macOS registry does not use `XDG_CACHE_HOME`. Installed browser
binaries remain available through `PLAYWRIGHT_BROWSERS_PATH`. This is Full Access:
commands can read the account’s configuration and credentials. The exec-server
process retains its own minimal environment and separate HOME.
Install browser binaries from the Weft directory with
`pnpm exec playwright install chromium`; the model can select them with
`playwright-cli open <url> --browser=chromium`. The upstream CLI defaults to its
own browser choice, not to Weft's configuration. The model must choose when to start a server, navigate, inspect diagnostics,
read a screenshot with `read_image`, and close the browser. No readiness policy
or browser action filter is added.

## Choosing a browser operation

Read the unmodified official `playwright-cli` skill for the complete interface.
Use `playwright-cli open <url> --browser=chromium` for an independent temporary
browser without an extension or website login. Upstream `--persistent`,
`--profile`, CDP attachment and diagnostic operations remain available; Weft
forwards every argument. The model chooses an operation according to the task,
not a local public/private website classifier.

To reuse an existing personal login with a stable Chat target, call
`browser_connect` with an optional `channel` (for example `msedge` or `chrome`),
`profile` (the upstream directory name), and `user_data_dir` (an explicit upstream
user-data root). Omitted values reuse this Chat's saved target; the first call
uses the upstream host channel/profile defaults and official extension discovery.
Only an actual successful attach saves `{channel, userDataDir, profile}` on the
Chat. An installation record or pending authorization does not bind it.

The result is a normal recorded command: poll a running `session_id` with
`write_stdin`. Its `browserTarget` identifies the actual connection attempt.
Then use `playwright-cli -s=weft-personal` for the complete upstream action
interface, omitting `workdir` or using the Agent scratch directory so the CLI
finds that Agent's session. Detach when done. Each Root/Sub-agent has its own
scratch registry and connection even when the Chat target is the same.

The saved target appears in every model request and in `GET /api/chats/:id` as
`browserTarget`. Subsequent Roots, Sub-agents and service restarts reuse its
exact profile, without rerunning recent-profile selection. A restart preserves
the identity, not the old connection or operation: explicitly reconnect and
observe the current page. A failed connection does not clear or replace it.

Only an explicit user request warrants `change_target: true` together with the
new channel/profile. Existing Agents keep their actual connections; their
recorded attempt/state continues to identify that target. A connection that
finishes after another Agent changed the Chat target cannot overwrite the newer
choice. Future connections use the new target. Temporary CLI sessions work
before or after personal selection and never set or overwrite the Chat target.

The raw CLI remains available for all upstream parameters, custom executable,
persistent-profile and CDP operations. Raw CLI attachment is lower-level and does
not update the tracked Chat target. `browser_connect` requires a standard channel
installation and rejects an inherited `PLAYWRIGHT_MCP_EXECUTABLE_PATH` override
rather than mislabel a custom executable as that channel's installed browser. For example, single-Agent extension use is:


```sh
playwright-cli -s=personal attach --extension=msedge
# Or select Chrome explicitly:
playwright-cli -s=personal attach --extension=chrome
playwright-cli -s=personal run-code 'async page => ({url: page.url(), title: await page.title()})'
playwright-cli -s=personal detach
```

Upstream selects the initial profile, opens its connection page through the
normal browser executable and requests authorization. Do not launch another
automation browser against a running personal user-data directory or copy
Cookies. Use a distinct session name and keep passing it on later commands.
Choose only a task-relevant tab explicitly handed over by the user; unrelated
user pages are not implicit permission to take control. An authorized connection
is separate from website authentication: inspect actual page content when the
task needs a login. An unauthenticated website is not a broken browser connection
and is not a reason to search other profiles or change accounts.

If upstream reports the extension missing, retain its actual error and profile
location. In that same Chrome or Edge profile, open the
[official Playwright Extension store page](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm),
choose **Add to Chrome** / **Get**, confirm adding it and keep it enabled. In Edge,
if prompted, first allow extensions from other stores. Retry the same connection
after installation. Do not automatically install the extension. An installation
record does not prove that the extension is enabled, a connection authorized, or
the website logged in. A pending authorization is not proof of a missing
extension; report uncertain connection failures as uncertain.

The normal upstream authorization page is sufficient; an extension token is not
a prerequisite. Do not copy or print its token or expose Cookies in diagnostics.
While authorization is pending, use normal yielding command sessions and Stop /
Steer rather than an unbounded background poll. When done, detach the personal
connection; do not close the whole user browser, clear its profile or sign out.
Close only pages owned by this task. Independently created temporary browsers
still use `close` as documented upstream.

## Login and connection handoff in ordinary chat

Keep connection authorization, website authentication and task completion separate.
A running `browser_connect` session can be waiting for the upstream picker:
explain the selected browser/profile and where to approve it, then yield with the
ordinary command tools. Missing-extension output warrants the installation steps
above; waiting, an unavailable page or an uncertain connection failure does not.
Do not configure an extension token merely to avoid the normal picker.

Inspect the actual selected page before deciding that the task needs a login.
Public content can be used without signing in; an existing valid login needs no
additional request. If protected content requires user verification, identify the
task page and ask the user to complete it in that same profile, then reply in this
Chat. Retain any login/intermediate page and its unfinished form; detach instead
of closing it. Record the task-relevant page identity in the ordinary answer so
the next Root can identify the handoff. Do not print authentication material.

An ordinary reply starts a new Root, with the existing Chat history and saved
personal target. Call `browser_connect` again and explicitly reselect the handed
over page in the upstream picker. A saved target is not permission to acquire
unrelated pages or a still-owned page of another Agent. Observe the actual page
and protected content before continuing: "done" is not proof of login. If the
user has not completed verification, retain the page and explain the remaining
step. Expiration follows the same target and handoff; never search other
profiles or change accounts to recover it. A missing page is a real failure to
report, not permission to silently substitute another page.

There is no browser-specific question tool or resumable old Agent. Stop, Steer
and shutdown end the current execution; late login or connection approval must
not restart it. A later explicit submission reconnects and observes state anew.
Neither successful handoff nor cancellation guarantees that a website preserves
its intermediate state indefinitely; sites may expire forms or reject automation.

#187 and #188 of [#186](https://github.com/tylerlong/weft/issues/186) provide
single-Agent extension access and saved Chat target inheritance. #189 verifies
ordinary-chat login handoff and canceled pending authorization through the real
extension. Chrome concurrency and owned lifecycle cleanup are covered by #190
below. Both-browser final compatibility belongs to #191. Shared browser Cookies
and website account state are not isolated by tabs.

## Concurrent pages and lifecycle (#190)

Each Agent uses its own CLI registry and extension client. The official extension
assigns each client a separate tab group; new tabs and popups belong to that
client, and moving a tab out of or back into the group removes or restores its
access. A client does not automatically acquire another client's or an unrelated
user tab. Reconnection still uses the upstream explicit page selection.

Agent completion, Stop, Steer and service shutdown stop registered CLI sessions
from that Agent's scratch registry through the pinned upstream `Session.stop`.
This releases an attached personal connection while retaining its pages and
profile; temporary browsers owned by those sessions close normally. Cleanup is
bounded to 10 seconds and uses no global `kill-all`. A failed cleanup is
saved as a redacted `cleanupError` in the most recent command state; a
non-cancelled Agent reports `toolCleanupFailed`, while a cancelled Agent keeps
its cancellation status. Shutdown reports cleanup failure to its close callback
and still releases database ownership. The pinned
registry/session interfaces must be revalidated when Playwright is upgraded.

While a structured `browser_connect` is still waiting for approval, its daemon
has not yet written a registry entry. Cancellation first uses the existing
native interrupt and allows at most one second for the CLI's startup signal
forwarder, then retains forced termination. This is trusted connection wiring,
not a model-selectable generic command option. Ordinary commands keep their
immediate forced cancellation, so interrupting a shell cannot run its trailing
commands during a grace period. Do not use raw CLI attachment to bypass the
tracked connection lifecycle.

`test/browser-isolation-extension.test.ts` is opt-in via
`WEFT_TEST_EXTENSION_CHANNEL=chrome`. The actual Chrome 156.0.8078.48 /
extension 0.4.0 / CLI 1.63.0 run on macOS passed: two concurrent Sub-agents and
a Root in another Chat saw only their own pages, independently filled inputs and
navigated new tabs, and kept their popups in the correct groups. An actual tab
move out/in removed/restored access; stopping one Sub-agent retained the other
clients' input and pages. Those clients closed only their own extra pages, and
explicit detach/reconnect recovered the remaining page. Completion and Stop
released all three groups without closing the retained pages or user browser.
The operator removed only this run's localhost tabs afterward.

The popup check uses the upstream `bringToFront` on its intended page and
sequences popup clicks while all three clients remain connected. Background-page
popup attempts in the initial test timed out without creating a popup; foreground
control is shared and is not the isolation evidence. Actual owned URL lists,
input values and group membership establish the tested page scopes. The test
uses a controlled model fixture, so it does not prove real-model task judgment.
Edge concurrency remains for #191; this Chrome result does not establish it.

Shared Cookies, same-origin storage, browser focus and website server state can
still affect other clients. Tab ownership is not account or storage isolation.

## Execution and validation

Commands run through the existing `process/start` RPC with `sandbox: null`, as the current system user. The global Jev review switch applies to browser command Tool Calls just as it does to other tools. Parameter validation, cancellation, ownership and records remain in effect. This is best-effort review, not a browser or process sandbox.

`test/browser-tools.test.ts` checks the bundled skill and CLI from an unrelated temporary target. Browser validation uses the normal execution environment; obsolete restricted-mode launches that caused macOS Chromium startup aborts are removed. On macOS, lifecycle checks correlate newly written crash reports with this run’s Chromium PIDs and time window, excluding unrelated processes.

`test/browser-diagnostics.test.ts` uses the application HTTP API, controlled
model responses and real native execution. The model starts a localhost website
as a yielding command session, opens a named CLI browser session, starts trace,
clicks a page button, reads console and indexed network metadata, reads the
POST request and response bodies separately, and verifies the resulting DOM with
`run-code`. It takes a screenshot, explicitly invokes `read_image`, and verifies
the native `input_image` content array against the image bytes and persisted
Tool Result/Model Call records. It stops trace, closes and lists its browser
session, then interrupts its server command session. These operations cross
multiple CLI invocations and retain their actual command output and ownership.
The same HTTP-submitted task includes project instructions, a selected explicit-only
Skill and a user image. It discovers a configured Streamable HTTP MCP tool
alongside the built-ins, calls it after browser diagnosis, retains both image
entry points and actual request records, and checks MCP session cleanup.
The test explicitly selects upstream `outputMode: stdout` for inline diagnostic
assertions; production CLI defaults are unchanged. Native CI installs Chromium
and runs both tests on macOS, alongside the existing lifecycle tests.

Upstream detached CLI daemons can outlive a command and have their normal idle
timeout. The model must close browsers it owns; Weft does not add a Chat lifetime
policy or automatic personal-browser attachment. Browser artifacts use the
chosen cwd and normal file permissions, so save wanted screenshots and trace
files in a Target Folder. No paid model calls were used; protocol evidence does
not prove that a paid model interpreted the image or chose the right operation.

### Real extension acceptance (2026-10-26)

Playwright CLI 1.63.0 with official extension 0.4.0 connected to Edge
156.0.4314.42 (Default) and Chrome 156.0.8078.48 (Profile 2) on macOS. The
operator completed the ordinary extension picker using only the designated
test tab. No extension token was configured. Edge also read the already logged-in
private `tylerlong/sanguosha` repository: the actual page contained the Private
marker and repository file table. That read-only check detached without closing
the existing repository tab or browser; it did not modify the repository or
request another login.

`test/browser-extension.test.ts` is an explicit opt-in real-browser acceptance:

```sh
WEFT_TEST_EXTENSION_CHANNEL=chrome node --test test/browser-extension.test.ts
WEFT_TEST_EXTENSION_CHANNEL=msedge node --test test/browser-extension.test.ts
```

It prints an ephemeral localhost URL. Open it in a new tab of the selected
profile, click **Test login**, then select only that tab in the extension picker
(refresh the picker if the new tab is not listed). HTTP -> controlled model
fixture -> actual command wrapper/CLI/extension navigates the authenticated page,
reads protected content, records Tool Result and Command Output, closes only the
test page, and detaches. It uses an independent temporary database/directory and
a unique test Cookie. It does not inspect personal Cookies or authenticate a
real account. Both browser paths were exercised; this opt-in test is skipped in
unattended CI. The regular HTTP diagnostics test also verifies actual missing
extension output against a fake host HOME and retains the official store link;
the native browser test checks that another Agent cannot list the first Agent's
CLI session. These checks do not establish concurrent extension page ownership,
manual SMS/system verification, target inheritance, or service-restart recovery.

## Primary sources

- [Official Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Playwright 1.63.0 sources](https://github.com/microsoft/playwright/tree/v1.63.0)
- [Codex 0.162.0 process sandbox preparation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/process_sandbox.rs)
- [Codex 0.162.0 sandbox selection](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/sandbox_selection.rs)
- [Codex 0.162.0 sandbox manager](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/sandboxing/src/manager.rs)

### Chat target acceptance (#188)

`WEFT_TEST_EXTENSION_CHANNEL=msedge node --test test/browser-target-extension.test.ts`
runs the opt-in HTTP → model fixture → real CLI/extension target scenario. Only
its localhost page is selected in ordinary extension approval; no extension
token is configured and no real account state is changed. It covers temporary
browsing before/after selection, later Roots, a Sub-agent, service restart,
implicit-change rejection, explicit browser change and independent Chats. It also
holds an old Sub-agent connection pending while the Root changes targets, then
confirms that the late connection retains its actual old target without replacing
the new Chat target.
The follow-up supplies a conflicting upstream default-profile environment value
while the saved target still connects. A separate discovery-only test uses
synthetic extension installation records and a changed `Local State` recent
profile to establish that upstream initial discovery changes while an already
selected target stays pinned. Those records do not simulate a successful
extension connection. Real-browser behavior and fixture model decisions are
separate evidence; no paid model was used.

Chat targets add schema version 27. In accordance with ADR 0001, unsupported
older databases are rejected and preserved, without automatic migration or
rebuilding. Validation uses a disposable test database, not the user's database.

### Ordinary-chat handoff acceptance (#189, 2026-10-27)

```sh
WEFT_TEST_EXTENSION_CHANNEL=chrome node --test test/browser-handoff-extension.test.ts
WEFT_TEST_EXTENSION_CHANNEL=chrome node --test test/browser-authorization-extension.test.ts
```

Both opt-in scenarios ran with the real Chrome 156.0.8078.48 / official extension
0.4.0 / pinned CLI 1.63.0 on macOS. Native UI supplied only the designated
localhost page in each ordinary upstream picker and simulated the controlled
login/checkpoint buttons. No token was configured. Temporary servers, ports and
databases were independent of the user service. The login test creates its own
unique localhost Cookie; it does not inspect or alter real account credentials.

The handoff test submits five ordinary HTTP Chat messages. Roots finish without
an explicit detach, so normal Agent cleanup must release their connection while
preserving the intermediate page and exact unsubmitted input. A premature
"continue" still observes the login page. After controlled user login, a new
Root reselects the retained page and reads actual protected content. Controlled
session expiration repeats the same-target login/reply/protected-read path.
The final Root closes only its test tab. These are browser observations, not
Cookie-existence or user-confirmation assertions.

The authorization test observes actual pending pickers before HTTP Stop, Steer
and service shutdown. For each canceled connection, a subsequent native approval
attempt reports the real upstream relay WebSocket error; the old model loop
does not resume and no Chat target is saved. After restart, a newly submitted
Root explicitly reconnects and reads the unchanged controlled page. Native
observation checkpoints are part of this opt-in acceptance, not a mocked
extension or an unattended CI test.

Initial missing-extension failure, user installation and later successful
Chrome/Edge attachment were observed across #187's blocked/resumed execution;
the tests do not automatically install or recreate marketplace installation.
The existing read-only Edge private-repository check is recorded above. #189's
complete login/cancellation scenarios were run in Chrome; the final compatibility
ticket separately covers Edge. No SMS, fingerprint, passkey or paid-model decision
quality was tested. Website-specific expiry and automation restrictions remain.
