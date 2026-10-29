---

## status: accepted

# 独立 macOS 桌面应用的交付边界

首版桌面交付目标限定为 macOS Apple Silicon，当前仅供开发者本机使用。开发者从源码通过脚本构建 `.app`，之后打开生成的 Weft 即可进入应用，在配置模型后开始使用，无需先启动服务、手动打开浏览器或另外安装供应用运行的 Node。开发构建仍需源码、Node 和 pnpm；应用运行资源随构建产物交付，而不是让生成的应用依赖源码目录中的启动器。首版不承担 Intel 或其他操作系统的适配。

桌面框架选择 Electron，接受随附 Chromium 和 Node 的应用体积，以优先复用现有 JavaScript 技术栈和统一界面运行环境；Tauri 虽可使用系统 WebView，仍需另行交付 Node 后端并增加 Rust 接线。2026-10-28 的隔离打包探针已验证 Electron 窗口加随附独立 Node 后端可运行现有命令、SQLite 与 Playwright；不假定 Electron 自身的 Node 可直接替代现有 Node 可执行文件。实现须保留包内相对依赖链接，并恢复 GUI 启动时的用户开发 PATH；具体证据与限制见[打包验证记录](../desktop-packaging-check.md)。

关闭窗口保留应用与服务，运行中的 Agent 继续执行；点击 Dock 图标重新打开窗口。Quit／Cmd+Q 在有活动任务或排队输入时先确认，随后停止执行并等待服务与数据库清理；确认中须说明未执行队列会随服务退出丢失，不承诺退出后恢复任务或队列。

桌面应用使用独立的用户应用数据目录，首次启动创建新数据库；现有源码目录的数据库保持原样，首版不接入或导入其历史与设置。本轮计划收窄为本机开发构建，不提供公开下载链接，不接入 GitHub Releases、Developer ID 签名或 Apple 公证；此前讨论的 tag 触发构建与自动发布延期。

自包含只覆盖 Weft 自身运行所需资源；项目所需的 Git、Python、包管理器、Docker 和外部 MCP 服务仍由用户安装与配置。Finder 启动时仍须验证命令可找到这些已有工具，不以打包成功代替开发环境验收。

首版手动替换应用更新，不接入自动更新；应用数据保留在独立目录。继续沿用 ADR 0001 的单一当前数据库结构规则：不兼容时保留数据并报告启动错误，不自动迁移或删除数据库，因此首版不承诺跨 schema 版本的无缝升级。

Git 版本管理保留桌面入口源码、构建配置和脚本，不提交生成的 `.app`、安装／压缩包或随附运行时。本地构建脚本从当前检出的源码生成应用快照，输出到忽略的构建目录；源码变更后由开发者重新构建，不在 Finder 启动时自动编译源码。`pnpm desktop:build` 仅构建，`pnpm desktop:start` 在构建成功后打开应用；不为本轮交付增加自动构建／发布工作流或安装器。

构建前检测目标 Weft 桌面应用是否正在运行；若正在运行，构建命令在修改产物前以非零状态退出，并提示开发者先退出 Weft 再重新构建。运行中的应用与 Agent 保持原样，不由构建脚本关闭。构建后启动脚本沿用同一检查，构建失败时不继续打开应用。

当前实施目标仍为 macOS；未来需要支持 Windows。构建目标和资源选择须能明确表达平台与架构，不将 macOS 产物假称为跨平台支持。Windows 的命令执行、路径、环境和生命周期适配属于后续交付工作，不能只靠给 Electron 工作流增加 Windows 构建项完成。

随应用交付 Playwright 的代码、CLI 与 skill，不额外捆绑自动化浏览器。临时浏览通过现有上游 CLI 使用已安装的 Chrome／Edge，沿用其临时 profile、配置和会话语义，不为桌面交付新增浏览器管理层；缺少可用浏览器时给出可操作的错误，不阻止应用启动或非浏览器任务。Playwright 的 WebKit 不等于系统 Safari，Safari 本身不能满足该前提。个人登录复用继续走现有 browser_connect 与官方扩展授权，不因使用同一浏览器可执行文件而改用个人 profile。

实施规格见 [#198](https://github.com/tylerlong/weft/issues/198)。[#199](https://github.com/tylerlong/weft/issues/199) 已接通本机构建／启动命令、自包含资源、独立持久数据、运行应用拒绝重建、窗口重开及空闲退出清理。[#200](https://github.com/tylerlong/weft/issues/200) 已接通 Finder 的登录 shell PATH 恢复，并通过随包工具、已安装 Chrome／Edge 的临时页面交互、缺少浏览器和后续非浏览器任务验收；[#201](https://github.com/tylerlong/weft/issues/201) 完成活动任务／队列退出确认和完整故障反馈；这些尚未交付的行为不能由本次基础切片的验证推定。实际验证范围见[打包验证记录](../desktop-packaging-check.md)。
