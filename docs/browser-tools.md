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
Before connecting, the tracked path resolves configuration with the pinned CLI's
own merge rules in that Agent's scratch directory. Initial user-data roots from
environment or global CLI config are honored; relative roots become absolute in
that cwd before being saved. An older saved relative root is rejected instead of
being rebound against a new Agent cwd; replacing it requires explicit selection
of an absolute target. The extension's channel selection follows upstream
CLI/environment behavior (its extension launcher does not use a global launch
channel). Explicit arguments and an existing Chat target take precedence.
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
rather than mislabel a custom executable as that channel's installed browser.
Inherited CDP/remote endpoints, isolated mode and custom launch executables are
also rejected before another browser is contacted. These errors report the
incompatibility without printing endpoint or credential values. The generated
extension command pins root/profile and disables alternate transport selection
for that command, including if inherited config changes after resolution; raw
CLI calls retain all original environment/config behavior. For example, single-Agent extension use is:


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
below. Both-browser final compatibility evidence is recorded in the #191 matrix below. Shared browser Cookies
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
The #191 matrix below records the separate real Edge concurrency run; this Chrome result alone does not establish Edge compatibility.

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

Upstream detached CLI daemons can outlive a command, so Agent cleanup explicitly
stops only sessions in that Agent's registry. The model should still close temporary
browsers it no longer needs; Weft adds no Chat keepalive or automatic personal-browser attachment. Browser artifacts use the
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
matrix above separately records Edge. No SMS, fingerprint, passkey or paid-model decision
quality was tested. Website-specific expiry and automation restrictions remain.


### Final compatibility acceptance (#191, 2026-10-27)

The compatibility host is macOS 26.7.1 (25G241), Node 24.21.0, pinned Playwright CLI
1.63.0, Chrome 156.0.8078.48 and Edge 156.0.4314.50, with the official extension
0.4.0. Earlier Edge evidence used 156.0.4314.42; the following new Edge runs use
156.0.4314.50. No paid model was called. Each HTTP fixture supplies model decisions;
the real browser, upstream tool and persisted tool/command records supply the
execution evidence.

| Scenario | Actual evidence | Scope / remaining check |
| --- | --- | --- |
| Three clients, own navigation/new tabs/popups, tab move out/in, child Stop and independent Chat reconnect | Chrome #190 passed (198.5 s); Edge #191 passed (442.6 s) | Two Sub-agents plus another Chat; exact URL/input/group assertions. Native Ctrl-click exposes Edge's tab context menu; only the designated test tab was moved. |
| Ordinary chat, retained unsubmitted input, premature continue, protected read, controlled expiry and same-target re-login | Chrome #189 passed (180.3 s); Edge #191 passed (148.2 s); independent disposable Chrome profile #191 passed (317.5 s) | Exact saved channel/root/profile checked. Controlled localhost Cookie/site and disposable Weft database; no real account login or expiration. |
| Pending approval, Stop/Steer/shutdown, failed late approval and fresh explicit reconnect | Chrome #189 passed (218.4 s); Edge #191 passed (197.3 s) | An earlier Edge attempt timed out at a native observation checkpoint after focus changed; only the fresh complete run counts as passing. Late approval produced the actual upstream relay WebSocket error. |
| Chrome disposable profile window close/reopen and persisted login | Included in the 317.5 s dedicated-profile handoff run | All test-profile tabs/windows were closed, normal upstream attach reopened the same profile, and the next Root read protected content. The personal Chrome process stayed running; this does not establish a cold browser-process restart. |
| Real existing Edge account | #187 and the current Edge 156.0.4314.50 recheck read the private `tylerlong/sanguosha` repository's Private marker and file table without another login | The recheck used a fresh owned tab and returned only proof booleans. It closed that tab, detached and verified the isolated registry empty; existing user pages stayed open. |

The user explicitly authorized installing the official extension in and removing
a disposable test profile. Native Chrome created the signed-out profile
**Weft #191 Disposable** (actual directory `Profile 5`) in the existing installation;
no profile or Cookies were copied and no token was configured. The official
marketplace installed extension 0.4.0 there. After acceptance, Chrome's native
profile manager removed only that exact disposable profile; its profile-list
entry and directory were confirmed absent. Existing profiles remained.

