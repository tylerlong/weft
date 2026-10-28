# 浏览器登录复用与 Agent 并发调查

初次调查日期：2026-10-25，设计访谈更新至 2026-10-26。本文保留调查依据与设计收敛过程，最终边界以“已确认的选择规则”及 ADR 0008 的后续设计为准，不代表已实施或验证。产品文档描述其公开约定，尚未运行这些产品验证并发和真实登录。

已发布实施规格 [#186](https://github.com/tylerlong/weft/issues/186)。本文保留来源与设计过程，不取代该规格的交付和验收要求。

## 当前 Weft

`src/command-executor.ts` 为每个 Agent 分配 scratch，并在 Playwright CLI wrapper 中将 HOME 指向该目录；`src/server.ts` 的 scratch 标识包含服务实例 UUID 和 Agent ID。默认不跨 Agent 复用 CLI 会话或浏览器资料。上游 CLI 已支持持久化 profile、指定 profile 目录、连接现有浏览器和保存／加载 storage state。

[ADR 0008](adr/0008-third-party-browser-and-desktop-tools.md) 当前规定沿用上游 CLI／skill、独立 profile，由模型关闭其浏览器，不增加 Chat 保活或另一套会话框架。跨任务管理浏览器、共享 profile 或页面归属若需要新增协调机制，应明确调整这项决定，不能描述为已实现行为。

## 官方实现对照

| 来源                                                                                                               | 公开行为                                                                                                                                           | 对设计的约束                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp#user-profile)                                         | 持久化 profile 按 workspace 区分；同一 profile 只能由一个浏览器实例占用；并发客户端可用 isolated context 或不同资料目录；支持扩展连接已有浏览器。  | 不能让多个 Agent 分别启动浏览器并指向同一个 profile。MCP 默认持久化不代表 CLI 默认持久化。        |
| [Playwright Pages](https://playwright.dev/docs/pages) 与 [Isolation](https://playwright.dev/docs/browser-contexts) | 一个 BrowserContext 可以有多个 Page；Page 可通过明确引用操作，无需抢前台；不同 context 隔离 Cookie 等浏览器存储。                                  | 独立 tab 可以隔开页面操作，不能隔开同 context 的 Cookie、同源 localStorage 或网站服务端账号状态。 |
| [Browser Use Cloud](https://github.com/browser-use/browser-use/blob/main/skills/cloud/references/sessions.md)      | 一个 session 内顺序执行 agent；profile 跨 session 保存；并发 session 读取启动时快照，看不到彼此后续修改；结束 session 时保存 profile；可人工登录。 | 复用登录快照是一条现成路线，但不等于实时共享登录变化，也不能据此推断并发写回可安全合并。          |
| [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)                       | 将浏览器用户资料保存并复用于后续 session，包含 Cookie 和站点数据。                                                                                 | 持久化资料与运行中的 session 分开建模；其产品 Context 不等同于 Playwright BrowserContext。        |

[Playwright Authentication](https://playwright.dev/docs/auth) 提供 storage state 复用方案，但通用状态文件不自动覆盖 sessionStorage。复制登录状态也不能隔离同一账号在网站服务端的修改；官方并行测试建议对会互相影响的任务使用不同账号。

## 早期设计分支（以下方已确认规则为准）

已确认需求：Chrome 和 Edge 均须正式支持，分别验证人工登录、并发页面归属和跨任务登录复用；不能以 Edge 举例而将范围收窄为仅支持 Edge。各浏览器／profile 的登录资料不自动互通。
1. 实时共享一个登录环境、各 Agent 独立页面，还是为各 Agent 创建独立环境并加载登录快照？前者需要处理退出／换账号的共同影响，后者需要决定登录更新传播及保存冲突。
2. 第一版是否必须连接用户日常 Edge，还是允许使用人工登录过的 Weft 专用浏览器？
3. 登录资料共享范围是所有 Project、单个 Project，还是显式选择的账号环境？

以上决定后再细化：页面与 popup 归属、工具调用是否有共享的“当前 tab”、人工接管暂停范围、账号级修改冲突、Agent 结束／Stop／服务重启时资源清理、持久化资料的清除与账号切换。仅要求模型“不操作别人的 tab”不构成程序层面的页面隔离；当前 Full Access 模型也不承诺对恶意命令的安全隔离。

## 初步判断

公开实现没有统一的“所有 Agent 共用 profile、每人一个 tab”默认答案。应分别确定登录资料的生命周期、浏览器存储的共享范围、页面归属。先确认需要的产品行为，再验证固定 Playwright 版本能否以公开接口满足，避免先引入另一套浏览器控制层。

## 补充：优先直接使用上游扩展

进一步检查 [Playwright v1.63.0 扩展说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md#multiple-clients)，已明确支持 Chrome／Edge／Chromium 的多个并发客户端：每个客户端拥有独立命名、颜色区分的 tab group，只能看到组内页面；一个 tab 同时只能属于一个客户端。用户可以通过拖动 tab 改变归属，并从扩展状态页分别断开连接。浏览器原 profile 提供已有登录状态及跨任务持久化，人工继续在浏览器内完成验证。

这与直接共享 BrowserContext 的 MCP 服务是两条不同路径。检查上游 `main` 的 [Context 实现](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/context.ts)，普通共享 context 会收集全部页面，不能据此假设有每客户端页面归属。

优先候选因此改为：每个 Agent 使用自己的 MCP 客户端／服务进程，经官方扩展连接同一已登录浏览器；页面归属交给扩展。Weft 现有 MCP 已按 Agent 独立连接并在结束时清理，参见 [ADR 0009](adr/0009-mcp-client-integration.md)。这是推荐的验证路线，尚未选定或实施；不应在验证上游方案前自行开发 tab 所有权管理。

仍需验证实际安装的扩展与固定 MCP／CLI 版本组合、两个并发 Agent 的页面可见性和关闭行为、popup 归属、人工登录／连接授权、Agent 结束与新任务接入后的登录复用。tab 隔离不会隔离共享 Cookie 或网站服务端账号修改。

另一个备选是 [agent-browser CDP tab pinning](https://agent-browser.dev/cdp-mode#tab-pinning)：命名 session 加 `--pin-tab` 提供新 tab 绑定、页面消失报错和其他活跃 session 的占用冲突检查。当前仅查阅官方文档，未安装或验证；既有 Playwright 扩展若能满足，应优先复用当前工具体系。

浏览器／profile 选择与扩展的 tab 选择是不同交互。现有固定版本 CLI 的 `attach --extension=chrome`／`attach --extension=msedge` 会选择浏览器 channel，扩展再提供页面选择与连接授权；上游扩展的页面选择 UI 不等于 Weft 的浏览器偏好 UI。浏览器来源可由配置、用户 prompt 或通用用户提问能力确定，具体规则尚未决定。

## 2026-10-26：Convention over configuration 访谈

用户提出的候选规则：优先已打开的浏览器，多个时 Chrome 优先于 Edge；没有打开时自行启动，默认复用用户 profile。该提案尚待确认边界，不是已接受规格。

固定 v1.63.0 的事实：
- [cdpRelay.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/cdpRelay.ts#L136) 会调用浏览器可执行文件，传入扩展连接页及 profile 选择；浏览器决定复用已有进程还是新启动。因此可以沿用上游启动用户原有 profile，不是用 Playwright 直接启动另一个进程抢占同一个用户资料目录。
- [extension.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/utils/extension.ts#L22) 优先选择最近使用且装有扩展的 profile，其次选择其他装有扩展的 profile。该规则不等同于选择当前前台窗口或已登录目标账号。
- [channelSessions.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/cli-client/channelSessions.ts#L32) 的 channel 列表检查资料目录、扩展安装记录和可用 CDP endpoint；不能据此准确判断浏览器是否正在运行。“已打开优先”若保留，需要另行可靠检测，不能将目录存在当成运行状态。
- 普通扩展连接会检查安装情况并等待连接授权；不能将已安装浏览器、已打开窗口或存在扩展安装记录当成已成功连接。用户拒绝授权不能被当作一般失败后继续换浏览器尝试。
- Weft 现有 CLI wrapper 将 HOME 设为 Agent scratch，而上游个人资料发现使用 `os.homedir()`。接入个人浏览器时必须解决这项兼容问题；目前不能承诺命令直接可用。

待决策树：先确定默认浏览器选择顺序、profile 自动选择范围与无法连接时的降级边界；再确定 Chat／Agent 树的选择稳定性、页面归属和生命周期。候选方案应优先复用上游扩展及普通聊天澄清，不预设增加浏览器 Settings 或通用提问工具。

## 已明确的需求与接入边界

用户明确要求优先复用现成实现，但必须满足已有登录可复用、未登录时也能通过必要的人工步骤继续任务。Chrome 与 Edge 都在支持范围；不同 Agent 使用独立页面归属。没有专用提问工具不等于无法向用户澄清，普通聊天优先。

Weft 控制工具接线与返回内容，应让模型得到可操作的信息；这不要求重写上游错误。v1.63.0 的缺扩展错误已包含资料位置、安装提示和官方商店链接。最小补充是浏览器工作指令／参考资料中的 Chrome／Edge 安装步骤，并保留原始诊断。后续实测若证明提示不可用，再做局部补充，不在通用 exec_command 内解析任意命令来猜浏览器错误。

安装指引应明确：在准备使用的 Chrome／Edge profile 中打开[官方商店页](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，添加扩展并保持启用；Edge 如提示需先允许来自其他商店的扩展，再确认添加。安装完成后重新尝试连接。步骤依据 [Microsoft Edge 官方说明](https://support.microsoft.com/en-us/edge/add-turn-off-or-remove-extensions-in-microsoft-edge) 和[上游扩展说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md#installation-steps)，不自建扩展安装器。

必须区分三个事实：扩展安装记录存在、浏览器连接已授权、目标网站已登录。上游安装检查不保证扩展已启用；无 token 时连接可能一直等待授权，而不是立即返回拒绝错误；网站登录由 Agent 观察目标页面，不能由扩展检查结果推断。来源：[安装检查](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/utils/extension.ts#L61)、[授权等待](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/cdpRelay.ts#L120)。

尚需验证人工交接：普通聊天回答会结束当前 Agent 并清理连接，后续 Root 必须重新连接正确浏览器／profile，必要时重新取得原页面访问。不能只验证 Cookie 还在，就宣称人工登录途中或未提交页面也可恢复。无需预设增加提问工具，但必须以真实交接场景证明流程跑通。

## 已确认的选择规则

用户确认：
1. 浏览器与 profile 的选择优先直接沿用上游规则，不添加无必要的例外或固定本地业务策略。
2. 一旦选定浏览器和 profile，就保持这个目标，除非用户显式要求更换；网站未登录、连接失败或登录过期都不构成自动换账号环境的理由。不自动遍历其他 profile 寻找账号。
3. 用户已同意保持范围以 Chat 为界，Sub-agent 继承同一目标，但各 Agent 拥有独立连接与页面归属。
4. 后续澄清：任务需要认证且所选环境未满足认证时，才提示用户登录；不因某网站未登录而无条件要求认证。
5. 后续澄清：扩展不是所有浏览器任务的前提，临时启动浏览器也是上游原有能力，不应把它排除为特殊例外。此前“公开网页一律不得临时浏览”和“所有任务统一走个人 profile”的解释撤回。

固定安装的官方 skill 明确提供两类原有操作：`open` 默认内存 profile，可直接创建独立浏览器；`attach --extension=<channel>` 通过扩展复用个人浏览器。另有 `--persistent`、`--profile` 及 CDP 连接。来源：[v1.63.0 官方 skill](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/skills/playwright-cli/SKILL.md)。上游提供不同操作及各自默认值，并不自动理解任务、替模型决定何时需要登录。应遵循 ADR 0005：模型按任务选择公开工具，Weft 接线、校验、取消并记录，不增加“公开网站名单”或认证需求分类器。

用户已确认：Chat 保持规则约束已选择的个人浏览器／profile，同时允许 Agent 按任务使用上游临时浏览器。例如先用临时浏览器阅读公开网页，用户随后要求处理邮箱时，可以连接个人环境；首次临时 profile 不成为 Chat 永久账号目标。个人目标一旦选定，在用户显式更换前，后续 Root 与 Sub-agent 复用该目标，仍各自拥有独立连接与页面归属。

保存已选目标的方法、服务重启与人工登录中页面续接需要后续验证。需要复用个人目标时，不能每次重新执行上游最近使用规则而悄然换账号；错误只应陈述所选环境实际状态，不代表已检查用户的全部浏览器账号。
