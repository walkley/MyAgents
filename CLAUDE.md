# MyAgents - Desktop AI Agent

> **开源项目** | 仓库地址：https://github.com/hAcKlyc/MyAgents | License: Apache-2.0
>
> 作为开源项目，请遵循以下规范：
> - **代码质量**：保持代码可读性，添加必要注释，遵循项目既有风格
> - **提交规范**：使用 Conventional Commits，提交信息清晰描述变更
> - **安全意识**：不提交敏感信息（API Key、密码），不引入已知漏洞的依赖
> - **文档同步**：重要功能变更需同步更新相关文档
> - **向后兼容**：破坏性变更需谨慎，考虑用户升级路径

## 产品定位

MyAgents 是一款基于 Claude Agent SDK 开发的**桌面端通用 Agent 产品**，目标是让非开发者也能使用强大的 AI Agent 能力。核心差异化：图形界面零门槛、多标签页并行工作、多模型供应商可选、数据本地存储保护隐私、开源免费。

## 核心架构

**多实例 Sidecar 架构**：每个 Chat Tab 拥有独立的 Bun Sidecar 进程，Settings/Launcher 使用 Global Sidecar。

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
├──────────────────────────────────────────────────────────────┤
│                        React Frontend                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Chat 1    │  │   Chat 2    │  │  Settings   │          │
│  │ TabProvider │  │ TabProvider │  │  Launcher   │          │
│  │ Tab Sidecar │  │ Tab Sidecar │  │ Global API  │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
├─────────┼────────────────┼────────────────┼──────────────────┤
│         ▼                ▼                ▼     Rust Layer   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Tab Sidecar │  │ Tab Sidecar │  │   Global    │          │
│  │ :31415      │  │ :31416      │  │  Sidecar    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Bun + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest) |
| 运行时 | Bun 内置于应用包（用户无需安装 Bun 或 Node.js） |

## 项目结构

```
myagents/
├── src/
│   ├── renderer/          # React 前端
│   │   ├── api/           # SSE/HTTP 客户端 (多实例)
│   │   ├── context/       # Tab 状态管理
│   │   ├── hooks/         # 自定义 Hooks
│   │   ├── components/    # UI 组件
│   │   └── pages/         # 页面组件
│   ├── server/            # Bun 后端 (Sidecar)
│   └── shared/            # 前后端共享代码
├── src-tauri/             # Tauri Rust 代码
├── specs/                 # 设计文档
│   ├── prd/               # 产品需求文档 (功能规划、需求说明) **本地维护不提交 Git**
│   ├── tech_docs/         # 技术文档 (架构、集成、存储等深度技术说明)
│   ├── guides/            # 操作指南 (构建、发布、签名等实操流程)
│   └── research/          # 技术调研文档
└── .agent/                # Agent 配置
```

## 开发命令

```bash
bun install                 # 依赖安装
./start_dev.sh              # 浏览器开发模式 (快速迭代)
npm run tauri:dev           # Tauri 开发模式 (完整桌面体验)
./build_dev.sh              # Debug 构建 (含 DevTools)
./build_macos.sh            # 生产构建
./publish_release.sh        # 发布到 R2
npm run typecheck && npm run lint  # 代码质量检查
```

---

## 核心原则

### 1. Tab-scoped 隔离

每个 Tab 拥有独立的 Sidecar 进程，API 调用必须发送到正确的 Sidecar。

```typescript
// ✅ Tab 内：使用 Tab-scoped API
const { apiGet, apiPost } = useTabState();
await apiPost('/api/mcp/set', { servers });

// ❌ 错误：Tab 内使用全局 API
import { apiPostJson } from '@/api/apiFetch';
await apiPostJson('/api/mcp/set', { servers }); // 会发到 Global Sidecar！
```

### 2. Rust 代理层

所有 HTTP/SSE 流量必须通过 Rust 代理层，**禁止**直接从 WebView 发起 HTTP 请求：

```
前端 ──(invoke)──> Rust Proxy ──(reqwest)──> Bun Sidecar
```

### 3. 零外部依赖

应用内置 Bun 运行时，**不依赖用户系统的 Node.js/npm/npx**：

```typescript
// ✅ 使用内置 bun
import { getBundledRuntimePath } from './utils/runtime';

// ❌ 依赖系统 npm/npx
spawn('npm', ['install', pkg]);
```

### 4. Session 上下文保持 + 持久 Session

配置变更（Provider/Model/MCP）时必须保持对话上下文，只有用户点击「新对话」才创建全新 session。

