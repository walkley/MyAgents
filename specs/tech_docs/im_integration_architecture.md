# MyAgents IM 集成技术架构

> **文档状态**：实现完成，基于代码实际情况更新
>
> **更新日期**：2026-02-18
>
> **前置调研**：
> - [OpenClaw IM 通道集成架构研究](../prd/research_openclaw_im_integration.md)
> - [ZeroClaw 纯 Rust IM 方案调研](../prd/research_zeroclaw_rust_im_integration.md)

---

## 一、核心架构决策

### 1.1 分层解耦：IM in Rust, AI in Bun

| 层 | 职责 | 实现语言 | 理由 |
|----|------|---------|------|
| **IM 适配层** | Telegram 连接管理、消息收发、重连、白名单 | Rust | I/O 密集型，零 GC、稳定性高，崩溃不影响 IM 连接 |
| **Session 路由层** | peer→Sidecar 映射、按需启停、消息缓冲 | Rust | 复用 SidecarManager，统一进程生命周期管理 |
| **AI 对话层** | Claude SDK、MCP、工具系统、Session 管理 | Bun Sidecar | 已有完整生态，不值得用 Rust 重写 |

**关键优势**：
1. **故障隔离**：AI 进程（Bun）崩溃 → Rust IM 层继续收消息、缓冲 → 自动重启 Bun → resume Session → 用户无感
2. **资源高效**：IM 连接在 Rust，额外内存 < 5MB
3. **连接稳定**：Rust 长轮询天然适合 always-on 场景

### 1.2 多 Bot 架构

支持同时运行多个 IM Bot 实例，每个 Bot 拥有独立的配置、连接、Session 和健康状态。

```
┌─────────────────────────────────────────────────────────────────┐
│                       Tauri Desktop App                          │
├──────────────────────────────────────────────────────────────────┤
│                        React Frontend                             │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────────────┐ │
│  │  Chat Tab  │  │  Chat Tab  │  │  Settings → 聊天机器人       │ │
│  │ Tab Sidecar│  │ Tab Sidecar│  │  ┌─────┐ ┌─────┐ ┌─────┐  │ │
│  └──────┬─────┘  └──────┬─────┘  │  │Bot 1│ │Bot 2│ │Bot 3│  │ │
│         │               │        │  └──┬──┘ └──┬──┘ └──┬──┘  │ │
├─────────┼───────────────┼────────┼─────┼──────┼──────┼───────┤ │
│         ▼               ▼        │     ▼      ▼      ▼ Rust  │ │
│  ┌─────────────┐  ┌───────────┐  │ ManagedImBots               │ │
│  │ Tab Sidecar │  │Tab Sidecar│  │ HashMap<String, ImBotInstance│ │
│  │ :31415      │  │ :31416    │  │   ├── bot_1 → Instance      │ │
│  └─────────────┘  └───────────┘  │   │   ├── TelegramAdapter   │ │
│                                  │   │   ├── SessionRouter      │ │
│                                  │   │   ├── HealthManager      │ │
│                                  │   │   └── MessageBuffer      │ │
│                                  │   ├── bot_2 → Instance      │ │
│                                  │   └── bot_3 → Instance      │ │
│                                  └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                          │
                    Telegram Bot API
```

---

## 二、Rust 侧实现

### 2.1 核心数据结构

```rust
/// 多 Bot 管理容器（Tauri State）
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// 单个 Bot 实例
pub struct ImBotInstance {
    pub bot_id: String,
    pub shutdown_tx: watch::Sender<bool>,      // 优雅关闭信号
    pub health: Arc<HealthManager>,            // 健康状态持久化
    pub router: Arc<Mutex<SessionRouter>>,     // peer→Sidecar 映射
    pub buffer: Arc<Mutex<MessageBuffer>>,     // 离线消息缓冲
    pub started_at: Instant,                   // 用于计算 uptime
    pub process_handle: JoinHandle<()>,        // 消息处理主循环
    pub bind_code: String,                     // QR 绑定码 "BIND_{uuid8}"
    pub config: ImConfig,                      // 运行时配置快照
}
```

### 2.2 Tauri Commands

