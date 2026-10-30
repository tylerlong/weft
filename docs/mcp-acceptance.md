# MCP 独立真实模型验收（#217）

此验收是单独、明确调用的付费动作，不属于默认单元测试、普通测试命令或 CI。它使用当前 Settings 中的默认 OpenRouter 模型、路由偏好、Jev 开关和已启用 Jira Docker 服务；有普通管理 URL 时，源服务器只收到管理 API 的 GET；桌面会话没有导出入口时，也可由用户正常 Settings 界面复制现有值到权限受限的临时输入。两种方式都不修改用户 Settings、Chat、运行数据库或基础设施。

## 明确调用

先打开已有 Weft 会话并使用该会话的管理凭据；不要读取运行数据库、进程内存或导出整个 Settings。管理凭据只能留在本机，不提交到仓库、不贴到 issue 或聊天。设置本机现有服务器 origin，使用不回显的 shell 输入令牌：

```sh
export WEFT_ACCEPT_SOURCE=http://127.0.0.1:3000
read -rs 'WEFT_ACCEPT_TOKEN?Existing Weft management token: '
export WEFT_ACCEPT_TOKEN
WEFT_ACCEPT_PAID=1 node scripts/accept-mcp-recovery.ts
unset WEFT_ACCEPT_TOKEN
```

上例 `read` 为 zsh 语法；服务器使用随机端口时替换 origin。存在多个启用的 Jira Docker 服务时，通过 `WEFT_ACCEPT_SERVICE_ID` 选择稳定服务身份。凭据输入与服务配置仍由用户在 Settings 管理，验收脚本不会替代这一界面。

桌面会话没有普通管理 URL 时，支持 `WEFT_ACCEPT_INPUT=/absolute/private/input.json` 替代源 URL／管理令牌。输入只用于本次隔离验收，必须由当前用户拥有、权限不向组／其他用户开放（例如 `chmod 600`），内容为从正常 Settings 复制的现有 `modelId`、`apiKey`、`providerRouting`、`safetyReview` 与单个 `service`（沿用服务的 `name`、`enabled`、`config`、`env`；仅隔离副本可使用自己的稳定 `id`）。不要读取运行数据库或进程内存来填充它；受保护 key 字段不能正常复制时，由用户从自己的凭据来源复制到本机，不贴到聊天。模型采用源默认模型和 model-default effort，隔离服务器通过普通模型目录 API 发现真实模型 metadata，不虚构其能力。此输入不是新的生产配置来源，运行结束后删除临时输入和中间副本。

```sh
WEFT_ACCEPT_INPUT=/absolute/private/input.json WEFT_ACCEPT_PAID=1 node scripts/accept-mcp-recovery.ts
```

不付费的脚本自检可以单独运行：

```sh
node scripts/accept-mcp-recovery.ts --check
```

自检只用本地受控进程验证首次启动失败／再次启动透传，以及拒绝非允许工具的执行门控，不访问网络、Docker 或模型。脚本不在普通命令／CI 中注册；需要检查脚本本身的类型时使用：

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
- **真实模型验收尚未执行。** 最初 Mac 锁定，随后解锁并通过正常 Settings 界面取得现有 Jira 配置；受保护 key 字段不能正常复制，用户另行将 key 复制到本机，经明确允许后只转入权限受限临时文件。配置未写回源 Settings。实际验收在付费请求前被 Docker readiness 前置检查阻止：`unix:///Users/tyler.liu/.colima/default/docker.sock` 不可达，而只读 `colima list --json --profile default` 报告 `Running`、`docker`。这是运行中 VM 的异常，不能当作停止 profile 启动或自动重启；未操作基础设施。此次发送的付费 Model Call／Jira Tool Call 都为零，无返回 usage／cost。用户修复实际 daemon 后须重新执行并记录真实模型／Jira证据，不能据脚本自检或 CI 宣称通过。
- 已知原生 shell 取消竞态 [#193](https://github.com/tylerlong/weft/issues/193) 不属于此次修复；先前阶段曾复现，后续通过不表示已修复。