**持久 Session 架构**（v0.1.18+）：`messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活。所有中止场景必须使用 `abortPersistentSession()` 统一中止（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess）。

```typescript
// ✅ 配置变更时：统一中止 + 设置 resume
if (configChanged) {
    resumeSessionId = systemInitInfo?.session_id;
    abortPersistentSession();  // 唤醒 waitForMessage/waitForTurnComplete + interrupt
}

// ❌ 直接设置标志，generator 的 Promise 门控无法退出
shouldAbortSession = true;  // generator 永远阻塞在 waitForMessage()！

// ❌ 配置变更直接重启，AI 会"失忆"
abortPersistentSession();  // 没有 resumeSessionId！
```

**`abortPersistentSession()` 必须用于所有中止场景**：`setMcpServers`、`setAgents`、`resetSession`、`switchToSession`、`enqueueUserMessage` provider change、`rewindSession`。

### 5. Tab 初始化与 Pre-warm

Tab Sidecar 启动后，前端按固定顺序同步配置，最后一步的 MCP/Agents 同步触发 `schedulePreWarm()`（500ms 防抖），在用户发送第一条消息前预热 SDK 子进程和 MCP 服务器：

```
Tab 创建 → Sidecar 启动 → Model 同步(/api/model/set)
                          → Provider 同步(/api/mcp/set, /api/agents/set)
                          → schedulePreWarm() [500ms debounce]
                          → SDK subprocess + MCP 预热完成
                          → 用户发消息，直接使用已预热的 session
```

注意事项：
- **Model 同步不触发 pre-warm**（模型变更无需重启 session），MCP/Agents 变更才触发
- **新增配置同步端点时**，确保 `currentXxx` 变量在 pre-warm 前已设置，否则 `applySessionConfig` 会在首消息时执行阻塞操作
- Pre-warm 失败通过 `preWarmStartedOk` 标志统一管理，abort 不计入失败次数
- **持久 Session 中 pre-warm 就是最终 session**：用户消息通过 `wakeGenerator()` 直接注入，不会再次调用 `startStreamingSession()`。任何使用 `!preWarm` 条件守卫的逻辑都可能导致该逻辑在持久模式下永远不执行

---

## React 稳定性规范

> **核心原则**：React 重新渲染时，对象/函数引用会改变。依赖这些引用的 useEffect 会重新执行，可能触发 API 调用、文件访问等副作用。

### 规则 1：Context Provider 必须 useMemo

Provider value 必须使用 `useMemo` 包装，否则每次渲染都会创建新对象，导致所有消费者重新渲染。

```typescript
// ✅ 正确
const contextValue = useMemo(() => ({
    showToast, success, error, warning, info
}), [showToast, success, error, warning, info]);

return <ToastContext.Provider value={contextValue}>{children}</ToastContext.Provider>;

// ❌ 错误：对象字面量每次渲染都是新引用
return <ToastContext.Provider value={{ showToast, success, error }}>{children}</ToastContext.Provider>;
```

### 规则 2：useEffect 依赖数组规范

**禁止**将以下内容放入依赖数组（除非确实需要响应其变化）：

| 禁止依赖 | 原因 | 替代方案 |
|----------|------|----------|
| `toast` hook 返回值 | 可能不稳定 | 在 effect 内部调用，不加依赖 |
| `api` 对象 | 依赖 Provider 稳定性 | 使用 `useRef` 缓存 |
| inline callback | 每次渲染新引用 | `useCallback` 或 `useRef` |
| 对象/数组字面量 | 每次渲染新引用 | `useMemo` 包装 |

```typescript
// ✅ 正确：稳定依赖
useEffect(() => {
    loadData();
}, [id]);  // 只依赖原始值

// ❌ 错误：不稳定依赖导致无限循环
useEffect(() => {
    loadData();
}, [id, toast, api, { config }]);  // toast/api/对象字面量都不稳定
```

### 规则 3：跨组件回调稳定化

父组件传递给子组件的回调，若在子组件 useEffect 中使用，必须稳定化：

```typescript
// 子组件内部
const onChangeRef = useRef(onChange);
onChangeRef.current = onChange;  // 每次渲染更新

useEffect(() => {
    onChangeRef.current?.(value);  // 使用 ref 调用
}, [value]);  // 不依赖 onChange
```

### 规则 4：定时器必须清理

```typescript
const timeoutRef = useRef<NodeJS.Timeout>();

useEffect(() => {
    timeoutRef.current = setTimeout(doSomething, 1000);
    return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
}, []);
```

### 规则 5：memo + ref 稳定化模式（渲染列表优化）

当父组件用 `state.map()` 渲染子组件列表时，state 变化会重渲染所有子组件。若子组件很重（如 Chat），需用 `memo` + ref 稳定化回调实现精准重渲染：

**三步范式**：

```typescript
// Step 1: Ref 同步——回调通过 ref 读取最新 state，依赖数组为空
const stateRef = useRef(state);
stateRef.current = state;

