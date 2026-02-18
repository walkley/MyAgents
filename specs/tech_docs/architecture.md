# MyAgents 技术架构

## 概述

MyAgents 是基于 Tauri v2 的桌面应用，提供 Claude Agent SDK 的图形界面。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Bun + TypeScript (多实例 Sidecar 进程) |
| AI | Anthropic Claude Agent SDK |
| 拖拽 | @dnd-kit/sortable |

## 架构图

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Tauri Desktop App                              │
├────────────────────────────────────────────────────────────────────────┤
│                           React Frontend                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │   Tab 1     │  │   Tab 2     │  │  Settings   │  │  IM Settings │ │
│  │ session_123 │  │ session_456 │  │  Launcher   │  │  聊天机器人   │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘ │
│         │                │                │                │          │
├─────────┼────────────────┼────────────────┼────────────────┼──────────┤
│         │                │                │                │ Rust     │
│   ┌─────┴────────────────┴─────┐   ┌─────┴──────┐  ┌──────┴───────┐ │
│   │     SidecarManager         │   │   Global   │  │ ManagedImBots│ │
│   │  Session-Centric Model     │   │  Sidecar   │  │  HashMap<    │ │
│   └─────┬────────────────┬─────┘   └────────────┘  │  botId,      │ │
│         │                │                          │  Instance>   │ │
│         ▼                ▼                          └──────┬───────┘ │
│  ┌─────────────┐  ┌─────────────┐                         │         │
│  │ Sidecar A   │  │ Sidecar B   │  ← Session 级别          │         │
│  │ session_123 │  │ session_456 │  (1:1 对应)              │         │
│  │ :31415      │  │ :31416      │                          ▼         │
│  └─────────────┘  └─────────────┘             Telegram Bot API       │
└───────────────────────────────────────────────────────────────────────┘
```

### 核心概念：Session-Centric Sidecar 架构 (v0.1.10+)

| 概念 | 说明 |
|------|------|
| **Sidecar = Agent 实例** | 一个 Sidecar 进程 = 一个 Claude Agent SDK 实例 |
| **Session:Sidecar = 1:1** | 每个 Session 最多有一个 Sidecar，严格对应 |
| **后端优先，前端辅助** | Sidecar 可独立运行（定时任务、IM Bot），无需前端 Tab |
| **Owner 模型** | Tab、CronTask、ImBot 是 Sidecar 的"使用者"，所有 Owner 释放后 Sidecar 才停止 |

### Sidecar 使用边界

| 页面类型 | TabProvider | Sidecar 类型 | API 来源 |
|----------|-------------|--------------|----------|
| Chat | ✅ 包裹 | Session Sidecar | `useTabState()` |
| Settings | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |
| Launcher | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |
| IM Bot | — (Rust 驱动) | Session Sidecar | Rust `ensure_session_sidecar()` |

**设计原则**：
- **Chat 页面**需要 Session Sidecar（有 `sessionId`，项目级 AI 对话）
- **Settings/Launcher**使用 Global Sidecar（全局功能、API 验证等）
- 不在 TabProvider 内的组件调用 `useTabStateOptional()` 返回 `null`，自动 fallback 到 Global API

## 核心模块

### 1. Session-Centric Sidecar Manager (`src-tauri/src/sidecar.rs`)

**核心数据结构**：

```rust
/// Sidecar 使用者类型
pub enum SidecarOwner {
    Tab(String),                 // Tab ID
    CronTask(String),            // CronTask ID
    BackgroundCompletion(String),// Session ID（AI 后台完成时保活）
    ImBot(String),               // session_key（IM Bot 消息处理）
}

/// Session 级别的 Sidecar 实例
pub struct SessionSidecar {
    pub session_id: String,
    pub port: u16,
    pub workspace_path: PathBuf,
    pub owners: HashSet<SidecarOwner>,  // 可以有多个使用者
    pub healthy: bool,
}

/// Session 激活记录
pub struct SessionActivation {
    pub session_id: String,
    pub tab_id: Option<String>,
    pub task_id: Option<String>,
    pub port: u16,
    pub workspace_path: String,
    pub is_cron_task: bool,
}

/// 多实例 Sidecar 管理器
pub struct SidecarManager {
    /// Session ID -> SessionSidecar (Session-centric 主存储)
    sidecars: HashMap<String, SessionSidecar>,

