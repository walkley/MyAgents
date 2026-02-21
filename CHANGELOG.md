# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.22] - 2026-02-22

### Added
- **飞书 Bot 多媒体接收**：支持接收图片、文件、音频、视频附件，图片走 SDK Vision，文件保存到工作区
- **MCP 内置服务器 args/env 配置**：内置 MCP 服务器支持自定义启动参数和环境变量
- **download-anything 内置 Skill**：新增文件下载 bundled skill
- **Mermaid 图表预览/代码切换**：Mermaid 代码块新增预览/源码切换按钮和复制按钮
- **YAML Frontmatter 代码高亮**：文件预览中 YAML frontmatter 渲染为语法高亮代码块
- **上传文件功能升级**：Plus 菜单「上传图片」升级为「上传文件」，支持更多文件类型

### Fixed
- **心跳/IM 消息竞态条件**：心跳 runner 未获取 peer_lock 导致与用户消息并发访问 imStreamCallback，造成响应丢失和双重 "(No response)"。现在心跳与用户消息通过 peer_lock 串行化，Bun 侧增加纵深防御
- **Monaco 编辑器 CJK 输入法**：修复中日韩输入法组合输入时的闪烁和异常行为（两轮修复）
- **Mermaid 图表加载卡死**：多图表场景下 Mermaid 渲染卡在 loading 状态
- **模态框拖拽误关闭**：拖拽选中文本到遮罩层时不再误触发关闭
- **Bot 工作区复制校验**：从 bundled mino 复制工作区时增加校验和 fallback
- **飞书向导步骤优化**：「添加应用能力-机器人」提前到 Step 1，减少配置遗漏

### Changed
- **Launcher 工作区选择器**：从输入框上方浮动 pill 移入输入框工具栏内，布局更紧凑
- **README 更新**：同步当前功能列表、支持的供应商和架构说明

---

## [0.1.21] - 2026-02-21

### Added
- **Bot 创建向导新增工作区步骤**：创建 Bot 时可直接配置独立工作区路径
- **飞书 Post 富文本消息支持**：Bot 接收飞书 Post 类型消息（含代码块、加粗、列表等富文本），解析 text/a/at/img/emotion/code_block 元素为纯文本
- **IM Bot /help 命令**：飞书和 Telegram Bot 均支持 `/help` 查看所有可用命令
- **IM Bot /mode 命令**：通过 `/mode plan|auto|full` 切换权限模式（计划/自动/全自主）
- **工作区文件单击预览**：右侧「项目工作区」面板中单击文件直接触发预览（原需双击），Ctrl+单击多选保持不变

### Fixed
- **飞书 Bot 幽灵消息**：dedup 缓存持久化到磁盘（TTL 72h），App 重启后不再重复处理飞书重传的旧事件
- **飞书消息静默丢失**：含代码块/加粗等格式的消息（msg_type: post）不再被忽略
- **IM 来源标签错误**：飞书消息不再显示 "via Telegram 群聊"，改用 SOURCE_LABELS 映射正确显示平台名
- **Provider API Key 验证超时**：使用 project-level settingSources 和 bypassPermissions 避免用户级插件加载阻塞
- **文件预览 FileReader 挂起**：添加 onerror/reject 处理，防止 Blob 损坏时 isPreviewLoading 永久卡死
- **Tab 关闭确认误弹**：持久 Owner 保持 Sidecar 存活时跳过关闭确认
- **Telegram 向导输入顺序**：修正向导步骤输入框顺序，跳过按钮改为返回按钮
- **绑定消息误处理**：已绑定用户的 BIND 消息静默忽略，避免重复处理

### Performance
- **前端流式消息隔离**：Playwright tool.result 从前端剥离，流式消息状态独立管理，减少不必要的重渲染

### Changed
- **飞书代码块输出样式**：AI 回复中的代码块使用 `─── ✦ ───` 分隔线 + 斜体缩进，内联代码映射为加粗+斜体
- **IM Bot 热更新**：权限模式、MCP 服务器、Provider 等配置变更无需重启 Bot
- **Heartbeat 系统提示词**：心跳检查使用独立 system prompt，修复 Bot 停止/重启可靠性

---

## [0.1.20] - 2026-02-19