```rust
/// 启动指定 Bot（若已运行则先优雅停止再重启）
#[tauri::command]
async fn cmd_start_im_bot(
    botId: String,
    botToken: String,
    allowedUsers: Vec<String>,
    permissionMode: String,
    workspacePath: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    mcpServersJson: Option<String>,
    availableProvidersJson: Option<String>,
) -> Result<ImBotStatus, String>;

/// 停止指定 Bot
#[tauri::command]
async fn cmd_stop_im_bot(botId: String) -> Result<(), String>;

/// 查询单个 Bot 状态
#[tauri::command]
async fn cmd_im_bot_status(botId: String) -> Result<ImBotStatus, String>;

/// 批量查询所有 Bot 状态
#[tauri::command]
async fn cmd_im_all_bots_status() -> Result<HashMap<String, ImBotStatus>, String>;

/// 获取 Bot 的对话列表
#[tauri::command]
async fn cmd_im_conversations(botId: String) -> Result<Vec<ImConversation>, String>;
```

### 2.3 Bot 生命周期

#### 启动流程（`start_im_bot()`）

```
cmd_start_im_bot(botId, botToken, ...)
    │
    ├── 若同 botId 已在运行 → 优雅停止（等待 5s 收尾）
    │
    ├── 迁移遗留文件
    │     └── im_state.json → im_{botId}_state.json
    │     └── im_buffer.json → im_{botId}_buffer.json
    │
    ├── 初始化组件
    │     ├── HealthManager（加载上次状态）
    │     ├── MessageBuffer（恢复磁盘缓冲）
    │     └── SessionRouter（恢复 peer→session 映射）
    │
    ├── 创建 TelegramAdapter
    │     └── 传入 allowed_users: Arc<RwLock<Vec<String>>>
    │
    ├── 验证连接
    │     └── getMe() → 获取 bot_username
    │
    ├── 注册 Bot 命令
    │     └── setMyCommands: /new, /workspace, /model, /provider, /status
    │
    ├── 初始化运行时共享状态
    │     ├── current_model: Arc<RwLock<Option<String>>>
    │     └── current_provider_env: Arc<RwLock<Option<Value>>>
    │
    ├── 启动后台任务
    │     ├── 消息处理主循环（tokio::spawn）
    │     ├── Telegram 长轮询（listen_loop）
    │     ├── 健康状态持久化（5s 间隔）
    │     └── 空闲 Session 回收（60s 间隔）
    │
    ├── 生成绑定 URL
    │     └── https://t.me/{username}?start=BIND_{uuid8}
    │
    └── 返回 ImBotStatus（含 bot_username、bind_url）
```

#### 关闭流程（`stop_im_bot()`）

```
cmd_stop_im_bot(botId)
    │
    ├── 发送 shutdown 信号（watch channel）
    ├── 等待 process_handle 完成（超时 10s）
    ├── 持久化缓冲消息到磁盘
    ├── 持久化活跃 Session 到健康状态
    ├── 释放所有 Sidecar Session
    └── 设置状态 Stopped，写入最终状态
```

#### 应用启动自动恢复

```
Tauri app 启动
    │
    └── 遍历 config.imBotConfigs[]
          └── 若 enabled == true && botToken 非空
                └── cmd_start_im_bot(...)
```

### 2.4 消息处理循环

**并发模型**：

```
Per-Message Task:
1. 获取 per-peer 锁（同一用户/群消息串行化）
   ↓
2. 获取 global semaphore（GLOBAL_CONCURRENCY = 5）
   ↓
3. 短暂锁 router（ensure_sidecar + record_response）
   ↓
4. SSE 流式读取 AI 响应（stream_to_telegram）
   ↓
5. 重放缓冲消息（同一 peer lock 内）
```

**命令分发（无需 Sidecar I/O）**：

| 命令 | 行为 |
|------|------|
| `/start BIND_xxxx` | QR 绑定：添加用户到白名单，发射 `im:user-bound` 事件 |
| `/start` | 显示帮助文本 |
| `/new` | 重置 Session（`router.reset_session()`） |
| `/workspace [path]` | 显示/切换工作区 |
| `/model [name]` | 显示/切换 AI 模型（支持快捷名：sonnet, opus, haiku） |
| `/provider [id]` | 显示/切换 AI 供应商 |
| `/status` | 显示 Session 信息 |

