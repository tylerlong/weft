# MCP 独立真实模型验收（#217）

此验收是单独、明确调用的付费动作，不属于默认单元测试、普通测试命令或 CI。它使用当前 Settings 中的默认 OpenRouter 模型、路由偏好、Jev 开关和已启用 Jira Docker 服务；有普通管理 URL 时，源服务器只收到管理 API 的 GET；桌面会话没有导出入口时，也可由用户正常 Settings 界面复制现有值到权限受限的临时输入。两种方式都不修改用户 Settings、Chat、运行数据库或基础设施。

## 明确调用

先打开已有 Weft 会话并使用该会话的管理凭据；任务模型不得读取运行数据库或进程内存，也不要向模型导出整个 Settings。管理凭据只能留在本机，不提交到仓库、不贴到 issue 或聊天。设置本机现有服务器 origin，使用不回显的 shell 输入令牌：

```sh
export WEFT_ACCEPT_SOURCE=http://127.0.0.1:3000
read -rs 'WEFT_ACCEPT_TOKEN?Existing Weft management token: '
export WEFT_ACCEPT_TOKEN
WEFT_ACCEPT_PAID=1 node scripts/accept-mcp-recovery.ts
unset WEFT_ACCEPT_TOKEN
```

上例 `read` 为 zsh 语法；服务器使用随机端口时替换 origin。存在多个启用的 Jira Docker 服务时，通过 `WEFT_ACCEPT_SERVICE_ID` 选择稳定服务身份。凭据输入与服务配置仍由用户在 Settings 管理，验收脚本不会替代这一界面。

桌面会话没有普通管理 URL 时，支持 `WEFT_ACCEPT_INPUT=/absolute/private/input.json` 替代源 URL／管理令牌。输入只用于本次隔离验收，必须由当前用户拥有、权限不向组／其他用户开放（例如 `chmod 600`），内容为从正常 Settings 复制的现有 `modelId`、`apiKey`、`providerRouting`、`safetyReview` 与单个 `service`（沿用服务的 `name`、`enabled`、`config`、`env`；仅隔离副本可使用自己的稳定 `id`）。任务 Agent 不得直接读取运行数据库或进程内存来填充它；受保护 key 字段不能正常复制时，由用户从自己的凭据来源复制到本机，不贴到聊天。模型采用源默认模型和 model-default effort，隔离服务器通过普通模型目录 API 发现真实模型 metadata，不虚构其能力。此输入不是新的生产配置来源，运行结束后删除临时输入和中间副本。用户也可单独明确授权开发者设置步骤使用原生 SQLite backup API：只读打开真实源库，创建一致且 owner-only 的临时快照，在模型工作目录外仅提取配置填入此输入，随即删除含历史的快照；实际 Agent 仍使用另一空白隔离库，不执行复制的 Chat，也不获得数据库访问工具。此开发者授权不改变任务模型／Jev 的运行数据库策略。

```sh
WEFT_ACCEPT_INPUT=/absolute/private/input.json WEFT_ACCEPT_PAID=1 node scripts/accept-mcp-recovery.ts
```

不付费的脚本自检可以单独运行：

```sh
node scripts/accept-mcp-recovery.ts --check
```

自检使用本地受控进程和 loopback 临时服务器，验证首次启动失败／再次启动透传、非允许工具门控及真实管理 API 的 Origin／认证／模型目录／Project／Chat 设置路径；目录响应受控且断言零 Model Call，不访问外部网络、Docker 或付费模型。脚本不在普通命令／CI 中注册；需要检查脚本本身的类型时使用：

```sh
pnpm exec tsc --ignoreConfig --noEmit --target es2022 --module nodenext --allowImportingTsExtensions --strict --skipLibCheck --types node --lib es2022,dom scripts/accept-mcp-recovery.ts
```

## 实际步骤与范围