### Added
- **飞书 Bot 平台支持**：新增飞书适配器（WebSocket 长连接 + protobuf），与 Telegram 共享多 Bot 架构、Session 路由、消息缓冲
- **IM Bot 交互式权限审批**：非 fullAgency 模式下，工具权限请求通过飞书交互卡片 / Telegram Inline Keyboard 展示，用户点击按钮或回复文本完成审批
- **ZenMux 预设供应商**：新增 ZenMux 云服务商聚合平台，支持 9 个预设模型（zenmux/auto、Gemini 3.1 Pro、Claude Sonnet/Opus 4.6 等）

### Fixed
- **飞书 WebSocket 事件重放**：新增数据帧 ACK 机制，dedup 缓存 TTL 从 30 分钟延长至 24 小时，防止断连重连后消息重复处理
- **IM Bot 停止按钮状态回弹**：`toggleBot` 写盘后未调用 `refreshConfig()` 同步 React 状态，导致轮询 fallback 到过期的 `cfg.enabled`
- **工具输入截断 UTF-8 panic**：权限审批卡片中 `tool_input[..200]` 字节截断改为 `char_indices().nth(200)` 字符安全截断

---

## [0.1.19] - 2026-02-18

### Added
- **IM 多 Bot 架构**：支持创建和管理多个 Telegram Bot 实例，独立配置工作区、权限、AI 供应商和 MCP 工具
- **IM Bot AI 配置**：每个 Bot 独立设置 Provider/Model/MCP 服务，支持 Telegram `/model` 和 `/provider` 命令切换
- **Telegram 多媒体消息支持**：支持图片（SDK Vision）、语音、音频、视频、文档（保存到工作区）、贴纸、位置、相册（500ms 缓冲合并）
- **IM Bot 自动启动**：应用启动时自动恢复上次运行中的 Bot

### Fixed
- **Telegram 代理支持**：文件下载复用代理配置的 HTTP 客户端
- **IM Bot 启停按钮状态回弹**：轮询跳过正在操作的 Bot，避免覆盖乐观更新；toggleBot 使用 ref 读取最新状态消除闭包陈旧
- **TodoWriteTool 白屏崩溃**：流式 JSON 解析中间态 `todos` 可能为对象而非数组，改用 `Array.isArray()` 守卫
- **IM 私聊 emoji 移除**：去掉 Telegram 私聊消息的手机 emoji，群聊保留群组图标
- **IM Bot 列表页 UI 闪烁**：消除空状态闪烁和按钮颜色闪烁
- **多媒体安全加固**：文件名路径穿越防护（sanitize_filename）、下载大小限制（20MB）、图片编码限制（10MB）、异步文件 I/O

### Changed
- **IM 会话列表标签化**：用平台标签替代 emoji 标识 IM 来源
- **SDK 升级**：claude-agent-sdk 升级至 0.2.45
- **模型更新**：新增 Sonnet 4.6，移除 Opus 4.5

---

## [0.1.18] - 2026-02-17

### Added
- **用户消息气泡 Hover 菜单**：鼠标悬停显示操作菜单（复制、时间回溯），Tooltip 提示
- **时间回溯功能**：回溯对话到指定用户消息之前的状态，回退文件修改，被回溯的消息文本恢复到输入框
- **Launcher 工作区设置双向同步**：工作区卡片设置面板变更实时同步到已打开的 Tab

### Performance
- **持久 Session 架构**：SDK subprocess 全程存活，消除每轮对话的 spawn → init → MCP 连接 → 历史重放开销
  - 事件驱动 Promise 门控替代 100ms 轮询，消息交付零延迟
  - 对话延迟不再随历史消息增长线性退化
  - 净减少约 106 行代码（删除 `executeRewind` 等死代码）

### Fixed
- **permissionMode 映射错误**：「自主行动」（auto）和「规划模式」（plan）权限模式实际使用了 `default`，现已正确映射到 SDK 的 `acceptEdits` 和 `plan`
- **订阅供应商误显可用**：未验证订阅的供应商不再显示为可用，发送按钮和 Enter 键增加供应商可用性守卫
- **持久 Session 启动超时死锁**：startup timeout 改用统一中止 `abortPersistentSession()`，解除 generator Promise 门控阻塞
- **Rewind SDK 历史未截断**：`resumeSessionAt` 在 pre-warm 中正确传递，确保 SDK 历史与前端同步截断
- **Rewind 后 AI 重复已回答内容**：assistant `sdkUuid` 改存最后一条消息（text）而非第一条（thinking），确保 `resumeSessionAt` 保留完整回复
- **超时链路对齐**：Cron 执行超时 11min → 60min，智谱 AI 超时 50min → 10min，Permission 等待 5min → 10min
- **用户消息气泡宽度**：最大宽度改为容器 2/3，文字先横向扩展再换行