**普通消息处理（SSE 流式）**：

```
收到普通消息
    │
    ├── ACK：setMessageReaction(⏳) + sendChatAction(typing)
    │
    ├── ensure_sidecar()：获取/创建 Sidecar
    ├── 若新 Sidecar → 同步 AI 配置（model + MCP servers）
    │
    ├── POST /api/im/chat → SSE 流
    │     ├── "partial" 事件 → 节流编辑消息（≥1s 间隔，截断 4000 字符）
    │     ├── "block-end" 事件 → 定稿（>4096 字符则分片发送）
    │     ├── "complete" 事件 → 返回 sessionId
    │     └── "error" 事件 → 删除 draft，发送错误消息
    │
    ├── 清除 ACK：setMessageReaction("")
    ├── 更新 Session 状态：record_response(session_key, sessionId)
    ├── 更新健康状态：last_message_at, active_sessions
    │
    └── 重放缓冲消息（若有）
```

### 2.5 Telegram Adapter

```rust
pub struct TelegramAdapter {
    bot_token: String,
    allowed_users: Arc<RwLock<Vec<String>>>,  // 可热更新白名单
    client: reqwest::Client,                  // LONG_POLL_TIMEOUT + 10s
    coalescer: Arc<Mutex<MessageCoalescer>>,  // 碎片合并 + 防抖
    bot_username: Arc<Mutex<Option<String>>>, // getMe() 后缓存
}
```

**ImAdapter Trait**：
- `verify_connection()` → `getMe()` 验证 Token
- `register_commands()` → `setMyCommands()` 注册命令菜单
- `listen_loop()` → `getUpdates` 长轮询，指数退避重连
- `send_message()` → 自动分片 + Markdown 降级 + 纯文本 fallback
- `ack_received/processing/clear()` → `setMessageReaction` emoji 管理

**MessageCoalescer（碎片合并 + 防抖）**：
- 缓冲 ≥4000 字符的消息为 fragments
- 合并连续 fragments（<1500ms 间隔 + 同 chat_id）
- 非 fragment 消息立即返回（不防抖）
- 500ms 超时后刷出合并结果

**白名单**：
- 空白名单 → 拒绝所有消息（安全默认）
- 检查 user_id 和 username
- QR 绑定请求（`/start BIND_`）绕过白名单
- 群聊需 @mention 或 `/ask` 前缀

**错误处理**：

| 错误类型 | 处理策略 |
|----------|---------|
| 429 Rate Limited | 等待 `retry_after` 秒后重试 |
| 500/503 瞬态错误 | 3 次重试，1s 退避 |
| 401 Unauthorized | 停止长轮询 |
| Markdown 解析失败 | 降级纯文本重发 |
| 消息未修改 | 静默忽略（Draft Stream 常见） |
| 消息过长 | 自动分片（4096 UTF-16 code unit 限制） |

### 2.6 Session Router

```rust
pub struct SessionRouter {
    peer_sessions: HashMap<String, PeerSession>,   // peer→session 映射
    sidecar_manager: Arc<ManagedSidecarManager>,
    default_workspace: PathBuf,
    global_semaphore: Arc<Semaphore>,              // 默认 5 并发
    peer_locks: HashMap<String, Arc<Mutex<()>>>,   // 同一 peer 串行化
}
```

**Session Key 设计**：
```
私聊：  im:telegram:private:{user_id}
群聊：  im:telegram:group:{group_id}
```

**Sidecar 所有权**：IM Bot 使用 `SidecarOwner::ImBot(session_key)` 作为 Sidecar 的 owner，与 `Tab`、`CronTask`、`BackgroundCompletion` 并列。当所有 owner 释放时 Sidecar 自动停止。`ensure_session_sidecar()` 和 `release_session_sidecar()` 统一管理生命周期。

### 2.7 健康状态持久化