const stableCallback = useCallback(() => {
    // 使用 stateRef.current 而非 state
    const item = stateRef.current.find(...);
}, []);  // 永远稳定

// Step 2: memo 子组件——自定义 comparator 只比较数据 props（回调已稳定，无需比较）
const MemoChild = memo(function Child(props) { ... }, (prev, next) => {
    return prev.data === next.data && prev.isActive === next.isActive;
    // 回调 props 不比较，因为已通过 Step 1 保证稳定
});

// Step 3: 仅传递与该子组件相关的数据 props（避免无关 prop 变化触发重渲染）
{items.map(item => (
    <MemoChild
        key={item.id}
        data={item}
        isActive={item.id === activeId}
        // ✅ 只传给 settings 子组件才需要的 prop
        settingsProp={item.type === 'settings' ? settingValue : undefined}
        onAction={stableCallback}  // 引用永远不变
    />
))}
```

**关键约束**：
- 自定义 comparator 跳过回调检查的前提是 **所有回调 props 确实稳定**（`[]` 依赖）。若某个回调依赖了不稳定值（如来自 hook 的函数），必须用 ref 包一层
- `setTabs(prev => prev.map(...))` 会保留未变更 item 的对象引用，使 `prev.data === next.data` 生效
- 仅影响特定子组件类型的 prop，用条件表达式限制传递范围

---

## Config 持久化规范

> **核心原则**：`AppConfig` 同时存在于磁盘（config.json）和 React 状态（`useConfig` 的 `config` state）中。两者可能不同步，写入时必须以磁盘为准。

### 为什么会不同步

`useConfig` 中部分写入函数（如 `saveApiKey`）通过 `configService` 直接读盘→改→写盘，并更新各自的 React 状态（`setApiKeys`），但**不更新 `config` React 状态**。导致 `config` 中的 `providerApiKeys` 等字段过期。

### 规则：写入前必须从磁盘加载

```typescript
// ✅ 正确：从磁盘读最新配置再合并
const savePresetCustomModels = useCallback(async (providerId, models) => {
    const latestConfig = await loadAppConfig(); // 磁盘最新
    const newConfig = { ...latestConfig, presetCustomModels: { ... } };
    setConfig(newConfig);
    await saveAppConfig(newConfig);
}, []); // 无需依赖 config

