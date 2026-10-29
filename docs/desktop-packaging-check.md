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