```rust
pub struct HealthManager {
    state: Arc<Mutex<ImHealthState>>,
    persist_path: PathBuf,  // ~/.myagents/im_{bot_id}_state.json
}

pub struct ImHealthState {
    pub status: ImStatus,                      // Online | Connecting | Error | Stopped
    pub bot_username: Option<String>,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub last_persisted: Option<String>,
}
```

**持久化**：每 5 秒写入磁盘，供前端轮询展示。

**Per-Bot 文件路径**：
- 健康状态：`~/.myagents/im_{bot_id}_state.json`
- 消息缓冲：`~/.myagents/im_{bot_id}_buffer.json`
- 遗留文件迁移：首次启动时 `im_state.json` → `im_{bot_id}_state.json`，原文件重命名为 `.migrated`

### 2.8 消息缓冲

```rust
pub struct MessageBuffer {
    queue: VecDeque<BufferedMessage>,
    max_size: usize,        // 默认 100 条
    persist_path: PathBuf,  // 磁盘持久化
}
```

Sidecar 不可用时消息进入缓冲队列，恢复后在同一 peer lock 内按序重放。

### 2.9 Draft Stream（流式输出到 Telegram）

已实现的 SSE 流式输出机制：

```
Rust 调用 Bun /api/im/chat (SSE stream)
    │
    ├── 收到 "partial" 事件
    │     ├── 首次 → sendMessage() 创建 draft
    │     └── 后续 → editMessageText(draft_id, text)
    │           └── 节流：距上次编辑 ≥ 1s
    │           └── 截断：最多 4000 字符
    │
    ├── 收到 "block-end" 事件
    │     ├── 文本 ≤ 4096 → editMessageText 定稿
    │     └── 文本 > 4096 → deleteMessage(draft) → 分片发送
    │
    ├── 收到 "complete" 事件
    │     └── 返回 sessionId，流结束
    │
    └── 收到 "error" 事件
          └── deleteMessage(draft) → sendMessage(错误信息)
```

**多 Block 支持**：AI 回复可包含多个 text block，每个 block 独立创建/编辑 draft 消息。

### 2.10 Tauri 事件

| 事件 | Payload | 触发时机 |
|------|---------|---------|
| `im:user-bound` | `{ botId, userId, username? }` | 用户通过 QR 码绑定成功 |

---

## 三、前端实现

### 3.1 组件结构

```
src/renderer/components/ImSettings/
├── ImSettings.tsx              # 路由容器（list/detail/wizard 三视图）
├── ImBotList.tsx               # Bot 列表页
├── ImBotDetail.tsx             # Bot 详情/配置页
├── ImBotWizard.tsx             # 2 步创建向导
├── assets/
│   ├── telegram.png            # Telegram 平台图标
│   └── telegram_bot_add.png    # BotFather 教程截图
└── components/
    ├── BotTokenInput.tsx       # Token 输入（密码型 + 验证状态）
    ├── BotStatusPanel.tsx      # 运行状态单行面板
    ├── BindQrPanel.tsx         # QR 码绑定面板
    ├── WhitelistManager.tsx    # 白名单管理（添加/删除 + 药丸标签）
    ├── PermissionModeSelect.tsx # 权限模式单选卡片
    ├── AiConfigCard.tsx        # 供应商 + 模型选择
    └── McpToolsCard.tsx        # MCP 工具复选列表
```

### 3.2 路由模式（ImSettings.tsx）

```typescript
type View =
    | { type: 'list' }
    | { type: 'detail'; botId: string }
    | { type: 'wizard' };
```

无 URL 路由，纯状态驱动的视图切换。

### 3.3 Bot 列表页（ImBotList.tsx）

- **数据源**：`config.imBotConfigs[]` 来自 `useConfig()`
- **状态轮询**：每 5s 调用 `cmd_im_all_bots_status` 获取所有 Bot 状态
- **卡片布局**：2 列 grid，每张卡片展示：
  - 平台图标（Telegram PNG icon）
  - Bot 名称（优先 `@username`，fallback 配置名）
  - 运行状态点 + 文本
  - 工作区路径 · 平台类型
  - 启动/停止胶囊按钮