    /// Session ID -> SessionActivation (激活状态追踪)
    session_activations: HashMap<String, SessionActivation>,

    /// Tab ID -> SidecarInstance (遗留，仅 Global Sidecar 使用)
    instances: HashMap<String, SidecarInstance>,

    port_counter: AtomicU16,
}
```

**IPC 命令**：

| 命令 | 用途 |
|------|------|
| `cmd_ensure_session_sidecar` | 确保 Session 有运行中的 Sidecar |
| `cmd_release_session_sidecar` | 释放 Owner 对 Sidecar 的使用 |
| `cmd_get_session_port` | 获取 Session 的 Sidecar 端口 |
| `cmd_get_session_activation` | 查询 Session 激活状态 |
| `cmd_activate_session` | 激活 Session（记录到 HashMap）|
| `cmd_deactivate_session` | 取消 Session 激活 |
| `cmd_upgrade_session_id` | 升级 Session ID（场景 4 handover）|
| `cmd_start_global_sidecar` | 启动 Global Sidecar |
| `cmd_stop_all_sidecars` | 应用退出时清理全部 |

### 2. Multi-Tab 前端架构 (`src/renderer/context/`)

**每个 Tab 可以连接到一个 Session 的 Sidecar**：

| 组件 | 职责 |
|------|------|
| `TabContext.tsx` | Context 定义，提供 Tab-scoped API |
| `TabProvider.tsx` | 状态容器，管理 messages/logs/SSE/Session |

**Tab-Scoped API**：
```typescript
// 每个 Tab 通过 Session ID 获取对应的 Sidecar 端口
const { apiGet, apiPost, stopResponse } = useTabState();
```

### 3. Rust SSE Proxy (`src-tauri/src/sse_proxy.rs`)

**多连接 SSE 代理**：

```rust
pub struct SseProxyState {
    connections: Mutex<HashMap<String, SseConnection>>, // tabId -> connection
}
```

**事件隔离**：
```
事件格式: sse:${tabId}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

### 4. Chrome 风格标题栏 (`src/renderer/components/`)

| 组件 | 职责 |
|------|------|
| `CustomTitleBar.tsx` | 标题栏容器，处理拖拽区域和全屏检测 |
| `TabBar.tsx` | 可拖拽排序的标签栏，支持横向滚动 |
| `SortableTabItem.tsx` | 单个可排序标签 (@dnd-kit) |

**Tauri 配置要点**：
- `titleBarStyle: "Overlay"` - macOS 原生双击放大
- `trafficLightPosition: { x: 14, y: 20 }` - 交通灯居中
- `data-tauri-drag-region` - 拖拽区域标记

### 5. Session API (`src/server/`)

| 文件 | 用途 |
|------|------|
| `SessionStore.ts` | 会话 CRUD，文件持久化到 `.agent/` |
| `types/session.ts` | Session 类型定义 |
| `agent-session.ts` | 会话状态管理，包含 `resetSession()` |

### 6. IM Bot 多 Bot 架构 (`src-tauri/src/im/`)

**IM 层运行在 Rust 中**，通过 `SidecarOwner::ImBot` 复用 SidecarManager 获取 Bun Sidecar 进行 AI 对话。

```rust
/// 多 Bot 管理容器（Tauri State）
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;
```

| 组件 | 职责 |
|------|------|
| `TelegramAdapter` | Telegram Bot API 长轮询、消息收发、白名单、碎片合并 |
| `SessionRouter` | peer → Sidecar 映射，`SidecarOwner::ImBot(session_key)` 管理生命周期 |
| `HealthManager` | 每 5s 持久化状态到 `~/.myagents/im_{botId}_state.json` |
| `MessageBuffer` | Sidecar 不可用时缓冲消息，恢复后重放 |

**Tauri Commands**：`cmd_start_im_bot`、`cmd_stop_im_bot`、`cmd_im_bot_status`、`cmd_im_all_bots_status`、`cmd_im_conversations`

**前端**：`src/renderer/components/ImSettings/` — 列表页 / 创建向导 / 详情页，通过 `useConfig()` 的 `refreshConfig()` 同步 React 状态。

详见 [IM 集成技术架构](./im_integration_architecture.md)。

### 7. Session 切换场景 (v0.1.10)

