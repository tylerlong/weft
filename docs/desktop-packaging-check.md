# Desktop packaging compatibility check

On 2026-10-28, an isolated Electron application demonstrated the core desktop
path on this Mac: launch from Finder, start the existing Weft server, load the
existing UI, execute native commands, use SQLite, control installed browsers,
and stop the owned backend and tools on Quit. This establishes feasibility for
[ADR 0012](adr/0012-desktop-application.md), not a completed desktop release.

The successful shape was an Electron window with a **bundled standalone Node
backend process**. Production server and tool source files were copied unchanged;
the probe supplied local model HTTP fixtures, temporary data and lifecycle wiring.
It did not test running the backend inside Electron's own Node environment.

Environment: source commit `ce4717a981dbf1212c6da6d521e19e93b928d432`, macOS
26.7.1 on Apple Silicon, Electron 45.0.0, backend Node 24.21.0, Playwright 1.64.1,
installed Chrome 156.0.8078.73 and Edge 156.0.4314.50. Dependencies followed the
repository lockfile. No production dependencies or application code changed.

| Check                     | Observed result                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Finder launch             | Packaged `.app` launched with parent PID 1, working directory `/`, and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.                                                                                                                                                                                                                                                                                           |
| UI and local server       | Existing React UI loaded over an automatically allocated loopback port. Authenticated API returned 200; unauthenticated API returned 403. Renderer had no Node integration.                                                                                                                                                                                                                            |
| Native commands           | Existing Agent/tool path used the actual Codex exec-server. Bundled Node, system Git and bundled ripgrep ran successfully without a terminal development PATH.                                                                                                                                                                                                                                         |
| SQLite                    | Actual Weft Project/Chat/Agent/tool records were written to a private scratch database. Project and history survived closing and reopening the app. Integrity checks returned `ok`.                                                                                                                                                                                                                    |
| Installed browsers        | Chrome and Edge each opened a controlled localhost page through the existing `playwright-cli` command wrapper, filled an input, clicked a button, and verified the changed page content. No extra browser runtime or extension was used.                                                                                                                                                               |
| Active-work Quit          | Immediately before shutdown, the database still had one pending Agent and its child command was alive. Quit awaited actual server cleanup; backend exited 0 in about 0.14 seconds. All 14 tracked processes, including the browser session, were gone afterward, both test listeners were closed, and the command's delayed output file was absent. The command was recorded as interrupted/cancelled. |
| Idle Quit after reopening | Backend exited normally, all seven tracked processes were gone, both listeners were closed, and database integrity remained `ok`.                                                                                                                                                                                                                                                                      |
| Development tools         | A follow-up packaged-backend check reset PATH to the GUI minimum, recovered PATH through the user's `/bin/zsh -ilc`, then used the actual command tool to run pnpm 11.28.8, Docker 29.9.0, Python 3.13.5 and Git 2.56.0. This PATH recovery is probe wiring, not yet a production feature.                                                                                                             |

Two requirements emerged for implementation:
- **Preserve a self-contained dependency tree.** Default packager copying
  dereferenced pnpm links and broke a transitive dependency import. Disabling
  dereferencing retained links but rewrote their targets back to staging. The
  successful bundle restored the original relative link targets, had zero links
  outside the `.app`, and passed the standalone trials while the original staging
  path was unavailable. Packaging must validate this rather than depending on the
  developer checkout or pnpm store at runtime.
- **Recover the user's development PATH for GUI launches.** The minimal Finder
  environment found system Git/Python and Weft's bundled tools, but could not find
  the installed pnpm or Docker. The login-shell check demonstrated a working path
  on this machine; production startup needs equivalent handling and startup-error
  reporting. This does not bundle or configure project dependencies.

The environment check also exposed a Corepack prerequisite: running pnpm in a
bare scratch directory selected an uninstalled default version and its configured
registry returned 404. Giving the scratch project an explicit
`packageManager: pnpm@11.28.8` and running in that project succeeded. The failed
trial is retained; no user registry or package-manager configuration was changed.

Window close/reopen retained the same backend and port in a separate observation.
That observation is not proof of active-task continuation: the trial command's
timeout elapsed during the UI checks. The final active-work Quit trial used a
longer fixture timeout and explicitly checked that the Agent and command were
still alive before shutdown. This was a bounded packaging smoke check, not a
general cancellation stress test.