---

## [0.1.17] - 2026-02-16

### Added
- **工作区记住模型和权限模式**：每个工作区独立保存最近使用的 model 和 permissionMode，切换时自动恢复

### Performance
- **Tab 切换性能深度优化**：隔离 isActive 到独立 TabActiveContext，content-visibility 延迟渲染，组件 memo + ref 稳定化，消除切换时全量重渲染

### Fixed
- **启动页图片粘贴报错** + Tab 栏单击不选中
- **首次启动卡死**：projects.json 损坏恢复 + 日志重复修复
- **Windows 更新重启 bun 进程未清理**：kill_process 改用 taskkill /T /F 杀进程树，新增 shutdown_for_update 阻塞等待所有进程退出，Settings 页更新按钮同步修复
- **JSON 持久化加固**：所有 JSON 配置文件统一使用原子写入（.tmp → .bak → rename），三级恢复链（.json → .bak → .tmp）+ 结构校验，防止进程崩溃导致数据丢失

---

## [0.1.16] - 2026-02-14

### Added
- **启动页改版——任务优先模式**：左侧 BrandSection 新增全功能输入框 + 工作区选择器，支持直接发送消息启动工作区
  - 工作区选择器：默认/最近打开分组、向上展开菜单
  - 输入框复用 SimpleChatInput，支持文本、图片、Provider/Model、权限模式、MCP 工具选择
  - 发送设置自动持久化，下次启动恢复上次选择
- **默认工作区 mino**：内置 openmino 预设工作区，首次启动自动复制到用户目录
- **Settings 默认工作区配置**：通用设置新增默认工作区选择，自定义 CustomSelect 替换原生 select
- **Windows setup 补充 mino 克隆**：`setup_windows.ps1` 与 macOS `setup.sh` 对齐

### Changed
- **Launcher 右侧面板精简**：移除快捷功能区块，工作区卡片精简为可点击双列紧凑卡片
  - 移除 Provider 选择器、启动按钮、三点菜单
  - 整卡点击启动，右键上下文菜单移除工作区
  - 工作区列表从单列改为双列 grid 布局
- **视觉统一与细节打磨**
  - Launcher 左右区域背景色统一，分割线改为不到顶的浮动线
  - Settings 侧边栏分割线同步改为浮动线
  - 品牌标题字号调小、字间距加宽，Slogan 更新为中文
  - MCP 工具菜单开关样式对齐设置页（accent 暖色 + 白色滑块）
  - Provider/MCP 静态卡片移除无效 hover 阴影
- **日志面板改版**：过滤器三组重构、新增导出功能、默认隐藏 stream/analytics

### Removed
- 移除 Launcher 死代码：subscriptionStatus 无用 API 调用、onOpenSettings 死 prop、QuickAccess 组件

---

## [0.1.15] - 2026-02-13

### Added
- **文件预览器 Markdown 本地图片加载**：相对路径引用的图片通过 download API 解析显示，支持 `./`、`../` 路径
- **MiniMax 预设新增模型**：M2.5、M2.5-lightning，M2.5 设为默认
- **文件预览器顶部信息优化**：文件大小改 KB/MB 格式、副标题改路径显示、新增「打开所在文件夹」按钮
- **macOS 路径显示缩短**：全局路径展示将 `/Users/<name>/` 替换为 `~/`

### Performance
- 流式渲染性能优化：消除级联重渲染，输入框/侧边栏不再卡顿

### Fixed
- 修复流式回复中段落分裂（防御性合并相邻文本块）
- 修复系统暗色主题导致 UI 颜色异常（强制日间模式）

---

## [0.1.14] - 2026-02-11

### Added
- **后台会话完成**：AI 流式回复中切换对话/关闭标签页不再丢失数据，旧 Sidecar 在后台继续运行直到回复完成
- **手动检查更新**：设置页「关于」区域增加检查更新按钮与下载进度展示
- **MCP 服务器编辑**：自定义 MCP 卡片增加设置按钮，复用添加弹窗编辑配置
- **新增预设供应商**：硅基流动 SiliconFlow（Kimi K2.5、GLM 4.7、DeepSeek V3.2、MiniMax M2.1、Step 3.5 Flash）
- **供应商「去官网」链接**：7 个预设供应商卡片增加官网入口
- **智谱 AI 新增 GLM 5 模型**
- **Settings 双栏布局**：供应商、MCP、技能、Agent 页面统一为双栏卡片网格