// ❌ 错误：使用 React config 状态（可能已过期，覆盖其他字段）
const savePresetCustomModels = useCallback(async (providerId, models) => {
    const newConfig = { ...config, presetCustomModels: { ... } };
    await saveAppConfig(newConfig); // config.providerApiKeys 可能是旧的！
}, [config]);
```

适用范围：`useConfig.ts` 中所有读取 `config` 状态并调用 `saveAppConfig` 的函数。`configService.ts` 层的函数已遵循此模式。

---

## 禁止事项速查表

| 禁止 | 原因 | 正确做法 |
|------|------|----------|
| 直接 fetch 请求 | WebView CORS 限制 | `proxyFetch()` |
| 全局 API 访问 Tab 资源 | 访问错误 Sidecar | `useTabState()` |
| Context value 不用 useMemo | 消费者无限重渲染 | `useMemo` 包装 |
| useEffect 依赖 hook 返回值 | 引用不稳定致循环 | `useRef` 或移除依赖 |
| useEffect 依赖 inline callback | 无限循环 | `useRef` 稳定 |
| memo comparator 跳过回调检查但回调不稳定 | 子组件静默使用过期回调 | 确保所有回调 `[]` 依赖，不稳定源用 ref 包一层 |
| 不清理定时器 | 内存泄漏 | cleanup 函数 |
| 依赖 npm/npx/Node.js | 用户可能未安装 | 内置 bun |
| 配置变更不 resume session | AI 失忆 | 先设 `resumeSessionId` |
| 直接设置 `shouldAbortSession = true` | generator Promise 门控无法退出 | `abortPersistentSession()` |
| pre-warm 中使用 `!preWarm` 条件守卫 | 持久 Session 下 pre-warm 就是最终 session | 移除 `!preWarm` 守卫或改用其他条件 |
| `useConfig` 写盘用 React `config` 状态 | 覆盖其他字段（如 API Key） | `await loadAppConfig()` 从磁盘读 |
| 新增配置同步不考虑 pre-warm | 首消息阻塞延迟 | 确保变量在 pre-warm 前设置 |
| 提交前不 typecheck | CI 失败 | `npm run typecheck` |
| 提交前不检查分支 | 误提交到错误分支 | `git branch --show-current` |
| 在 main 分支直接提交 | 破坏主分支稳定性 | 切换到 dev 分支 |
| 未经确认合并到 main | 绕过测试流程 | 先询问用户确认 |

---

## 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| React 组件 | PascalCase | `CustomTitleBar.tsx` |
| Hook | camelCase + use 前缀 | `useUpdater.ts` |
| Context | PascalCase + Context 后缀 | `TabContext.tsx` |
| Rust 模块 | snake_case | `sse_proxy.rs` |

---

## 错误处理 & 日志

**Rust 侧**：
```rust
fn some_command() -> Result<Data, String> {
    do_something().map_err(|e| format!("[模块名] 操作失败: {}", e))?;
    Ok(data)
}
```

**TypeScript 侧**：
```typescript
try {
    await apiPost('/api/action', data);
} catch (err) {
    console.error('[module] Action failed:', err);
    toast.error('操作失败，请重试');
}
```

**调试日志**：
```typescript
import { isDebugMode } from '@/utils/debug';
if (isDebugMode()) console.log('[module] debug message');
```

---

## Git 分支管理规范

> **核心原则**：提交前检查分支、dev 开发 main 禁提、合并需用户确认。

### 强制检查流程

**每次 `git commit` 前必须先执行查看当前分支，确保当前分支处于开发分支内**：
- `dev/*` 开发分支：正常提交（按 feature/fix 粒度）
- `main` 主分支：**禁止直接提交**，必须通过合并
- 如果无本需求相关的分支存在，则新建分支

### 合并到 main

**必须同时满足**：
1. dev 分支已充分测试
2. `npm run typecheck && npm run lint` 通过
3. **用户明确要求 或 AI询问后明确确认** 


---

## 工作流规范

1. **提交前**：`npm run typecheck`
2. **Commit 格式**：Conventional Commits (`feat:`, `fix:`, `refactor:`)
3. **分支策略**：功能分支 `dev/x.x.x` → 合并到 `main`
4. **版本管理**：`npm version patch/minor/major` 自动同步所有配置
5. **发布流程**：`npm version` → `./build_macos.sh` → `./publish_release.sh` → push tag
6. **版本发布**：发布前**先更新 [CHANGELOG.md](./CHANGELOG.md)，再打 tag**，tag message 从 CHANGELOG.md 复制

---

## 常见问题

| 问题 | 排查方向 |
|------|----------|
| Tab 切换后功能异常 | 检查是否用了全局 API 而非 Tab-scoped API |
| SSE 事件未收到 | 确认连接状态、事件名格式 `sse:${tabId}:${event}` |
| useEffect 频繁触发 | 检查依赖数组是否有不稳定引用 |
| 保存文件弹权限框 | Context 不稳定导致 loadData 重复执行 |
| 新对话后旧消息重现 | 使用 `resetSession()` 而非直接清理状态 |

---

## 文档索引

| 场景 | 文档 |
|------|------|
| **版本发布记录** | [CHANGELOG.md](./CHANGELOG.md) |
| 整体架构、数据流 | [architecture.md](./specs/tech_docs/architecture.md) |
| 集成新 LLM 供应商 | [third_party_providers.md](./specs/tech_docs/third_party_providers.md) |
| Bun Sidecar 打包机制 | [bundled_bun.md](./specs/tech_docs/bundled_bun.md) |
| 自动更新、CI/CD | [auto_update.md](./specs/tech_docs/auto_update.md) |
| 工具权限控制 | [sdk_canUseTool_guide.md](./specs/tech_docs/sdk_canUseTool_guide.md) |
| **SDK 自定义工具** | [sdk_custom_tools_guide.md](./specs/tech_docs/sdk_custom_tools_guide.md) |
| SSE 状态同步 | [session_state_sync.md](./specs/tech_docs/session_state_sync.md) |
| Session 存储架构 | [session_storage.md](./specs/tech_docs/session_storage.md) |
| **Session ID 架构** | [session_id_architecture.md](./specs/tech_docs/session_id_architecture.md) |
| 日志系统 | [unified_logging.md](./specs/tech_docs/unified_logging.md) |
| **代理配置** | [proxy_config.md](./specs/tech_docs/proxy_config.md) |
| **Windows 平台适配** | [windows_platform_guide.md](./specs/tech_docs/windows_platform_guide.md) |
| **构建问题排查** | [build_troubleshooting.md](./specs/tech_docs/build_troubleshooting.md) |
| UI/设计规范 | [design_guide.md](./specs/guides/design_guide.md) |
| macOS 签名、公证 | [macos_distribution_guide.md](./specs/guides/macos_distribution_guide.md) |
| macOS 构建、发布 | [build_and_release_guide.md](./specs/guides/build_and_release_guide.md) |
| **Windows 构建、发布** | [windows_build_guide.md](./specs/guides/windows_build_guide.md) |