- **Toggle 操作**：
  - 构建启动参数（provider env、available providers、MCP servers）
  - 调用 `cmd_start_im_bot` / `cmd_stop_im_bot`
  - 乐观更新 `statuses` 状态（stop → 立即标记 stopped，start → 使用返回的 ImBotStatus）
  - 保存 `enabled` 字段

### 3.4 创建向导（ImBotWizard.tsx）

**步骤 1：Token 配置**
- 教程图片 + 步骤说明（如何从 @BotFather 获取 Token）
- Token 输入 + 验证
- 重复 Token 检测
- 保存初始配置（`setupCompleted: false`）
- 调用 `cmd_start_im_bot` 验证 Token
- 成功后自动同步 `@username` 为 Bot 名称

**步骤 2：用户绑定**
- 轮询 Bot 状态获取 `bindUrl`（3s 间隔）
- QR 码展示 + 步骤说明
- 监听 `im:user-bound` 事件自动添加白名单
- 手动白名单管理
- 完成/跳过按钮 → 设置 `setupCompleted: true`

**取消**：停止 Bot + 删除配置。

### 3.5 详情页（ImBotDetail.tsx）

**核心 Hooks/Refs**：
- `useConfig()` → config, providers, apiKeys, projects, refreshConfig
- `toastRef` → 稳定 toast 引用
- `isMountedRef` → 异步安全守卫
- `nameSyncedRef` → 名称一次性同步标记
- `botConfigRef` → effect 中使用，不触发重新执行

**配置分区**（从上到下）：

| 分区 | 组件 | 说明 |
|------|------|------|
| 标题栏 | — | `@username` 或配置名 + 启动/停止按钮 |
| 运行状态 | BotStatusPanel | 状态点 + 标签 + 运行时间 + 会话数 + 错误 |
| Telegram Bot | BotTokenInput | Token 输入 + 重复检测 + 验证状态 |
| 用户绑定 | BindQrPanel + WhitelistManager | QR 码 + 手动管理 |
| 默认工作区 | CustomSelect | 项目列表 + 文件夹选择 + 运行中自动重启 |
| 权限模式 | PermissionModeSelect | 行动/规划/自主行动 三选一 |
| AI 配置 | AiConfigCard | 供应商 + 模型（独立于客户端） |
| MCP 工具 | McpToolsCard | 全局已启用的 MCP 服务勾选 |
| 危险操作 | ConfirmDialog | 删除 Bot（二次确认） |

**副作用**：
- 状态轮询（5s）：更新状态 + 一次性同步 Bot 名称
- MCP 加载：读取全局 MCP 服务列表
- 事件监听：`im:user-bound` → 自动添加白名单
- 工作区变更：若运行中 → 读最新配置 → 重启 Bot

### 3.6 子组件

**BotTokenInput**：
- 密码输入 + 显示/隐藏切换
- 验证状态图标（Loader2/Check/AlertCircle）
- blur/Enter 时触发 onChange 回调
- 验证成功展示 `@username`

**BotStatusPanel**：
- 单行紧凑展示：`● 运行中 · 4m · 0 个会话`
- 仅运行中显示 uptime/sessions
- 重启次数 > 0 时显示
- 错误信息 inline truncate

**BindQrPanel**：
- QR 码 160×160（qrcode 库生成）
- Deep link URL + 复制按钮
- 3 步说明
- 无白名单用户时显示"推荐"标签

**PermissionModeSelect**：
- 自定义 radio 卡片（`sr-only` 隐藏原生 radio）
- 选中态：品牌色边框 + 背景 + 内圆点
- 读取 `PERMISSION_MODES` 配置（行动/规划/自主行动）

---

## 四、配置持久化

### 4.1 数据模型

```typescript
interface ImBotConfig {
    id: string;                    // UUID
    name: string;                  // 展示名（自动同步为 @username）
    platform: 'telegram';         // 未来扩展 'feishu' | 'slack'
    botToken: string;
    allowedUsers: string[];        // Telegram user_id 或 username
    providerId?: string;           // AI 供应商（独立于客户端）
    model?: string;                // AI 模型
    permissionMode: string;        // 'plan' | 'auto' | 'fullAgency'
    mcpEnabledServers?: string[];  // Bot 可用的 MCP 服务 ID
    defaultWorkspacePath?: string;
    enabled: boolean;
    setupCompleted?: boolean;      // 向导完成标记
}
```