### Changed
- Settings 页面样式全面统一（Toggle、Button、Card、Input、Modal 共 24 处对齐）

### Fixed
- 修复首消息 5~13 秒延迟（stale resumeSessionId + 模型未同步导致阻塞）
- 修复编辑供应商保存时 API Key 被清空（React config 状态覆盖磁盘数据）
- 修复定时任务超时导致流式数据丢失（四层防御）
- 修复自定义 MCP 启用检测找不到系统 npx/node（PATH 环境变量未传递）
- 修复 MCP 设置按钮无响应 & 切换 Tab 残留 MCP 面板（Modal 渲染位置错误）
- 修复 Launcher 移除按钮使用未定义 CSS 变量 `--danger`
- 修复 Windows CSP 配置缺失导致 IPC 通信失败

---

## [0.1.13] - 2026-02-10

### Added
- **消息队列**：AI 响应中可追加发送消息，排队消息在当前响应完成后自动执行
  - 排队消息合并为右对齐半透明面板，支持取消和立即发送操作
  - 采用 Optimistic UI 模式，回车即清空输入框
  - 与心跳循环兼容：Cron 消息走正常队列，不中断当前 AI 响应
- **后台任务实时统计**：后台 Agent 运行时显示实时运行时间和工具调用次数
  - 通过轮询 output_file 获取增量数据，3 秒刷新
  - 折叠视图显示"后台"徽标和"(后台)"标签后缀
- **自定义服务商认证方式选择器**：创建/编辑自定义服务商时可选择 AUTH_TOKEN 或 API_KEY
- **工作区文件夹右键刷新**：文件夹右键菜单新增「刷新」按钮，ContextMenu 组件支持分隔线

### Changed
- **停止按钮三态交互**：点击停止按钮立即显示"停止中"视觉反馈（Loader 旋转），后端中断超时从 10s 缩短至 5s

### Fixed
- 修复历史会话切换供应商时 "Session ID already in use" 错误（区分历史/新会话的 resume 策略）
- 修复 Provider 切换时 pre-warm 未完成导致 resume 无效 session ID 的错误
- 修复 Cron single_session 模式下误中断当前 AI 响应
- 修复队列 SSE 事件未注册导致前端排队面板不显示
- 修复心跳循环状态栏背景透明导致内容透出
- 修复排队面板与心跳状态栏层级顺序（心跳始终紧贴输入框）

### Security
- 修复后台任务轮询端点路径穿越漏洞（resolve + homeDir 校验）
- 错误消息 ID 改用 crypto.randomUUID() 避免碰撞
- queue:started 广播携带 attachments，消除前端附件数据源不可靠隐患

---

## [0.1.12] - 2026-02-08

### Added
- **AI 输出路径可交互**：对话中内联代码如果是真实存在的文件/文件夹路径，自动显示虚线下划线，点击或右键弹出快捷菜单（预览、引用、打开所在文件夹）

### Fixed
- **Tab 栏触控板交互优化**：Mac 触控板轻触切换 Tab 不再误触发拖拽
- **Tab 关闭按钮偶尔无响应**：缩小拖拽监听范围至标题区域，扩大关闭按钮热区
- **Monaco Editor 大文件卡死**：延迟挂载编辑器 + 大文件自动降级纯文本模式
- **图片文件右键预览菜单**：右键菜单的「预览」选项现在对图片文件也可用

---

## [0.1.11] - 2026-02-06

### Added
- **Sub-Agent 能力管理**：为 AI 配备多种"专家角色"，模型自主判断何时委派
  - 支持全局 Agent（`~/.myagents/agents/`）和项目 Agent（`.claude/agents/`）双层管理
  - Agent 定义文件与 Claude Code 格式完全兼容（Markdown + YAML Frontmatter）
  - 可配置工具限制、模型选择、权限模式、最大轮次等
  - 项目工作区支持引入全局 Agent（引用机制，实时同步）
  - 启用/禁用控制，禁用的 Agent 不注入 SDK
  - 从 Claude Code 同步全局 Agent
- **Chat 侧边栏「Agent 能力」面板**：展示当前项目已启用的 Sub-Agents / Skills / Commands
  - 折叠/展开面板，按类型分组显示
  - 悬停查看描述，点击 Skill/Command 插入到输入框
  - 右键菜单快速跳转设置页
