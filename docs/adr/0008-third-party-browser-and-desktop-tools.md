# 第一版通过 Playwright 接入浏览器能力

浏览器和桌面操作优先通过成熟工具公开的 CLI、SDK 或 MCP 接入，沿用其会话、profile、连接和关闭行为；先选型并验证兼容性，再处理具体接入问题，避免先设计独立的浏览器或桌面控制层。Weft 负责让工具可调用、接入全局安全审核及保存实际 Tool Result，保留自己的 Agent 和模型通信路径。

第一版选择 [Playwright CLI 与官方 skill](https://github.com/microsoft/playwright-cli)，通过现有命令工具使用其浏览器操作、页面快照、console、网络请求及响应详情、截图和 trace。工具从 Weft 自身安装位置提供，不依赖目标仓库安装 Playwright；会话与 profile 沿用上游方案，调整由实际兼容性问题驱动。

原生桌面操作延期，第一版不接入 Cua Driver 或另一套浏览器操作后端。Cua 已有浏览器操作能力，但公开工具列表未提供专门的 console 和网络请求／响应诊断接口；先用单一工具覆盖当前开发网站诊断需求，避免重叠接入或自行实现采集层。

第一版图片输入包含用户在 prompt 中上传或粘贴图片，以及模型按需读取本地图片（含浏览器截图）。两个入口共用图片输入能力；用户图片属于用户消息，工具读图通过 [OpenRouter 多模态工具结果](https://openrouter.ai/docs/api_reference/responses/tool-calling#multimodal-tool-outputs) 返回。模型决定何时截图和查看，本地执行读取、参数校验和实际内容传输，不自动附送全部截图；界面沿用常见附件预览与移除交互。

依据 OpenRouter 的 `architecture.input_modalities` 校验图片输入能力。已知所选模型不支持图片时，用户附图在提交前提示选择支持的模型，并保留输入和附件；工具读图返回明确错误，由模型决定替代方式或请用户处理。不自动切换模型或重试付费调用；能力未知不冒充已支持，服务方实际拒绝仍如实记录。

图片沿用 [ADR 0001](0001-agent-and-call-ownership.md) 的历史规则。用户图片是问题的一部分，保存提交时的内容；后续根任务载入该条成功、失败或取消任务的历史问题时一并原生带入，并继续按当前模型能力校验。工具读取的图片属于同一 Agent 的工具上下文，后续根任务不自动携带，需要时重新读取。记录查看展示当时实际发送的图片，不随原文件修改或删除而变化；携图历史会增加请求体积和模型输入成本。

图片上传／粘贴、本地 `read_image`、原生多模态工具结果和记录／历史已实现，并通过受控模型协议、原生文件读取与附件界面测试验证；尚未经授权进行付费模型视觉理解验证。浏览器复用固定 Playwright 1.63.0 已有官方 CLI 和 skill，不安装另一版 CLI／后端。命令环境的 `playwright-cli` 仅将完整参数交给该安装的 `playwright cli`；命令继承正常用户 HOME、PATH 和开发环境，前接随附 wrapper／Node／ripgrep 并移除 Weft 管理凭据；已安装浏览器通过 `PLAYWRIGHT_BROWSERS_PATH` 接线。scratch 保留临时目录及 `XDG_CACHE_HOME`；`playwright-cli` wrapper 保留宿主 HOME 以供上游发现个人 profile，仅将固定版已有的 `PWTEST_DAEMON_SESSION_DIR` 设为 scratch 下的 `playwright-daemon`，保持各 Agent 的 registry、daemon 会话与 socket 独立；macOS registry 不使用 `XDG_CACHE_HOME`。这是固定 1.63.0 唯一的 registry 目录覆盖入口，升级时须重新验证。exec-server 自己的最小环境和独立 HOME 不与命令环境混用。Full Access 命令可读取同账号可读配置及凭据，不承诺隔离。模型按需提前关闭自己创建的临时浏览器；Agent 清理停止其所属 CLI 会话，个人浏览器连接沿上游 detach 保留页面及资料，不关闭用户浏览器或无关页面；不增加 Chat 保活或另一套会话框架。

普通命令统一使用 [ADR 0004](0004-command-tool-isolation-boundary.md) 的 Full Access 无沙箱路径，浏览器无需额外模式或授权。保留受控本机网站经 HTTP → 模型 fixture → 原生命令／官方 CLI 的诊断、截图、trace 与关闭回归；不再运行会制造 Chrome abort 的受限模式启动。具体版本、前提及验证边界见[浏览器工具](../browser-tools.md)。

个人浏览器接入规格见 [#186](https://github.com/tylerlong/weft/issues/186)。首个子票 #187 接通单 Agent 的 Chrome／Edge 官方扩展路径，沿用上游初次 browser／profile 选择；不要求临时浏览安装扩展或登录。真实连接及受控站点登录复用证据见[浏览器工具](../browser-tools.md)。#188 增加连接专用 `browser_connect` 工具：复用固定上游 profile 发现，以结构化 channel／profile／user-data root 参数建立独立 CLI 扩展连接，成功后在 Chat 保存最小目标身份；不解析普通 shell 文本，不复制页面动作接口，原始 CLI 全部能力仍可使用。后续 Root／Sub-agent 与重启后重连使用保存的同一目标；临时浏览不读写个人目标。只有用户明确要求才设置 `change_target`，已有连接继续记录原来的实际目标；比较连接开始时的每 Chat 选择修订号再保存，迟到连接不能因目标 X→Y→X 恢复同值而覆盖最新选择；成功变更与显式重选同一目标推进修订号，普通同目标重连不推进，各 Chat 独立。修订号只属于服务寿命，因为待完成连接不跨服务重启保留。选择目标、是否需要用户介入及下一步仍由模型按任务和实际页面判断，保存身份不表示连接保活或登录有效。新增 Chat 字段沿用 ADR 0001 的单一 schema／保留不兼容数据库规则，不自动迁移或重建。人工交接不限于网站登录；网站认证由用户与网站完成，Weft 不实现或验收密码、短信、指纹或 passkey 等认证机制，也不维护网站登录／过期状态。交接沿用普通聊天：保留所需页面，当前 Root 结束后由用户回复创建新 Root，再按同目标连接、明确选择所需页面并观察当前任务状态；用户回复或保存的浏览器目标本身不代表操作完成，未完成或失败不自动更换浏览器目标。#189 已通过 Chrome 真实扩展和受控站点验证该链路及未提交表单保持，Stop／Steer／服务关闭后的迟到授权不会恢复旧任务。#191 补齐真实 Edge 的相同交接／取消和三客户端页面归属验收，并在用户授权创建、安装扩展及删除的独立临时 Chrome profile 中验证登录／过期与窗口关闭后同目标重开。该次 #191 重开证据没有关闭整个个人 Chrome 进程，不声称冷进程重启通过。当前 Edge 也实际只读确认指定私有仓库；失败与未测范围见浏览器工具记录。该证据不代表所有网站或系统验证均受支持，不从 Cookie 存在推断页面或任务已恢复。

#188 的配置兼容性修正复用固定 CLI 的原生合并规则解析初次 user-data root，并将相对路径在 Agent scratch 范围绝对化后保持；当前目标和显式参数优先。跟踪连接拒绝继承的 CDP／remote／isolated／自定义 executable 配置，诊断不打印 endpoint 或凭据；执行时固定 root／profile 和扩展传输，配置在解析后变动也不能改连其他目标。原始 CLI 的全部参数、环境和配置语义保持不变。

人工交接测试按 Weft 的状态、归属与生命周期边界选择：保留一次受控交接、未提交页面保持及用户尚未完成操作就要求继续的检查；不将网站登录过期后的再次登录另列为必须重复的认证验收。浏览器连接授权的 Stop／Steer／关闭服务及迟到授权属于独立连接生命周期边界，继续保留。该测试范围决定不改变上文已有验收的历史事实。 [#194](https://github.com/tylerlong/weft/issues/194) 已将当前交接测试缩短为三个 Root、一次受控人工操作，并在真实 Chrome 验证；上文五 Root／过期重登等结果继续作为历史验收记录。
