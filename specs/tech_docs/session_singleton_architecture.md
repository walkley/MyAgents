# Session 单例与 Sidecar 复用机制 - 技术架构设计

> **版本**: 0.1.10
> **状态**: 设计中
> **作者**: Claude (Code Review)
> **日期**: 2026-02-03

## 一、问题分析

### 1.1 当前架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Tab 1     │  │   Tab 2     │  │   Tab 3     │          │
│  │ session_123 │  │ session_456 │  │ session_123 │ ← 重复！  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
├─────────┼────────────────┼────────────────┼──────────────────┤
│         ▼                ▼                ▼     Rust Layer   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Sidecar A   │  │ Sidecar B   │  │ Sidecar C   │ ← 3个实例 │
│  │ :31415      │  │ :31416      │  │ :31417      │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

**问题**: Tab 1 和 Tab 3 都加载了 session_123，创建了两个独立的 Sidecar，导致：
- 状态不一致（两个 Sidecar 各自持有不同的消息历史）
- 资源浪费（重复进程）
- 定时任务执行混乱

### 1.2 当前代码结构

#### sidecar.rs
```rust
pub struct SidecarManager {
    /// Tab ID -> Sidecar Instance
    instances: HashMap<String, SidecarInstance>,  // 问题：按 Tab ID 管理
    port_counter: AtomicU16,
}
```

#### App.tsx - handleLaunchProject
```typescript
const handleLaunchProject = useCallback(async (project, _provider, sessionId) => {
    // 问题：直接启动新 Sidecar，没有检查 Session 是否已激活
    const status = await startTabSidecar(activeTabId, project.path);
    // ...
});
```

#### cron_task.rs - Scheduler
```rust
// 问题：通过 Tauri 事件触发，依赖前端接收
if let Err(e) = handle.emit("cron:trigger-execution", payload) {
    log::error!("[CronTask] Failed to emit trigger event");
}
```

### 1.3 需要解决的场景

| 场景 | 当前行为 | 期望行为 |
|------|---------|---------|
| 打开已在其他 Tab 打开的 Session | 创建新 Sidecar | 跳转到已有 Tab |
| 打开定时任务正在使用的 Session | 创建新 Sidecar | 连接到已有 Sidecar，新建 Tab |
| 定时任务恢复（应用重启） | 依赖前端事件 | Rust 直接调用 Sidecar |
| Tab 关闭 | 停止 Sidecar | 保留定时任务 Sidecar |

---

## 二、目标架构

### 2.1 核心原则

1. **Sidecar 是工作区级别的** - 一个工作区最多一个 Sidecar（保持不变）
2. **Session 激活状态是单例的** - 同一 Session 只能被一个 Sidecar 激活
3. **Tab 是 Sidecar 的视图** - Tab 可以连接/断开 Sidecar，但不拥有 Sidecar 生命周期
4. **Sidecar 可独立运行** - 定时任务场景下无需前端 Tab

### 2.2 新架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │   Tab 1     │  │   Tab 2     │     ← 视图层              │
│  │ session_123 │  │ session_456 │                           │
│  └──────┬──────┘  └──────┬──────┘                           │
│         │                │                                   │
├─────────┼────────────────┼───────────────────────────────────┤
│         │                │              Rust Layer           │
│         │                │                                   │
│   ┌─────┴────────────────┴─────┐   ┌─────────────────────┐  │
│   │     SidecarManager         │   │  SessionActivations │  │
│   │  (按工作区管理 Sidecar)     │   │  (Session 单例追踪)  │  │
│   └─────┬────────────────┬─────┘   └─────────────────────┘  │
│         │                │                                   │
│         ▼                ▼                                   │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │ Sidecar A   │  │ Sidecar B   │     ← Sidecar 层          │
│  │ Workspace1  │  │ Workspace2  │     (无 Tab 也可运行)     │
│  │ :31415      │  │ :31416      │                           │
│  └─────────────┘  └─────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 新增数据结构