1. 通过已认证的 GET，或正常 UI 复制的私有临时输入，读取模型／key、MCP 配置与 Jev 开关。要求所选 Docker endpoint 的 `docker info` 已成功；不可达时停止，不启动／重启用户运行时。
2. 在权限受限的临时目录创建独立数据库及本地服务配置，按源默认模型执行，单次验收上限 16 个 Model Call（包含 Jev）、4 分钟。隔离验收设置此较小预算，不修改用户的默认 128 或已保存显式上限。
3. 仅在隔离服务的首次启动中注入明确的受控错误。再次启动透明运行原 Jira MCP 命令，原凭据只沿本地配置／环境传给该程序；wrapper 不是受支持 Docker 启动形状，不触发真实 Colima 前置恢复。
4. 真实模型被明确要求依次使用 `mcp_diagnostics`、`mcp_startup`、实际发现的 `jira_search`，只读查询 `assignee = currentUser() AND updated >= -24h`，最多五项。这个 prompt 验证指定序列的可用性，不证明模型在无提示时能自主诊断。
5. 模型仍收到完整真实工具目录。仅验收 fetch seam 在交还真实响应前检查函数请求，任何非诊断／启动／实际 `jira_search` 请求均中止整个响应，不执行其操作；不会重写响应、伪造 Tool Call／Tool Result、代模型选调用或模拟成功。此保护与流缓冲仅用于防止验收写入，不是生产工具过滤或 Jev 分类规则。
6. 输出仅含模型、Jev 开关、实际 Tool Call 名称／状态、Model Call 次数及服务方返回的 usage／cost（若有）。不打印 token、配置原文、Jira 票据内容或模型通信正文。成功、失败、超时以及正常 SIGINT／SIGTERM 均输出脱敏结果摘要；中断时的工具状态是清理前快照，不冒充终态。随后清理隔离服务器、所属 MCP 进程和临时数据库／配置；不停止共享 Docker／Colima。无法捕获的 SIGKILL／进程崩溃仍可能留下权限受限临时文件，不保证这类强制终止后的自动清理。

成功必须观察到同一 Agent 的诊断包含受控首次错误、显式启动成功、随后真实 Jira search Tool Call 成功。Agent 文本自称完成不够，初始正常启动也不算故障恢复。真实 Jira 身份验证／搜索与受控首次故障须分开报告，不能声称验证了真实 Colima 停机恢复、外部 HTTP 服务或 Jev 的一般分类质量。

## 当前交付与证据

- #214–#216 的诊断、同一 Agent 生命周期与确定性前置处理已实现，并通过受控 stdio／HTTP／进程回归及 Linux／macOS CI。
- `test/mcp.test.ts` 覆盖禁用／失败、凭据省略、Settings 采用／显式替换、Root／Sub-agent 隔离、完整发现／失败不发布部分目录、旧处理器失效、无回退／重放、时限／取消、Docker／Colima 已覆盖状态及并发准备。`test/tool-review.test.ts` 与 `test/safety-review.test.ts` 覆盖逐 Tool Call Jev 开关、一次复合操作审核、阻止／故障不执行、预算及可信运行数据库策略。mock 决策不证明真实风险分类。
- 原始 Docker 不可达事件只证明启动失败，没有证明 Jira 凭据失败或已发现 schema 难懂。凭据保留在本地 MCP 执行路径，记录脱敏不变；没有新增生产出站／模型输出脱敏或文件系统隔离，也不把 ZDR 假设当作已验证保证。
- 运行时前置阻塞曾真实复现：Colima `default` 为 `Running/docker`，guest 强制 `/var/run/docker.sock` 的 Docker info 成功（29.5.2），但匹配配置的宿主 socket `_ping` 连接失败且 `lsof` 无持有进程。高置信度故障边界是宿主到 VM 的 socket 转发，未确定转发进程退出原因；这不是停止 profile，应用没有自动重启它。用户随后单独授权一次 graceful stop（3.8 秒）与保护参数 start（12.3 秒），宿主 Docker 恢复。stop 短暂切到 default context，已恢复原 colima context；最终 profile YAML、Docker config.json、SSH config 的 SHA-256 与原 context／endpoint 均完全一致。此人工授权动作不属于 Weft 自动恢复能力。
- 用户明确授权只读源库的原生一致 backup。仅配置被提取到 owner-only 临时输入；含原 Chat 历史的快照在 Agent 开始前即删除。没有修改源数据库／Settings、导出凭据到模型或执行源 Chat。先前 clipboard 路线的全部私有副本也已删除。