The earlier attempt to use an independent `/tmp/weft-191-chrome-*` user-data root
could launch its own Chrome process, but the native tool could not select that
second process with the same app identity. Its exact owned PID was stopped and
its unused root removed. It is not counted as successful profile acceptance.
The approved same-installation disposable profile avoided changing existing
profile data or closing personal Chrome.

To repeat with an explicitly owned disposable profile, select the real root and
directory using the existing upstream `PWTEST_EXTENSION_USER_DATA_DIR` and
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` environment variables. For example:

```sh
WEFT_TEST_EXTENSION_CHANNEL=chrome \
  PWTEST_EXTENSION_USER_DATA_DIR=/absolute/chrome/user-data-root \
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME='Profile N' \
  WEFT_TEST_EXTENSION_REOPEN_PROFILE=1 \
  node --test test/browser-handoff-extension.test.ts
```

The optional checkpoint runs after the first controlled login. Close only that
disposable profile's window and observe its closure, then POST to the printed
`/profile-closed` checkpoint. The next HTTP Root reopens the saved profile through
normal upstream attach; open/reselect only the localhost page and verify actual
protected content before controlled expiry. The test uses a one-hour persistent
localhost Cookie so this checks still-valid login data. The checkpoint records a
native observation, not a mock close, and the test asserts the actual saved root
and profile. It does not claim that the whole Chrome process stopped.

Failure evidence is separated from successful attachment:

- Missing extension/selected profile: the regular HTTP diagnostics and target
  tests invoke the actual CLI against disposable HOME/profile paths, retain the
  upstream error/store link and leave the Chat unbound.
- Disabled extension: only Playwright in the disposable Chrome profile was
  disabled. Actual attach displayed **ERR_BLOCKED_BY_CLIENT** and never attached;
  its owned pending CLI was interrupted after 35 seconds and its isolated registry
  was empty. It was re-enabled before profile removal. This was a native UI/CLI
  probe; the HTTP pending-cancellation scenarios separately establish Chat and
  Agent state. Installation records alone did not prove a usable connection.
- Unfinished login and unanswered authorization remain incomplete; the handoff
  and pending-approval tests observe these states rather than assuming success.
- Actual owned page closure removes it from the client's URL scope, and tab move
  out/in loses/reacquires access without adopting another client's or unrelated
  page. Stop/Steer/shutdown and failed late approval are covered above.

The regular native browser regression also opens a temporary browser with the
public `--persistent --profile=<owned-directory>` arguments, writes local storage,
closes and reopens that profile, then reads the saved value. This is actual CLI
and native-command evidence, separate from the HTTP diagnostics' console,
request/response bodies, screenshots/read-image and trace checks. Raw CDP and
custom-executable arguments remain forwarded unchanged; no live CDP compatibility
claim is made.

The opt-in tests are skipped in unattended CI. Tests do not prove real-model
judgment, arbitrary website compatibility, SMS, fingerprint or passkey flows.
Marketplace installation and real-person authentication are not simulated as
successful extension acceptance. Shared Cookies, same-origin storage and account
server state remain shared even when page ownership is separate.

### Tracked configuration regression (#188 correction)

`test/browser-target-config.test.ts` exercises HTTP → model fixture → actual
native CLI for explicit roots conflicting with inherited environment and for
initial environment/global roots. Incompatible CDP/environment, global CDP,
global remote, isolated and custom-executable settings are rejected without
contacting a controlled alternate endpoint or exposing its synthetic secret.
A native command regression changes inherited config after preparing a saved
target and confirms that the CLI still looks up exactly that target, without
contacting the alternate endpoint. These tests need no personal profile or
installed extension. The opt-in normal extension check in the same file uses
`WEFT_TEST_EXTENSION_CHANNEL` and selects only its designated localhost page.

On 2026-10-27, the correction's new normal-path smoke passed against the real
installed Chrome extension after the Mac was unlocked (21.6 s). It checked the
actual localhost Page URL, saved target/command state, and heading in the CLI's
owned snapshot artifact; Agent cleanup detached the connection and only the test
tab was closed. The first run exposed a test assumption that snapshots were
inline; the harness was corrected to inspect the retained file, and the clean
rerun passed. This short check does not repeat the earlier full Chrome/Edge
matrix, website login/handoff, or cancellation acceptance.
