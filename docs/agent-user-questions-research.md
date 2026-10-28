# Agent 向用户提问与浏览器交接调查

调查日期：2026-10-26。本文记录公开约定与候选设计，不代表方案已选定或已实现。未安装外部 SDK、扩展或验证真实登录。

结论：专用提问工具不是澄清问题或人工登录交接的必要前提。普通对话可以先输出问题，用户下一条消息回答，再由后续模型调用继续工作。是否保留同一个 Agent、工具连接和浏览器页面，是另外的执行与资源生命周期选择。不能仅凭“当前没有提问工具”推断产品无法继续任务。

浏览器工作流的实施规格见 [#186](https://github.com/tylerlong/weft/issues/186)，不预设新增提问工具或 MCP Elicitation；本调查中的专用机制仅供有实际需求时参考。

## 当前 Weft

模型工具清单见 `src/openrouter.ts`，目前没有专门向用户提问并等待回答的工具；普通最终回答结束当前 Agent，用户再次提交会创建新的 Root Agent，见 `src/server.ts`。这描述执行身份变化，不表示 Chat 失去上下文或无法承接回答。`src/mcp-client.ts` 建立 MCP Client 时未配置 elicitation 能力或处理逻辑，因此引入一个使用该协议提问的 MCP 服务，并不会自动获得 elicitation 界面。

`src/server.ts` 的 `chatHistory` 已将成功 Root 的用户问题与 assistant `answerText` 交给后续 Root，因而“先问一句，用户再回答”已有文本续接。当前 MCP 连接与命令在 Agent 结束后清理；完整运行时资源及所有工具上下文不等于这些历史消息。已通过现有 `chat histories are isolated` 用例，证明成功回答可进入下一次提交的上下文；这不证明真实模型会在所有缺信息场景主动澄清，也不证明浏览器页面可续接。

[ADR 0001](adr/0001-agent-and-call-ownership.md) 已确定 Agent、Model Call、Tool Call 及记录归属；[ADR 0004](adr/0004-command-tool-isolation-boundary.md) 的 Jev 审核与用户提供信息是不同目的。设计通用提问时，应保留这些区分，避免把登录协助或偏好选择变成另一套工具审批。

## 官方方案

### 普通多轮对话：问题与答案作为消息续接

OpenAI 官方文档明确支持把前面的 assistant 输出与下一条 user 消息一起交给后续请求，也可通过 `previous_response_id` 或 Conversations 管理上下文。新请求可以延续对话，不需要先调用提问工具。[OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

Anthropic Messages API 同样支持由调用方传入完整消息历史来建立多轮对话。宿主维护历史，模型生成下一条消息；assistant 先问一个问题、user 下条回答属于这一模式的直接应用。官方 SDK 用户输入文档也明确把“执行中等待回调”与“普通回合结束后等待下一条用户消息”区分，未将后者描述为不可用。[Anthropic 多轮对话](https://platform.claude.com/docs/en/build-with-claude/working-with-messages#multiple-conversational-turns)、[SDK 用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)

| 连续性                | 要保留的内容                                   | 是否要求专用提问工具                             |
| --------------------- | ---------------------------------------------- | ------------------------------------------------ |
| 对话继续              | 上一条问题、用户答案及任务背景                 | 不要求；历史消息即可承接                         |
| 同一次 Agent 执行继续 | 当前执行身份、工具调用与必要的运行状态         | 工具等待是一种方案，是否需要此语义由产品决定     |
| 同一个浏览器页面继续  | 登录状态、页面、页面内未提交数据及重新连接方式 | 不由提问工具自动保证；取决于浏览器和连接生命周期 |

例如“请在 Edge 登录，完成后回复继续”，可以用普通聊天完成交接；后续 Agent 仍须能连接正确 profile／页面并确认状态。反过来，即使增加提问工具，若浏览器被关闭、profile 不复用或 tab 归属错误，登录和页面上下文仍会丢失。这是两类独立问题。

### Claude Agent SDK：模型提问，宿主呈现并等待

官方 `AskUserQuestion` 将模型生成的问题交给宿主 `canUseTool` 回调；回调未返回时当前执行等待，区别于普通回答结束后开始下一轮对话。问题可带单选／多选、选项描述，也可由宿主提供自由文本；宿主负责 UI 并将答案交回。SDK 提供执行机制，未提供可以直接放入 Weft 的通用网页提问组件。为了使用一个提问交互而替换 Weft 自有模型循环，并非该文档要求。[官方用户输入文档](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions)

### MCP elicitation：服务提问，客户端承载

MCP 区分 form 与 URL 两种 elicitation：form 收集结构化回答，URL 将敏感操作交给外部页面；客户端负责 UI，协议不指定界面形态。form 不用于密码、token 等凭据；回答区分 accept、decline、cancel。这个协议适合对接 MCP 服务主动提出的问题，不会自动成为 Weft 主模型可调用的内置提问工具。[2026-07-28 规范](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)

必须按实际协商版本接线：2026-07-28 通过每次请求的 `_meta.io.modelcontextprotocol/clientCapabilities` 声明能力，并以 `InputRequiredResult` 返回嵌套请求；旧版 2025-11-25 使用初始化能力声明与服务端请求。旧版 URL 接受表示同意交互，并不表示交互完成，完成通知也是可选机制。不能混用两版示例，也不能把“打开页面”视为“登录成功”。[旧版规范](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-mode-elicitation-requests)

## 浏览器选择、标签页授权与登录是三件事

| 交互                   | 上游现有机制                                                                             | Weft 仍需决定的行为                                       |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 选择 Chrome／Edge      | Playwright CLI 的 `attach --extension=chrome`／`--extension=msedge` 在连接前选定 channel | 用户是否在 Settings 配置默认值，或由 Agent 缺少信息时提问 |
| 选择该浏览器的 profile | 扩展默认寻找最近使用且装有扩展的 profile，可配置 `--profile-dir-name`                    | 是否需要显式选择工作／个人账号环境                        |
| 选择允许连接的 tab     | 扩展连接页让用户选 tab；多个客户端各自 tab group                                         | 用上游界面即可，不应将它描述为“选择浏览器”                |
| 短信／指纹登录         | 用户在目标网站和系统验证界面完成                                                         | Agent 如何等待用户完成，以及如何重新确认登录状态          |

浏览器 channel 参数的解析见固定版本 [CLI program.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/cli-client/program.ts#L154)；profile 配置与实际浏览器参数见 [config.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/config.ts#L195)。扩展 tab 选择与每客户端 tab group 的公开约定见 [v1.63.0 扩展说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md#usage)。上述选择界面解决连接授权，不承担 Weft 通用问题的收集。

## 候选设计与待决定项

以下是本调查的建议，而非外部产品保证或已接受设计：
1. 首先用普通聊天承接澄清与“人工操作完成”的回答，确认真正不足的是信息缺失、历史续接，还是浏览器资源被清理。若已有机制满足需求，不新增提问工具或替换 Agent SDK。
2. 登录凭据留在网站／系统验证界面。收到用户的完成确认后，Agent 再观察目标页面，不能将确认本身当成登录成功证据。
3. 只有明确需要结构化选项／批量问题、答案精确归属并发 Sub-agent，或保留同一次执行时，再评估通用“请求用户输入”工具。这些是额外交互与执行语义的收益，不能当成普通对话无法完成澄清的证据。
4. MCP elicitation 仅在实际服务需要时另行支持，保留请求来源、协议结果与版本差异。它可共用未来的展示机制，但不是浏览器人工登录的通用前提。
5. 若决定保留运行中的等待，再确定暂停范围、并发问题、Stop／Steer／重启与迟到回答；若选择普通多轮对话，则重点验证浏览器连接和页面能否在 Agent 更替后正确恢复。两条路径都需要验证用户说“继续”时承接的是哪项工作。
6. 普通提问、浏览器连接授权、人工完成操作与 Jev 安全审核分别表达。用户未回答、关闭界面、拒绝操作及 Agent 取消不能以默认选项或超时当成用户同意。

调查未检查 Codex 桌面内部实现，也未证明任何网站的登录或多 Agent 并发兼容性；以上方案仍需设计访谈及最小集成验证。