- **预置内置技能**：开箱即用 6 个常用技能
  - docx（Word 文档）、pdf、pptx（PPT）、xlsx（Excel）、skill-creator（技能创建向导）、summarize（内容摘要）
  - 首次启动自动种子到 `~/.myagents/skills/`，不覆盖用户已有内容
- **全局技能启用/禁用**：Settings 技能列表支持 toggle 开关
  - 禁用的技能不出现在 `/` 斜杠命令和能力面板中
  - 状态持久化到 `~/.myagents/skills-config.json`

### Changed
- **统一 Session ID 架构**：通过 SDK 0.2.33 新特性消除双 ID 映射，新 session 在产品层和 SDK 层使用同一 ID
- 升级 Claude Agent SDK 到 0.2.34
- **SDK 预热机制**：打开 Tab 时提前启动 SDK 子进程和 MCP 服务器，消除首次发送消息的冷启动延迟
  - 500ms 防抖批量处理快速配置变更
  - 预热失败自动重试（最多 3 次），配置变更时重置
  - 预热会话对前端不可见，首条消息时无缝切换为活跃状态
- **MCP 版本锁定**：预设 MCP 服务（Playwright）锁定到具体版本号，避免每次启动的 npm 注册表查询延迟（2-5s）
- **网络代理设置移至「通用」**：从「关于 - 开发者模式」移至「通用设置」，普通用户可直接使用
- Settings 页面新增 Agents 分区，与 Skills 平级
- WorkspaceConfigPanel 新增 Agents Tab

---

## [0.1.10] - 2026-02-05

### Added
- **定时任务功能**：让 AI Agent 按设定周期自动执行任务
  - 支持设置任务间隔时间（分钟）
  - 多种结束条件：截止时间、执行次数、AI 主动退出
  - 运行模式：单 Session 持续执行 / 每次新建 Session
  - 任务运行时输入框显示状态遮罩，支持查看设置和停止任务
  - 历史记录中显示「定时」标签标识
- **后台运行支持**：应用可最小化到系统托盘持续运行
  - 点击关闭按钮最小化到托盘（可在设置中关闭）
  - 托盘右键菜单：打开、设置、退出
  - macOS 点击 Dock 图标恢复窗口
  - macOS 菜单栏使用标准模板图标
  - 退出时若有运行中任务会弹窗确认
- **通用设置页面**：新增「通用」设置 Tab
  - 开机启动开关
  - 最小化到托盘开关
  - 任务消息通知开关
- **技术架构升级**：Session-Centric Sidecar 管理，支持多入口（Tab/定时任务）共享 Agent 实例

---

## [0.1.9] - 2026-02-02

### Added
- **MCP 零门槛使用**：预设 MCP（如 Playwright）使用内置 bun 执行，无需安装 Node.js
- **MCP 运行时检测**：启用自定义 MCP 时自动检测命令是否存在，不存在则弹窗引导下载
- **系统通知**：AI 任务完成、权限请求、问答确认时自动发送系统通知（窗口失焦时）
- 技能/指令卡片展示作者信息
- Chat 页面顶部显示当前项目名称

### Changed
- 项目设置只展示项目级数据，新增「查看用户技能/指令」跳转链接
- 项目设置图标改为黑底白色齿轮
- 输入框视觉优化：更大的字号和行高
- 快捷功能卡片改为横向布局
- 项目工作区折叠按钮移至标题栏最右端

### Fixed
- 彻底修复 Chat 页面滚动回弹问题
- **Windows 10 1909 兼容性修复**：安装程序自动安装 Git for Windows（Claude Agent SDK 依赖）

---

## [0.1.8] - 2026-02-01

### Added
- **Analytics 系统**
  - 匿名使用统计，帮助改进产品体验
  - 默认关闭，需通过环境变量 `MYAGENTS_ANALYTICS_ENABLED=true` 启用
  - 支持事件批量发送、防抖、节流（每分钟最多 200 事件）
  - 数据加密传输，不收集任何敏感信息（代码、对话内容等）
  - device_id 持久化存储到 `~/.myagents/device_id`（跨安装保持一致）


---

## [0.1.7] - 2026-01-31

### Added
- Windows 平台开发工具（`build_dev_win.ps1`）
- 设置页面「关于」新增用户交流群二维码（自动缓存，离线可用）
- 代理配置支持（Settings > About > Developer Mode）
  - 支持 HTTP/HTTPS/SOCKS5 协议
  - 自动应用于 Claude Agent SDK 和应用更新下载