| 场景 | 描述 | 行为 |
|------|------|------|
| **场景 1** | 新 Tab + 新 Session | 创建新 Sidecar |
| **场景 2** | 新 Tab + 其他 Tab 正在用的 Session | 跳转到已有 Tab |
| **场景 3** | 同 Tab 切换到定时任务 Session | 跳转/连接到 CronTask Sidecar |
| **场景 4** | 同 Tab 切换到无人使用的 Session | **Handover**：Sidecar 资源复用 |

**场景 4 详解（Handover 机制）**：
```
旧 Session A 的 Sidecar → 移交给 → 新 Session B
- HashMap key 从 session_a 改为 session_b
- Sidecar 进程不重启，资源复用
- 调用 POST /chat/switch-session 通知后端切换
```

## 通信流程

### SSE 流式事件
```
Tab1 listen('sse:tab1:*') ◄── Rust emit(sse:tab1:event) ◄── reqwest stream ◄── Sidecar:31415
Tab2 listen('sse:tab2:*') ◄── Rust emit(sse:tab2:event) ◄── reqwest stream ◄── Sidecar:31416
```

### HTTP API 调用
```
Tab1 apiPost() ──► getSessionPort(session_123) ──► Rust proxy ──► Sidecar:31415
Tab2 apiPost() ──► getSessionPort(session_456) ──► Rust proxy ──► Sidecar:31416
```

## 资源管理

| 事件 | 操作 |
|------|------|
| 打开/切换 Session | `ensureSessionSidecar(sessionId, workspace, ownerType, ownerId)` |
| 关闭 Tab | `releaseSessionSidecar(sessionId, 'tab', tabId)` |
| 定时任务启动 | `ensureSessionSidecar(sessionId, workspace, 'cron', taskId)` |
| 定时任务结束 | `releaseSessionSidecar(sessionId, 'cron', taskId)` |
| IM 消息到达 | `ensureSessionSidecar(sessionId, workspace, 'im_bot', sessionKey)` |
| IM Session 空闲超时 | `releaseSessionSidecar(sessionId, 'im_bot', sessionKey)` |
| IM Bot 停止 | 释放该 Bot 下所有 Session 的 ImBot Owner |
| 应用退出 | `stopAllSidecars()`，清理全部进程 |

**Owner 释放规则**：
- 当一个 Session 的所有 Owner（Tab + CronTask + ImBot + BackgroundCompletion）都释放后，Sidecar 才会停止
- 单个 Tab 关闭不会停止正在被定时任务或 IM Bot 使用的 Sidecar

## 安全设计

- **FS 权限**: 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证**: 阻止访问系统敏感目录
- **Tauri Capabilities**: 最小权限原则
- **本地绑定**: Sidecar 仅监听 `127.0.0.1`

## 跨平台工具模块 (`src/server/utils/platform.ts`)

统一的跨平台环境变量处理：

| 函数 | 用途 |
|------|------|
| `isWindows()` | 检测 Windows 平台 |
| `getCrossPlatformEnv()` | 获取 home/user/temp 目录 |
| `buildCrossPlatformEnv()` | 构建子进程环境变量 |
| `getHomeDirOrNull()` | 安全获取 home 目录 |

**环境变量映射**：

| 用途 | macOS/Linux | Windows |
|------|-------------|---------|
| Home 目录 | `HOME` | `USERPROFILE` |
| 用户名 | `USER` | `USERNAME` |
| 临时目录 | `TMPDIR` | `TEMP`/`TMP` |

`buildCrossPlatformEnv()` 自动设置双平台变量，确保子进程兼容：

```typescript
const env = buildCrossPlatformEnv({ MY_VAR: 'value' });
// 结果包含: HOME, USERPROFILE, USER, USERNAME, TMPDIR, TEMP, TMP, MY_VAR
```

## 开发脚本

### macOS

| 脚本 | 用途 |
|------|------|
| `setup.sh` | 首次环境初始化 |
| `start_dev.sh` | 浏览器开发模式 |
| `build_dev.sh` | Debug 构建 (含 DevTools) |
| `build_macos.sh` | 生产 DMG 构建 |

### Windows

| 脚本 | 用途 |
|------|------|
| `setup_windows.ps1` | 首次环境初始化 |
| `build_windows.ps1` | 生产构建 (NSIS + 便携版) |
| `publish_windows.ps1` | 发布到 R2 |

详见 [Windows 构建指南](../guides/windows_build_guide.md)。