All model and safety-review HTTP responses were local fixtures; file access,
SQLite, HTTP serving, command execution, browser actions and process cleanup were
real. No paid model calls, personal-login browser connections, existing Weft
database access, signing, notarization, installer/update tests, Intel builds or
clean-machine validation were performed. The probe omits production quit
confirmation, single-instance handling and startup/crash recovery. Its resources
were unpacked; ASAR packaging was not tested. An unoptimized bundle occupied about
0.8 GB, which is not a final release-size estimate.

The private local evidence archive `weft-desktop-probe-2026-10-28` contains the
probe source, manifest, successful and failed trial logs, screenshots, scratch
database, process inventories and shutdown assertions. Generated runtimes and
dependencies are omitted from that archive; the disposable built app remains in
the probe's temporary directory. The archive's packaging recipe was captured for
reproduction; a fresh rebuild from the archive was not repeated.

## Implementation slice #199 (2026-10-28)

`pnpm desktop:build` and `pnpm desktop:start` now build the local macOS arm64
snapshot into ignored `desktop-output/Weft.app`. The implementation uses pinned
Electron 45.0.0, `@electron/packager` 20.3.0 and standalone Node 24.21.0; Node
archives are checked against the vendor's HTTPS `SHASUMS256.txt`. The production
resource tree is installed from the lockfile, its relative links are restored
and every final bundle link is checked to resolve inside the app. pnpm's local
installation metadata is removed. Desktop main syntax and backend imports are checked with staging
renamed unavailable and a minimal PATH before the previous app is replaced.

The committed `pnpm test:desktop` checks use a disposable relocated copy with
spaces in its path, private fixture application-data storage and local HTTP model
responses injected through the existing server constructor. Native commands,
SQLite, HTTP authorization, Electron and cleanup are real. The main acceptance
check has passed with:
- Bundled Node and ripgrep through the HTTP → Agent → Tool Call path; the command
  sees the bundled Node executable and no management-token environment variable.
- Authorized UI/API access and rejection without management authority; renderer
  Node access is absent. The ordinary server entry remains unchanged.
- Both build commands refusing a live app with its window open and closed,
  leaving the output and the same HTTP backend intact. An actual native command
  is observed ready and remains live throughout every refusal and window close.
- A subsequent executable launch reopening the existing instance, Dock activation,
  idle Quit closing the listener, reopen preserving Projects, and private storage
  permissions (`0700` directory, `0600` database) with SQLite integrity `ok`.
- A relocated launch with the complete disposable checkout and its dependency installation unavailable, followed by a cold LaunchServices launch from outside the checkout, parent PID 1 and cwd
  `/`, becoming usable through the packaged UI and quitting cleanly.
- An existing Tool Call Copy control succeeding through Electron clipboard permissions, limited to sanitized writes from the owned application origin.
- Invalid frontend and desktop-entry source preserving the previous successful app and
  making `desktop:start` fail; a backend source edit appearing only after rebuild.

The suite also checks the bundled production backend's incompatible-schema
failure without changing the database bytes and unsupported-host refusal before
output changes. No custom running marker exists: live bundle identity comes from
macOS `NSRunningApplication`; stale files alone cannot authorize an app match.