```rust
// sidecar.rs

/// Session 激活记录
/// 追踪哪个 Session 被哪个 Sidecar 激活
#[derive(Debug, Clone, Serialize)]
pub struct SessionActivation {
    /// Session ID
    pub session_id: String,
    /// 关联的 Tab ID (None 表示无头运行，如定时任务)
    pub tab_id: Option<String>,
    /// Sidecar 端口
    pub port: u16,
    /// 工作区路径
    pub workspace_path: String,
    /// 是否是定时任务
    pub is_cron_task: bool,
}

/// Sidecar 运行模式
#[derive(Debug, Clone)]
pub enum SidecarMode {
    /// 前端 Tab 驱动
    Tab { tab_id: String },
    /// 无头运行（定时任务）
    Headless { task_id: String },
}

pub struct SidecarManager {
    /// 工作区路径 -> Sidecar Instance (改为按工作区管理)
    instances: HashMap<String, SidecarInstance>,

    /// Session ID -> Session Activation (新增)
    session_activations: HashMap<String, SessionActivation>,

    /// Tab ID -> 工作区路径 (映射 Tab 到工作区)
    tab_workspace_map: HashMap<String, String>,

    port_counter: AtomicU16,
}
```

---

## 三、详细设计

### 3.1 Rust 层 API 变更

#### 3.1.1 新增命令

```rust
/// 查询 Session 激活状态
#[tauri::command]
pub fn cmd_get_session_activation(session_id: String) -> Option<SessionActivation>;

/// 激活 Session（关联到 Sidecar）
#[tauri::command]
pub fn cmd_activate_session(
    session_id: String,
    tab_id: Option<String>,
    port: u16,
    workspace_path: String,
    is_cron_task: bool,
) -> Result<(), String>;

/// 取消激活 Session
#[tauri::command]
pub fn cmd_deactivate_session(session_id: String) -> Result<(), String>;

/// 查询工作区是否有运行中的 Sidecar
#[tauri::command]
pub fn cmd_get_workspace_sidecar(workspace_path: String) -> Option<SidecarInfo>;

/// 为定时任务启动无头 Sidecar
#[tauri::command]
pub async fn cmd_start_cron_sidecar(
    workspace_path: String,
    session_id: String,
    task_id: String,
) -> Result<u16, String>;

/// 直接在 Sidecar 上执行定时任务（Rust HTTP 调用）
#[tauri::command]
pub async fn cmd_execute_cron_task_on_sidecar(task_id: String) -> Result<(), String>;
```

#### 3.1.2 修改现有命令

```rust
/// 修改：启动 Tab Sidecar 时检查工作区是否已有 Sidecar
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    // 新增：检查工作区是否已有 Sidecar
    if let Some(ref dir) = agent_dir {
        let workspace_key = dir.to_string_lossy().to_string();
        if let Some(existing) = manager.get_workspace_sidecar(&workspace_key) {
            // 复用已有 Sidecar
            manager.map_tab_to_workspace(tab_id, &workspace_key);
            return Ok(existing.port);
        }
    }

    // 原有逻辑：启动新 Sidecar
    // ...
}

/// 修改：停止 Tab Sidecar 时检查是否还有其他使用者
pub fn stop_tab_sidecar(
    manager: &ManagedSidecarManager,
    tab_id: &str,
) -> Result<(), String> {
    let workspace = manager.get_tab_workspace(tab_id)?;
    manager.unmap_tab(tab_id);

    // 新增：检查工作区是否还有其他 Tab 或定时任务在使用
    if !manager.has_other_users(&workspace, tab_id) {
        // 没有其他使用者，停止 Sidecar
        manager.stop_workspace_sidecar(&workspace);
    }

    Ok(())
}
```

### 3.2 前端 API 变更

#### 3.2.1 新增 Tauri Client 函数

```typescript
// src/renderer/api/tauriClient.ts

/** 查询 Session 激活状态 */
export async function getSessionActivation(sessionId: string): Promise<SessionActivation | null>;

/** 激活 Session */
export async function activateSession(params: {
    sessionId: string;
    tabId: string | null;
    port: number;
    workspacePath: string;
    isCronTask: boolean;
}): Promise<void>;

/** 取消激活 Session */
export async function deactivateSession(sessionId: string): Promise<void>;

/** 查询工作区 Sidecar */
export async function getWorkspaceSidecar(workspacePath: string): Promise<SidecarInfo | null>;
```

#### 3.2.2 修改 App.tsx - handleLaunchProject