### 2026-10-30 实际模型与 Jira

实际配置模型 `z-ai/glm-5.3-flash`，model-default effort、OpenRouter default 路由；Jev 开启，实际解析为 `typesafe/jev-1.14-20261014`。每次使用独立空白隔离 Weft server／数据库，不打开浏览器或创建可见的用户 Chat。故障来自仅第一次启动失败的受控 wrapper；随后运行真实 Jira Docker MCP。完整真实工具目录和原始允许响应保留。

| 条件                          | 实际 Tool Call 顺序                                                    | 结果                                                                       | Model Call（任务／Jev） | 返回 input／output tokens | 返回 cost（USD） |
| ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------- | ------------------------- | ---------------- |
| 原保存 `TOOLSETS=jira`        | diagnostics → startup → diagnostics → diagnostics                      | 客户端连接成功但零工具，未执行 Jira search                                 | 9（5／4）               | 29,393／3,957             | 0.005423022      |
| 仅隔离副本改为 `TOOLSETS=all` | `mcp_diagnostics` → `mcp_startup` → `mcp_tool_5`（实际 `jira_search`） | 三次 Tool Call 均 succeeded，Agent succeeded；先前受控启动错误已被诊断观察 | 7（4／3）               | 50,426／1,743             | 0.008100780      |

两次真实运行共 16 个 Model Call，返回 cost 合计 **0.013523802 USD**。此前 Docker／Origin 设置阶段失败均在模型请求前，零额外付费 Model Call。实际 Jev 对每个已执行 Tool Call 各审核一次；此次允许结果不证明一般风险分类质量。

请求的业务任务是查询 currentUser() 在过去 24 小时更新的最多五张票；**观察到的证据是实际 `jira_search` 成功，不是精确 JQL／结果数量已验证**。验收只保留安全名称／状态／用量摘要，精确执行参数、票据数量与内容未保留，不能伪造或据此声称过滤语义已核对。

实际 image 为 MCP Atlassian **0.21.1**（revision `4e2b836a89dca2fc374133acca0d793f6b29f50c`）。其[固定版本配置说明](https://github.com/sooperset/mcp-atlassian/blob/4e2b836a89dca2fc374133acca0d793f6b29f50c/.env.example#L148-L158) 明确：未知 toolset 被忽略、全部未知时 fail-closed 零工具；`jira` 不是已知组，`all` 是受支持别名。[固定工具表](https://github.com/sooperset/mcp-atlassian/blob/4e2b836a89dca2fc374133acca0d793f6b29f50c/docs/tools-reference.mdx#L53-L70) 定义 `jira_issues` 等组。仅改隔离副本后，独立真实发现得到 **49 个 Jira 工具、包含 jira_search、无 Confluence／其他工具**。新 Jira 模板已改为 `all` 并有 en／zh 设置回归；已有保存行不被覆盖。**用户原保存服务仍为 `TOOLSETS=jira`，需用户在 Settings 改为 `all` 或受支持组后才具备工具。**

真实 Jira 认证／搜索、真实任务模型和真实 Jev 通信已验证；首次失败及恢复触发为受控服务行为，不证明真实 Colima 停机恢复或模型无提示自主诊断。凭据／临时输入／快照与隔离数据库均已删除，未保留 Jira 输出正文。未进行 Jira 写入、外部 HTTP MCP 验收或一般 Jev 分类实验。
- 已知原生 shell 取消竞态 [#193](https://github.com/tylerlong/weft/issues/193) 不属于此次修复；先前阶段曾复现，后续通过不表示已修复。