This slice does not complete Finder login-shell PATH recovery or installed-browser
acceptance (#200), active/queued Quit confirmation or all startup/crash feedback
(#201), or the final integrated acceptance (#202). It does not resolve #193's
separate cancellation race. No paid calls, personal browser state, real Weft data,
public distribution, signing/notarization or clean-machine checks were used.

Validation for the #199 implementation: formatting and typechecking passed;
`pnpm test:desktop` passed both packaged checks; `pnpm test:e2e` passed all 230
frontend checks. The final `pnpm test` run passed 330 tests with six opt-in
extension checks skipped. An earlier full run failed the existing native
“service restart retains interrupted command chunks and never replays native
work” check: its delayed-effect file existed unexpectedly. That exact test and
the full suite subsequently passed without cancellation-code/assertion changes.
The initial failure remains evidence of the separately tracked #193 race, not
proof that this desktop work fixed it. Read-only Standards and Spec reviewers
accepted the corrected #199 snapshot with no remaining findings; their initial
findings produced scoped clipboard permission, staged entry validation, complete
checkout isolation, and fixture-cleanup corrections.

## Finder environment and installed-browser delivery (#200)

The local desktop entry now obtains PATH from the user's interactive login shell
before starting the bundled backend. It inherits only the NUL-delimited PATH,
not shell output or other shell-exported values; normal HOME and the inherited
configuration remain available. Startup fails visibly if shell startup fails,
yields an empty PATH or exceeds 15 seconds. Existing command-tool precedence and
management-token stripping remain unchanged. This does not install or configure
Git, project package managers, Docker or external MCP services.

The expanded `node --test test/desktop/build.test.ts` acceptance uses the real
packaged Electron application, standalone Node backend and HTTP → fixture model
→ native Tool Call path. Runtime/model fixture wiring exists only in disposable
app copies, with separate private SQLite data. A complete disposable checkout
and its dependency tree are renamed unavailable during native and browser runs.
The relocated app path contains spaces and is launched with a minimal GUI PATH.
A separate cold LaunchServices launch verifies parent PID 1, cwd `/`, and actual
native Node/ripgrep/Git/project-pinned pnpm execution, rather than UI readiness
alone.

On macOS 26.7.1 arm64, with Electron 45.0.0, standalone Node 24.21.0 and
Playwright 1.64.1:
- Real Git and pnpm 11.28.8 resolve through recovered PATH. The scratch project
  explicitly pins that pnpm version; bundled Node/ripgrep still take precedence.
  Before the PATH change, the same minimal-environment native command exited 127.
- Installed Chrome 156.0.8078.73 and Edge 156.0.4314.50 each opened a controlled
  localhost form through the bundled CLI, filled an input, clicked Apply and
  returned the changed output. No downloaded automation browser or extension was
  used. Tracked temporary-browser processes were absent after normal Agent
  cleanup, and the seeded saved Chat personal target remained unchanged.
- A task explicitly configured with a nonexistent browser executable returned the
  upstream actionable executable-not-found error. A subsequent native task in
  the same Chat succeeded. No installed browser was removed or modified, and no
  fallback browser/profile was selected.

The fixture also preserves #199's build/refusal/relocation/data assertions.
Initial test-fixture issues (missing command cwd for the package-manager pin and
a favicon GET incorrectly treated as model JSON) were corrected without changing
production execution behavior. Version discovery does not establish complete
Docker or external MCP integration compatibility. Personal browser extension
approval/login behavior was not re-exercised; existing connection semantics and
regressions remain unchanged. No paid calls, real Weft databases, personal login
or browser state were used. Clean-machine installation remains untested.

The complete expanded packaged suite passed 2 tests in 72.5 seconds. Cold
LaunchServices native output reported Node 24.21.0, ripgrep 15.2.0, Git 2.56.0 and
pnpm 11.28.8; its inherited GUI PATH remained
`/usr/bin:/bin:/usr/sbin:/sbin`, while backend command discovery used the recovered
login-shell PATH. Sixteen tracked temporary browser processes were gone after
the two browser tasks. This evidence extends the historical probe and #199's
foundation checks; it does not replace the pending integrated #202 validation.

Fixture browser configuration is isolated in the disposable backend copy:
`PWTEST_CLI_GLOBAL_CONFIG` points to its empty fixture home, and inherited
`PLAYWRIGHT_MCP_*` options are removed there before launching tasks. Normal HOME
and login-shell PATH discovery are retained. Production does not clear browser
configuration. The test's saved personal-target directory is also asserted never
to have been created or contacted by temporary browser tasks.

The initial #200 full native run reported 328 passed, 2 failed and 6 skipped:
responsive HTTP shutdown did not observe its `ready` output before its assertion
(`test/command-shutdown.test.ts:120`), and root/child cancellation observed a
`root-escaped` or `child-escaped` delayed-effect file where ENOENT was required
(`test/command-tools.test.ts:752`). These tests and their imported server/command
sources are unchanged by #200 and do not import the desktop entry point. The
latter is consistent with the separate #193 cancellation investigation; these
results are preserved and not claimed fixed by this desktop work.

At `cafc9bf`, the configuration-isolated packaged suite passed 2/2 again (72.5 s).
Both initially failing native cases passed in isolation (0.9 s), and the complete
`pnpm test` rerun passed 330 with 6 opt-in extension skips and no failures (75 s).
No production native changes or assertion relaxations were made between these
runs; the first failures remain intermittent limits, not resolved defects.
Formatting/typechecking passed, and independent Standards/Spec reviews found no
remaining findings. Remote CI and the final combined #202 checks remain separate
validation of their exact source revisions.

## Lifecycle slice #201 (2026-10-28)

The desktop now requests a read-only, application-wide work-state snapshot from
its owned backend on Quit/Cmd+Q. This includes running Agents, root/steering work
and unstarted queues, including queues left idle after a failed or cancelled
Root. The native confirmation defaults to Cancel and explains interruption,
queue loss and completed effects. Cancel sends no stop/cancel/dequeue operation.
Idle or confirmed Quit uses the existing server close callback, which waits for
Agent/tool/database/ownership cleanup; the app reports failed cleanup and exits
nonzero. Closing a window still leaves the backend running. There is no new
replay, process sweep, cancellation engine or detached-process guarantee.

The app also bounds backend readiness waiting, preserves data-directory errors,
and displays sanitized resource/startup/backend-exit/cleanup errors. This does
not print backend stderr, management authority or provider credentials.

Lifecycle acceptance uses `node --test test/desktop/lifecycle.test.ts` and
`node --test test/desktop/failures.test.ts`; `test:desktop` serializes files so
fixture applications cannot compete for the desktop identity. On macOS 26.7.1 arm64 with Electron 45.0.0, bundled Node 24.21.0
and Chrome 156.0.8078.73, the two files passed all ten checks (eight failure subcases):
- A ready native command survives window close/reopen, second launch and Cancel.
- Cancel preserves an idle retained queue separately from active work; confirmed
  queue-only Quit drops it without replay on restart.
- Confirmed active-work Quit observes the native command and temporary Chrome
  processes live immediately before the request, then verifies every tracked
  process and backend has exited, the HTTP listener is closed, interrupted Tool
  Call output is saved and the desktop database can be reopened. Queued input
  is absent after reopen; a delayed command effect and model replay remain absent.
- Missing shell/Node/backend resources, an incompatible schema, a blocked data
  directory, the actual 30-second readiness deadline, unexpected backend exit
  and failed cleanup all produce sanitized errors and nonzero exit. The
  incompatible database bytes and a blocked directory's existing file survive.

Automated lifecycle tests capture/select OS dialog results in the disposable app
wrapper; production lifecycle, HTTP, model fixture, SQLite, native command and
Chrome paths remain real. A separate actual native-dialog check used the visible
macOS warning and clicked **Cancel**, verified the live Agent and queue unchanged,
then clicked **Quit Weft** and observed exit zero, the closed backend and the app
absent from macOS's running-app inventory. This check used private fixture data
and a held model response; it did not use personal credentials or paid calls.
The automated failure check exposed and corrected an early data-directory
failure that could otherwise reach Electron's single-instance setup and exit
successfully before displaying the useful error.

These checks do not resolve the separate #193 cancellation race, guarantee
reclamation of deliberately detached processes, or replace final integrated
acceptance in #202. No clean-machine, signing/notarization, real-data import,
personal-browser login or public-distribution checks were performed.

For #201, an initial full unit/native run passed 329 tests, skipped six opt-in
checks and reproduced two existing delayed-effect failures in
`command-tools.test.ts`: “root cancellation waits for real root and child command
cleanup” and “service restart retains interrupted command chunks and never
replays native work”. Both exact cases then passed together in isolation. No
command/cancellation implementation or existing assertion was changed. These
intermittent #193 failures remain recorded; a successful rerun is not a fix.

Final integrated local validation for #201 used production lifecycle code at
`ba6d65d` on top of #200's `e6cf0c9`: `pnpm test` passed 331 tests with six
opt-in extension skips and `pnpm test:e2e` passed all 230 checks. Subsequent
`e753031`/`e932bf0` changed only desktop fixture cleanup/configuration and
evidence. Formatting and typechecking passed at the final state; the complete
serialized `pnpm test:desktop` passed all 12 checks in 168 seconds with those
fixture follow-ups, combining relocated build/tooling/browser acceptance,
eight failure scenarios and window/Quit/owned-cleanup acceptance. Standards and
Spec reviewers rechecked the integrated changes and the fixture-isolation and
failure-cleanup follow-ups with no remaining findings. The final result-only
commit and its exact remote CI remain separately identifiable in #201's result
comment; final cross-ticket acceptance is owned by #202.

A final #201 resource audit reproduced a missing-frontend startup defect: with
`dist/index.html` absent, the app remained running on an HTTP error page and
never presented the useful desktop error. Desktop startup now checks that the
bundled frontend entry is readable before spawning the backend, so missing or
unreadable content reaches the existing sanitized startup error and nonzero
exit. The failure suite includes this ninth scenario; the earlier twelve-check
combined run above predates this guard and is not evidence for it.

Spec review accepted a further resource finding: a readable entry could still
reference missing JavaScript/CSS and load a blank window. A missing-JavaScript
packaged red check reproduced that failure at the same 15-second deadline. The
startup guard now reads the Vite entry's local `/assets/` references as well,
using the existing generated HTML format rather than adding an HTML dependency.
Separate missing-JavaScript and missing-stylesheet cases extend the failure
matrix to eleven scenarios. These checks run before the backend/database opens.

On resource-corrected snapshot `3f35120`, the serialized failure/lifecycle files
passed all 13 checks in 106 seconds, including missing entry, JavaScript and
stylesheet cases and the normal native/Chrome Quit path. Formatting and
typechecking passed. Standards and Spec reviews cleared this snapshot; the
accepted Spec resource finding was corrected by validating the referenced
assets, with no rejected findings. The earlier full unit/frontend results cover
the unchanged server/frontend code; exact final remote CI is recorded in #201.
The full combined twelve-check run above predates the three resource cases and
must not be read as a fifteen-check run of the later state.

Remaining #201 validation limits: actual Dock-icon clicking was not separately
performed (activation events and real duplicate executable launches were
exercised). Packaged Quit measured native command and temporary Chrome cleanup;
external MCP services and Edge active during Quit were not separately exercised.
Existing MCP regressions passed, and #200 separately exercised real Edge page
interaction and owned cleanup. Final parent-level acceptance remains #202.

## Integrated local desktop acceptance (#202, 2026-10-28)

The complete #198 contract was audited against the combined implementation.
No additional production change was needed in #202. Production remains at
`5ab7f19`; `84d4493` and `30e66e5` add acceptance coverage and fixture cleanup.
The final serialized `pnpm test:desktop` passed **16/16** on `30e66e5` in
187.7 seconds, including all eleven startup/exit failure cases and native/Chrome
Quit cleanup. This combined run supersedes the earlier twelve- and
fifteen-check snapshots for integrated acceptance.

The build fixture additionally exercises a successful `pnpm desktop:start`,
not only refusal/error paths: it builds from the disposable checkout,
LaunchServices opens that output (parent PID 1), the frontend loads, and idle
Quit closes the listener and exits the captured Electron PID. A deliberately
same-named unrelated process and the existing localhost fixture listener remain
alive. Explicit `.env`, database and private-document sentinels stay outside the
bundle; its resource root contains only `desktop`, `dist`, `docs`,
`node_modules`, `package.json`, `runtime` and `src`, with only the selected
browser guide under `docs`. The build validates internal dependency links.
`git check-ignore` confirms application output and runtime cache are ignored;
`otool -L` shows the bundled Node links only macOS system libraries.

The combined suite also verifies relocated execution with the disposable
checkout unavailable, minimal GUI PATH, bundled Node/ripgrep, installed Git and
project-pinned pnpm, actual Chrome/Edge form interaction, missing-browser then
non-browser continuity, visible/closed-window rebuild refusal during live work,
failed-build preservation, source snapshots, private persistent data,
incompatible-schema preservation, authorization, single-instance/window
continuity, active/queued Cancel and Confirm, interruption history, owned
process/listener cleanup and no delayed effect or replay. Running-app detection
uses native live-application inventory, not a persisted marker; ordinary
database ownership tests cover stale ownership files separately.

Local `pnpm test` passed **331 tests**, with **six opt-in extension skips** and
no failures in 77.9 seconds. `pnpm test:e2e` passed **230/230** in 2.6 minutes.
These ran on the same production code before the desktop fixture-only cleanup
follow-up. Formatting and typechecking passed. Versions were macOS 26.7.1
arm64, build Node 24.21.0, pnpm 11.28.8, Electron 45.0.0, bundled Node 24.21.0,
Playwright 1.64.1, Chrome 156.0.8078.73 and Edge 156.0.4314.50; the database
source remains schema 28. Exact final remote CI and pushed revision are
recorded in #202's result comment.

Independent Standards and Spec reviews covered the full integrated diff from
`db2e2c8`. Two accepted fixture-lifetime findings were corrected: normal Quit
and observed PID exit before disposal, and preserving scratch on any failed app
cleanup while still closing the fixture HTTP server. Both reviewers cleared
`30e66e5`. Intermediate fixture runs exposed an early scratch-removal race and
errors in an added cleanup lookup; these were test-harness failures, not
production defects. The final fixture uses the established running-app guard
and the captured launch PID. Failed scratch was removed only after observed
normal app exit. The final running-app inventory was empty.

The #193 cancellation race remains unresolved; this integration run did not
reproduce it and does not supersede earlier recorded failures. Native CUA
reported the Mac locked, so an actual Dock-icon click was unavailable; the
activation handler and duplicate-launch reopening were tested instead. #201's
real native Cancel/Quit dialog evidence remains separate. No clean-machine,
live external MCP/Docker, Edge-active-during-Quit or personal-login/extension
acceptance was added. Signing, notarization, Intel/Windows support and public
distribution remain outside this delivery.