```typescript
const handleLaunchProject = useCallback(async (
    project: Project,
    _provider: Provider,
    sessionId?: string
) => {
    if (!activeTabId) return;

    // 新增：如果指定了 sessionId，检查是否已激活
    if (sessionId) {
        const activation = await getSessionActivation(sessionId);

        if (activation) {
            if (activation.tabId) {
                // Session 已在另一个 Tab 打开 -> 跳转
                setActiveTabId(activation.tabId);
                return;
            } else {
                // Session 被无头 Sidecar 使用（定时任务）-> 连接到已有 Sidecar
                await connectTabToSidecar(activeTabId, activation.port);
                await activateSession({
                    sessionId,
                    tabId: activeTabId,
                    port: activation.port,
                    workspacePath: activation.workspacePath,
                    isCronTask: false, // Tab 接管后不再是 cron 独占
                });

                setTabs(prev => prev.map(t =>
                    t.id === activeTabId
                        ? { ...t, agentDir: activation.workspacePath, sessionId, view: 'chat', title: getFolderName(activation.workspacePath) }
                        : t
                ));
                return;
            }
        }
    }

    // 原有逻辑：启动新 Sidecar
    setLoadingTabs(prev => ({ ...prev, [activeTabId]: true }));
    try {
        const port = await startTabSidecar(activeTabId, project.path);

        // 新增：激活 Session
        if (sessionId) {
            await activateSession({
                sessionId,
                tabId: activeTabId,
                port,
                workspacePath: project.path,
                isCronTask: false,
            });
        }

        // 更新 Tab 状态
        setTabs(prev => prev.map(t =>
            t.id === activeTabId
                ? { ...t, agentDir: project.path, sessionId: sessionId ?? null, view: 'chat', title: getFolderName(project.path) }
                : t
        ));
    } finally {
        setLoadingTabs(prev => ({ ...prev, [activeTabId]: false }));
    }
}, [activeTabId]);
```

#### 3.2.3 修改 SessionHistoryDropdown

```typescript
// src/renderer/components/SessionHistoryDropdown.tsx

const handleSelectSession = async (sessionId: string) => {
    // 新增：检查 Session 是否已激活
    const activation = await getSessionActivation(sessionId);

    if (activation?.tabId) {
        // 已在另一个 Tab 打开 -> 跳转到该 Tab
        // 通过自定义事件通知 App 切换 Tab
        window.dispatchEvent(new CustomEvent('myagents:focus-tab', {
            detail: { tabId: activation.tabId }
        }));
        onClose();
        return;
    }

    if (activation && !activation.tabId) {
        // 被无头 Sidecar 使用 -> 需要特殊处理
        // 通知 App 创建 Tab 并连接到已有 Sidecar
        window.dispatchEvent(new CustomEvent('myagents:connect-to-sidecar', {
            detail: {
                sessionId,
                port: activation.port,
                workspacePath: activation.workspacePath,
            }
        }));
        onClose();
        return;
    }

    // 正常流程：加载 Session
    onSelectSession(sessionId);
    onClose();
};
```

### 3.3 定时任务执行流程

#### 3.3.1 当前流程（有问题）

```
Rust Scheduler
    │
    ▼ emit("cron:trigger-execution")
Frontend (需要 Tab 接收)
    │
    ▼ API call
Sidecar /cron/execute
```

#### 3.3.2 新流程

```
Rust Scheduler
    │
    ├── 1. 检查 Sidecar 是否运行
    │       └── 否 → 启动无头 Sidecar
    │
    ▼ 2. HTTP POST to Sidecar
Sidecar /cron/execute
    │
    ▼ 3. 执行完成后
Rust 记录执行结果
    │
    ▼ 4. 发送系统通知
```

#### 3.3.3 Rust 实现

```rust
// cron_task.rs

impl CronTaskManager {
    /// 直接执行定时任务（不依赖前端）
    pub async fn execute_task_directly(&self, task_id: &str) -> Result<(), String> {
        let task = self.get_task(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        // 1. 确保 Sidecar 运行
        let port = self.ensure_sidecar_running(&task).await?;

        // 2. 检查重叠执行
        if self.is_task_executing(task_id).await {
            log::warn!("[CronTask] Task {} is still executing, skipping", task_id);
            return Ok(());
        }

        // 3. 标记开始执行
        self.mark_task_executing(task_id).await;

        // 4. 构建请求
        let payload = CronExecuteRequest {
            task_id: task_id.to_string(),
            prompt: task.prompt.clone(),
            is_first_execution: task.execution_count == 0,
            ai_can_exit: task.end_conditions.ai_can_exit,
            run_mode: task.run_mode.clone(),
        };

        // 5. HTTP 调用 Sidecar
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/cron/execute", port);

        let response = client
            .post(&url)
            .json(&payload)
            .timeout(Duration::from_secs(600)) // 10 分钟超时
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        // 6. 处理响应
        if response.status().is_success() {
            let result: CronExecuteResult = response.json().await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            // 7. 记录执行
            self.record_execution(task_id).await?;

            // 8. 检查 AI 退出
            if result.ai_requested_exit {
                self.complete_task(task_id, result.exit_reason).await?;
            }

            // 9. 发送通知
            if task.notify_enabled {
                self.send_notification(&task, &result).await;
            }
        }

        // 10. 标记完成
        self.mark_task_complete(task_id).await;

        Ok(())
    }

    /// 确保任务的 Sidecar 正在运行
    async fn ensure_sidecar_running(&self, task: &CronTask) -> Result<u16, String> {
        // 检查是否已有 Sidecar
        let sidecar_manager = get_sidecar_manager();

        if let Some(info) = sidecar_manager.get_workspace_sidecar(&task.workspace_path) {
            return Ok(info.port);
        }

        // 启动无头 Sidecar
        let port = sidecar_manager.start_cron_sidecar(
            &task.workspace_path,
            &task.session_id,
            &task.id,
        ).await?;

        // 激活 Session
        sidecar_manager.activate_session(
            &task.session_id,
            None, // 无 Tab
            port,
            &task.workspace_path,
            true, // 是定时任务
        )?;

        Ok(port)
    }
}
```