**存储位置**：`~/.myagents/config.json` → `imBotConfigs: ImBotConfig[]`

### 4.2 Config Service（磁盘优先）

```typescript
// 三个 IM 专用函数，全部 disk-first + withConfigLock 序列化

addOrUpdateImBotConfig(botConfig)    // Upsert by id
updateImBotConfig(botId, updates)    // Partial merge by id
removeImBotConfig(botId)             // Filter out by id
```

每个函数先 `loadAppConfig()` 读取磁盘最新，修改后 `saveAppConfig()` 写回。原子写入采用 `.tmp` → `.bak` → 目标文件 的安全模式。

### 4.3 React 状态同步

`useConfig()` 新增 `refreshConfig()` 方法：

```typescript
const refreshConfig = useCallback(async () => {
    const latest = await loadAppConfig();
    setConfig(latest);  // 只更新 config state，不触发 loading
}, []);
```

**使用模式**：所有 IM 组件的 config 写操作后调用 `refreshConfig()` 同步 React 状态。

```typescript
// ImBotDetail 中的 saveBotField
const saveBotField = useCallback(async (updates) => {
    await updateImBotConfig(botId, updates);
    await refreshConfig();  // 同步到 React state
}, [botId, refreshConfig]);
```

---

## 五、数据流

### 5.1 Telegram 消息 → AI → 回复

```
Telegram 用户发消息
       │
       ▼
TelegramAdapter (getUpdates 长轮询)
       │
       ├── 白名单校验 → 不在白名单 → 忽略
       ├── MessageCoalescer 碎片合并 + 防抖
       ├── 发送到 mpsc channel
       │
       ▼
消息处理循环
       │
       ├── 命令分发（inline，无 Sidecar I/O）
       │     ├── /start BIND_ → 添加白名单 → emit "im:user-bound"
       │     ├── /model → 更新 current_model RwLock
       │     ├── /provider → 更新 current_provider_env RwLock
       │     ├── /workspace → router.switch_workspace()
       │     └── /new → router.reset_session()
       │
       └── 普通消息
             ├── 获取 per-peer lock + global semaphore
             ├── ensure_sidecar()
             ├── 若新 Sidecar → 同步 AI config
             │
             ├── POST /api/im/chat (SSE stream)
             │     ├── partial → 编辑 draft（节流 ≥ 1s）
             │     ├── block-end → 定稿（分片如 > 4096）
             │     ├── complete → 返回 sessionId
             │     └── error → 发送错误信息
             │
             ├── 清除 ACK reaction
             ├── 更新 Session + 健康状态
             └── 重放缓冲消息
```

### 5.2 QR 码绑定流程

```
用户在设置页启动 Bot
    │
    ├── Rust 生成 bind_code = "BIND_{uuid8}"
    ├── 构造 bind_url = "https://t.me/{username}?start={bind_code}"
    ├── 返回 ImBotStatus（含 bind_url）
    │
    ▼
前端 BindQrPanel 展示 QR 码
    │
    ▼
用户扫码 → Telegram 打开 Bot → 自动发送 "/start BIND_xxxx"
    │
    ▼
Rust TelegramAdapter 收到消息
    │
    ├── 解析 bind_code → 匹配成功
    ├── 添加 user_id 到 allowed_users（Arc<RwLock>）
    ├── 回复绑定成功消息
    └── emit "im:user-bound" 事件
          │
          ▼
前端 ImBotDetail/ImBotWizard 监听事件
    │
    └── 添加用户到白名单配置 → saveBotField → refreshConfig
```

### 5.3 设置页 → Bot 生命周期