### Changed
- 改进 Windows 安装器升级体验，支持直接覆盖安装（无需先卸载旧版本）
- 优化网络连接池配置（降低资源占用）

### Fixed
- **Windows 平台关键修复**：
  - 修复 Windows 生产包无法启动的问题
  - 修复 Sidecar 连接失败（代理配置冲突）
  - 修复 Windows Tauri IPC 通信错误（CSP 配置不完整）
  - 修复构建脚本导致的配置缓存问题
  - 修复启动页工作区名称显示完整路径（应显示文件夹名）
  - 修复工具徽章 Windows 路径显示问题（3 处）
- 修复二维码加载失败问题（Windows CSP 限制）
- 修复代理环境下 localhost 连接失败
- 修复 Tab 关闭确认对话框无效（正在生成时关闭未被阻止）
- 修复 Windows 关闭最后一个 Tab 时程序退出
- 修复 React ref 在渲染期间更新（ESLint 警告）
- 修复多项代码质量问题（进程清理竞态、错误处理等）

### Technical
- 统一代理配置模块，消除代码重复
- Tab 关闭确认重构：使用 ConfirmDialog 替代 window.confirm()（符合 React 声明式编程）
- 路径处理标准化：优先使用 Tauri `basename()` API，同步场景使用 `/[/\\]/` 正则
- 完善错误处理和日志记录
- 增强构建脚本健壮性（清理验证、容错处理）
- 新增技术文档：代理配置、构建问题排查、Windows 平台指南

**详见**: [specs/prd/prd_0.1.7.md](./specs/prd/prd_0.1.7.md)

---

## [0.1.6] - 2026-01-30

### Added
- **Windows 客户端支持**
  - NSIS 安装包 (`MyAgents_x.x.x_x64-setup.exe`)
  - 便携版 ZIP (`MyAgents_x.x.x_x86_64-portable.zip`)
  - 自动更新支持（共用 Tauri 签名密钥）
- 新增 Windows 构建脚本
  - `setup_windows.ps1` - 环境初始化
  - `build_windows.ps1` - 构建脚本
  - `publish_windows.ps1` - 发布脚本（含 `latest_win.json` 生成）
- 新增 `src/server/utils/platform.ts` 跨平台工具模块
- **支持 `server_tool_use` 内容块类型**（第三方 API 如智谱 GLM-4.7 的服务端工具调用）
- **设置页面添加用户交流群二维码**
  - 位于「关于」页面，从 R2 动态加载
  - 网络异常时自动隐藏
  - 新增 `upload_qr_code.sh` 上传脚本
- **MCP 表单 UI 改进**
  - 优化服务器配置表单交互体验

### Changed
- `runtime.ts` 支持 Windows 路径检测 (`bun.exe`, `%USERPROFILE%\.bun`, etc.)
- `sidecar.rs` 支持 Windows 进程管理 (`wmic` + `taskkill`)
- 统一跨平台环境变量处理（消除 10+ 处重复代码）
- **全局视觉优化与设计规范更新**
- 工作区右键菜单「快速预览」改为「预览」
- **会话统计 UI 优化**
  - 「缓存读取」改为「输入缓存」（= cache_read + cache_creation）
  - 消息明细新增「输入缓存」列

### Fixed
- 修复 Windows 自定义标题栏按钮无效（缺少 Tauri 权限）
- 修复 UI 卡在 loading 状态（`chat:system-status` 事件未注册 + React 批量更新延迟）
- 修复 `MultiEdit` 工具完成后工作区不刷新
- 修复 MCP 服务器和命令系统的 Windows 跨平台路径问题
- 修复智谱 GLM-4.7 `server_tool_use` 的输入解析（JSON 字符串 → 对象）
- 过滤智谱 API 返回的装饰性工具文本（避免干扰正常内容显示）
- **Token 统计修复**
  - 从 SDK result 消息提取统计数据（更可靠）
  - 支持多模型分别统计（新增 `modelUsage` 字段）
  - 修复智谱/Anthropic 等供应商统计数据为 0 的问题
- 修复流式输出中空白 chunk 过滤（保留有效换行和空格）
- 修复进程终止信号被错误保存为错误消息
- 为未知工具添加兜底图标 (Wrench)