### 3.4 Bun Sidecar 变更

#### 3.4.1 新增端点

```typescript
// src/server/index.ts

// 定时任务执行端点（供 Rust 直接调用）
app.post('/cron/execute', async (c) => {
    const { task_id, prompt, is_first_execution, ai_can_exit, run_mode } = await c.req.json();

    // 执行任务
    const result = await cronExecutor.execute({
        taskId: task_id,
        prompt,
        isFirstExecution: is_first_execution,
        aiCanExit: ai_can_exit,
        runMode: run_mode,
    });

    return c.json(result);
});
```

---

## 四、实施计划

### Phase 1: Rust 层基础设施

1. **修改 SidecarManager 数据结构**
   - 添加 `session_activations` HashMap
   - 添加 `tab_workspace_map` HashMap
   - 修改 `instances` 的 key 从 Tab ID 改为工作区路径

2. **添加 Session 激活命令**
   - `cmd_get_session_activation`
   - `cmd_activate_session`
   - `cmd_deactivate_session`

3. **修改现有 Sidecar 命令**
   - `start_tab_sidecar` 支持复用
   - `stop_tab_sidecar` 检查其他使用者

### Phase 2: 定时任务直接执行

1. **修改 CronTaskManager**
   - 实现 `execute_task_directly` 方法
   - 实现 `ensure_sidecar_running` 方法
   - 移除对 Tauri 事件的依赖

2. **修改 Scheduler 循环**
   - 调用 `execute_task_directly` 而非 `emit`

3. **添加 Sidecar 端点**
   - `/cron/execute` 端点
   - 支持无 SSE 连接执行

### Phase 3: 前端 Session 检查

1. **添加 Tauri Client 函数**
   - `getSessionActivation`
   - `activateSession`
   - `deactivateSession`

2. **修改 App.tsx**
   - `handleLaunchProject` 检查 Session 激活
   - 添加 Tab 跳转逻辑
   - 添加连接已有 Sidecar 逻辑

3. **修改 SessionHistoryDropdown**
   - 打开前检查 Session 激活状态
   - 实现跳转和连接逻辑

### Phase 4: 清理与测试

1. **TabProvider unmount 处理**
   - 取消 Session 激活
   - 检查 Sidecar 是否应停止

2. **边界情况处理**
   - 应用重启时的 Session 激活恢复
   - Sidecar 意外退出的清理
   - 网络错误重试

3. **全面测试**
   - 单元测试
   - 集成测试
   - 手动场景测试

---

## 五、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Session 激活状态不一致 | 可能导致重复 Sidecar | 应用启动时清理过期激活记录 |
| Sidecar 意外退出 | 激活记录残留 | 定期健康检查，清理无效记录 |
| HTTP 调用超时 | 定时任务执行失败 | 10 分钟超时 + 重试机制 |
| 并发修改激活状态 | 竞态条件 | Mutex 保护 + 原子操作 |

---

## 六、验证清单

- [ ] 打开已在其他 Tab 打开的 Session → 跳转到已有 Tab
- [ ] 打开定时任务正在使用的 Session → 新建 Tab 连接到已有 Sidecar
- [ ] 关闭 Tab（有其他使用者）→ Sidecar 继续运行
- [ ] 关闭 Tab（无其他使用者）→ Sidecar 停止
- [ ] 定时任务执行（无 Tab）→ Rust 直接 HTTP 调用
- [ ] 应用重启 → 定时任务自动恢复，无需前端参与
- [ ] 定时任务执行完成 → 系统通知正常发送
- [ ] 点击通知 → 打开 App，新建 Tab 连接到 Sidecar