```
用户打开 Settings → 聊天机器人
    │
    ▼
ImBotList（读取 config.imBotConfigs + 轮询 statuses）
    │
    ├── 点击"添加 Bot" → ImBotWizard
    │     ├── Step 1: Token + 验证 + 启动
    │     └── Step 2: QR 绑定 → 完成/跳过
    │
    ├── 点击 Bot 卡片 → ImBotDetail
    │     ├── 修改配置 → saveBotField → refreshConfig
    │     ├── 工作区变更（运行中）→ 重启 Bot
    │     └── 删除 → ConfirmDialog → stop + remove + refreshConfig + onBack
    │
    └── 点击启动/停止 → toggleBot
          ├── 启动：buildStartParams → cmd_start_im_bot → 乐观更新
          └── 停止：cmd_stop_im_bot → 乐观更新为 stopped
```

---

## 六、安全模型

| 层级 | 机制 |
|------|------|
| 连接准入 | 白名单（Telegram user_id / username） |
| 空白名单 | 拒绝所有消息（安全默认） |
| 群聊触发 | 仅响应 @Bot 或 /ask |
| AI 权限 | 默认 `plan` 模式（只分析不执行） |
| 工作区沙箱 | 操作范围不超出 workspacePath |
| Token 重复 | 前端阻止同一 Token 添加多个 Bot |
| QR 绑定 | 随机 UUID bind_code，仅对应 Bot 可识别 |

---

## 七、文件清单

### Rust

```
src-tauri/src/
├── im/
│   ├── mod.rs          # 模块入口 + Commands + 消息处理循环 + Bot 生命周期
│   ├── telegram.rs     # TelegramAdapter + MessageCoalescer + ImAdapter trait
│   └── health.rs       # HealthManager + 状态持久化 + 遗留文件迁移
└── lib.rs              # Command 注册
```

### 前端

```
src/renderer/
├── components/ImSettings/     # 全部 IM 前端组件（见 §3.1）
├── config/configService.ts    # IM config CRUD 函数
├── config/types.ts            # PERMISSION_MODES + ImBotConfig 相关类型
├── hooks/useConfig.ts         # refreshConfig 函数
└── pages/Settings.tsx         # "聊天机器人" 导航入口
```

### 共享类型

```
src/shared/types/im.ts         # ImBotConfig, ImBotStatus, DEFAULT_IM_BOT_CONFIG
```

### 数据文件

```
~/.myagents/
├── config.json                # imBotConfigs[] 数组
├── im_{botId}_state.json      # Per-bot 健康状态
└── im_{botId}_buffer.json     # Per-bot 消息缓冲
```

---

## 八、Telegram Bot API 端点

| 端点 | 用途 |
|------|------|
| `getMe` | 验证 Token + 获取 bot_username |
| `getUpdates` | 长轮询接收消息 |
| `sendMessage` | 发送文本（Markdown → 纯文本 fallback） |
| `editMessageText` | Draft Stream 编辑（流式输出） |
| `deleteMessage` | 删除 Draft（超长回复时） |
| `sendChatAction` | 发送"正在输入"状态 |
| `setMessageReaction` | ACK Reaction（⏳ / 清除） |
| `setMyCommands` | 注册命令菜单 |

---

## 九、待实现 / 未来规划

### 9.1 多端 Session 共享

当前每个 Bot 的 Session 独立于 Desktop Tab。未来可实现 Desktop 打开 IM Session、双端同步等能力。

### 9.2 Bot Token 加密存储

当前 Token 明文存储在 `config.json`（与 Provider API Key 一致）。后续应统一迁移到 OS Keychain。

### 9.3 更多 IM 平台

`ImAdapter` trait 已定义，可扩展 Feishu（飞书）、Slack 等平台，复用 Session Router 和消息处理循环。

---

## 附录：相关文档

| 文档 | 说明 |
|------|------|
| [OpenClaw 调研](../prd/research_openclaw_im_integration.md) | TypeScript IM 方案调研 |
| [ZeroClaw 调研](../prd/research_zeroclaw_rust_im_integration.md) | Rust IM 方案调研 |
| [架构总览](./architecture.md) | MyAgents 整体架构 |
| [Session ID 架构](./session_id_architecture.md) | Session 管理机制 |
| [Sidecar 管理](./bundled_bun.md) | Bun Sidecar 生命周期 |