### Technical
- Windows 数据目录：`%APPDATA%\MyAgents\`
- 添加 `buildCrossPlatformEnv()` 统一子进程环境变量构建
- 使用 `flushSync` 强制同步关键 UI 状态更新
- 装饰性文本过滤使用多条件匹配，避免误伤正常内容
- 新增 `ModelUsageEntry` 类型支持按模型分组存储 token 统计

**详见**: [specs/prd/prd_0.1.6.md](./specs/prd/prd_0.1.6.md)

---

## [0.1.5] - 2026-01-29

### Added
- 添加网络代理设置功能（开发者模式）
  - 支持 HTTP/SOCKS5 协议
  - 设置入口：设置 → 关于 → 点击 Logo 5次 → 开发者区域
  - Sidecar 启动时自动注入 HTTP_PROXY/HTTPS_PROXY 环境变量

### Changed
- 升级 Claude Agent SDK 从 0.2.7 到 0.2.23
- 建立 E2E 测试基础设施（Anthropic/Moonshot 双供应商测试）
- 统一 `/api/commands` 端点的命令解析逻辑
  - 使用 `parseFullCommandContent()` 替代 `parseYamlFrontmatter()`
  - 优先使用 frontmatter.name，回退到文件名
  - 提取 `scanCommandsDir()` 消除代码重复
- 统一版本记录到 CHANGELOG.md（移除 specs/version.md）

### Fixed
- 修复全局用户指令在对话 `/` 菜单中不显示的问题
  - `/api/commands` 端点新增扫描 `~/.myagents/commands/` 目录

### Technical
- 代理设置提取 `PROXY_DEFAULTS` 常量，消除魔数
- 添加 `isValidProxyHost()` 验证函数
- Rust 侧同步添加默认值常量

---

## [0.1.4] - 2026-01-29

### Added
- 支持编辑自定义供应商的名称、云服务商标签、Base URL、模型列表
- 编辑面板内增加「删除」按钮，附确认弹窗
- 删除供应商时自动切换受影响项目到其他可用供应商
- 模型标签 hover 显示删除按钮（用户添加的模型可删除）
- 预设供应商支持用户添加自定义模型
- 预设模型显示「预设」标签，不可删除
- 历史记录显示消息数和 Token 消耗统计
- 新增统计详情弹窗（按模型分组、消息明细）
- 无 MCP 工具时显示引导文案，链接至设置页面
- 工作区右键菜单「引用」（文件/文件夹/多选均支持插入 `@路径`）
- 新建技能对话框增加「导入文件夹」选项（桌面端）
- Moonshot 供应商新增 Kimi K2.5 模型

### Changed
- 消息存储升级为 JSONL 格式（O(1) 追加，崩溃容错）
- 增量统计计算、行数缓存、文件锁机制
- Tab 切换时自动同步供应商、API Key、MCP 配置
- Slash 命令菜单键盘导航时自动滚动保持选中项可见

### Fixed
- 修复消息中断后 Thinking Block 卡在加载状态
- 修复 API Key 模式切换到订阅模式报错（`Invalid signature in thinking block`）
- 修复长文本（如 JSON）在消息气泡中不换行
- 修复历史记录「当前」标签不更新
- 修复历史记录按钮点击无法关闭
- 修复加载历史会话后新消息统计不更新
- 修复 switchToSession 未终止旧 session 导致模型/供应商切换失效
- 修复三方供应商切换到 Anthropic 官方时 thinking block 签名冲突
- 修复第三方供应商模型切换后 UI 卡住（thinking/tool 块加载状态未结束）
- 修复 AI 回复完成后 Loading 指示器和停止按钮卡住（补全 9 种结束场景的 sessionState 重置）
- 修复发送消息后不自动滚动到底部
- 修复系统任务（如 Compact）期间显示停止按钮的误导
- 修复进程泄露问题（SDK/MCP 子进程随应用关闭正确清理）
- 优化文件预览性能（React.lazy + useMemo 缓存）

### Technical
- 应用退出支持 Cmd+Q 和 Dock 右键退出的进程清理（RunEvent::ExitRequested）
- 进程清理函数重构，统一 SIGTERM → SIGKILL 两阶段关闭
- 启动时清理扩展至 SDK 和 MCP 子进程

**详见**: [specs/prd/prd_0.1.4.md](./specs/prd/prd_0.1.4.md)

---

## [0.1.3] - 2026-01-27

### Added
- 支持从 Claude Code 同步 Skills 配置（`~/.claude/skills/` → `~/.myagents/skills/`）
- ProcessRow 显示任务运行时间
- 展开状态显示实时统计信息（工具调用次数、Token 消耗）
- 新增 Trace 列表查看子代理工具调用记录
- Settings 页面增加 Rust 日志监听

### Changed
- 技能/指令详情页焦点控制优化
- 描述区域支持多行输入
- 内容区域高度自适应视口

### Fixed
- 修复 Toast/ImagePreview Context 稳定性问题
- 统一 useEffect 依赖数组规范
- 统一定时器初始化模式
- 修复权限弹框重复弹出问题
- 修复 Settings 页面事件监听竞态条件
- 修复 tauri-plugin-updater 架构目标识别问题
- 移除非标准 platform 字段，符合 Tauri v2 官方 schema
- 修复事件发射错误处理
- 修复更新按钮样式（emerald 配色 + rounded-full）

### Technical
- 增加文件描述符限制至 65536，防止 Bun 启动失败
- 添加 `--myagents-sidecar` 标记精确识别进程
- 实现两阶段清理机制（SIGTERM → SIGKILL）
- 明确 Tab Sidecar 与 Global Sidecar 使用边界
- Settings/Launcher 不再包裹 TabProvider
- Release 构建启用 INFO 级别日志支持诊断
- 调试日志包装 `isDebugMode()` 避免生产环境刷屏

**详见**: [specs/prd/prd_0.1.3.md](./specs/prd/prd_0.1.3.md)

---

## [0.1.2] - 2026-01-25

### Added
- 实现自定义服务商完整的 CRUD 功能
- 服务商配置持久化到 `~/.myagents/providers/`

### Fixed
- 修复 MCP 开关状态与实际请求不一致问题
- 初始化时始终同步 MCP 配置（包括空数组）
- MCP 变化时正确重启 SDK 会话
- 切换配置时保持对话上下文（通过 resume session_id）
- 修复 AI "失忆" 问题
- 实现用户级 Skill 按需复制到项目目录
- `/` 菜单去重（项目级优先）
- 修复详情页交互问题（保存后自动关闭、名称字段、路径重命名）
- 修复 `/cost` 和 `/context` 命令输出不显示问题
- 正确处理 `<local-command-stdout>` 包裹的字符串内容

### Changed
- 设置页版本号动态读取
- 日志规范化（生产环境不输出调试日志）

**详见**: [specs/prd/prd_0.1.2.md](./specs/prd/prd_0.1.2.md)

---

## [0.1.1] - 2026-01-26

### Added
- 添加订阅凭证真实验证功能
- 设置页显示验证状态（验证中/已验证/验证失败）
- 支持拖拽文件到工作区文件夹
- 支持 Cmd+V 粘贴文件到工作区
- 支持拖拽/粘贴文件到对话输入框（自动复制到 `myagents_files/`）
- AskUserQuestion 工具向导式问答 UI
- 单选自动跳转 / 多选手动确认
- 自定义输入框支持
- 进度指示器和回退修改
- Agent 日志懒加载创建
- 日志存储到 `~/.myagents/logs/`
- React/Bun/Rust 日志统一到 UnifiedLogs 面板

### Fixed
- 修复 Anthropic 订阅检测逻辑（`~/.claude.json` 中的 `oauthAccount`）

### Changed
- 文件名冲突自动重命名
- Cmd+Z 撤销支持
- 30 天日志自动清理

**详见**: [specs/prd/prd_0.1.1.md](./specs/prd/prd_0.1.1.md)

---

## [0.1.0] - 2026-01-24

### Added
- Initial open source release
- Native macOS desktop application with Tauri v2
- Multi-tab support with independent Sidecar processes
- Multi-project management
- Claude Agent SDK integration
- Support for multiple AI providers:
  - Anthropic (Claude Sonnet/Haiku/Opus 4.5)
  - DeepSeek
  - Moonshot (Kimi)
  - Zhipu AI
  - MiniMax
  - Volcengine
  - OpenRouter
- Slash Commands (built-in and custom)
- MCP integration (STDIO/HTTP/SSE)
- Tool permission management (Act/Plan/Auto modes)
- Visual configuration editor for CLAUDE.md, Skills, and Commands
- Keyboard shortcuts (Cmd+T, Cmd+W)
- Local data storage in `~/.myagents/`

### Technical
- React 19 + TypeScript frontend
- Bun runtime bundled in app
- Rust HTTP/SSE proxy layer
- Chrome-style frameless window
- 零外部依赖（内置 Bun 运行时）

**详见**: [specs/prd/prd_0.1.0/](./specs/prd/prd_0.1.0/) (21 个迭代 PRD)

---
