# Session ID 架构

## 概述

MyAgents 使用 Session ID 标识每次对话，用于消息存储、前端展示和 SDK 对话上下文恢复（resume）。本文档记录 Session ID 的演进历史和当前实现。

## 版本演进

### v0.1.0 ~ v0.1.10：双 ID 映射架构

早期版本维护两套独立的 Session ID：

| ID | 格式 | 生成方 | 用途 |
|----|------|--------|------|
| MyAgents sessionId | `session-{timestamp}-{random}` | `generateSessionId()` | 消息存储、前端展示、文件命名 |
| SDK sdkSessionId | SDK 内部生成的 UUID | Claude Agent SDK | 对话上下文恢复（resume） |

```
新 session 创建流程（旧）：
1. MyAgents 生成 sessionId = "session-1738800000-abc123"
2. 调用 query() 时不传 sessionId
3. SDK 内部生成 sdkSessionId = "213793e6-5bf8-..."
4. system-init 事件返回 session_id，存储为 sdkSessionId
5. Resume 时使用 sdkSessionId，存储时使用 sessionId
```

**问题**：需要维护两个 ID 的映射关系，增加了代码复杂度。

### v0.1.11+：统一 Session ID 架构

升级 Claude Agent SDK 到 0.2.33 后，`query()` 新增 `sessionId` 参数支持自定义会话 ID。利用此特性，新 session 创建时让 SDK 直接使用我们的 UUID，消除双 ID 映射。

| ID | 格式 | 生成方 | 用途 |
|----|------|--------|------|
| sessionId（统一） | UUID v4 | `crypto.randomUUID()` | 消息存储 + 前端展示 + SDK 上下文恢复 |

```
新 session 创建流程（新）：
1. MyAgents 生成 sessionId = randomUUID() → "7924d439-b04f-..."
2. 调用 query({ sessionId: "7924d439-b04f-..." })
3. SDK 使用我们的 UUID 作为其 session_id
4. system-init 返回 session_id === sessionId → 确认统一
5. Resume 时直接使用 sessionId
```

## 当前实现（v0.1.11）

### 核心数据结构

```typescript
interface SessionMetadata {
    id: string;                  // 会话 ID（v0.1.11+ 为 UUID）
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    sdkSessionId?: string;       // SDK session_id（统一后 === id）
    unifiedSession?: boolean;    // true = 统一架构创建的 session
    stats?: SessionStats;
    cronTaskId?: string;
}
```

### SDK `sessionId` 与 `resume` 互斥

SDK 约束：`sessionId` 和 `resume` 参数不能同时传递。

```typescript
querySession = query({
    prompt: messageGenerator(),
    options: {
        // 新 session：传 sessionId 让 SDK 使用我们的 UUID
        // Resume：传 resume 恢复对话上下文
        ...(resumeFrom
            ? { resume: resumeFrom }
            : { sessionId: sessionId }
        ),
        // ...
    }
});
```

### Session 切换 resume 逻辑

```typescript
// switchToSession() 中根据 session 类型决定 resume 策略
if (sessionMeta.unifiedSession && sessionMeta.sdkSessionId) {
    // 统一后的 session：sdkSessionId === id，直接用 id
    resumeSessionId = sessionMeta.id;
} else if (sessionMeta.sdkSessionId) {
    // 统一前的旧 session：用存储的 SDK ID
    resumeSessionId = sessionMeta.sdkSessionId;
} else {
    // 无 SDK ID 的老旧 session 或从未 query 过的 session
    resumeSessionId = undefined;
}
```

### 统一验证

system-init 事件中验证 SDK 是否确认使用了我们的 UUID：

```typescript
if (nextSystemInit.session_id) {
    const isUnified = nextSystemInit.session_id === sessionId;
    updateSessionMetadata(sessionId, {
        sdkSessionId: nextSystemInit.session_id,
        unifiedSession: isUnified,
    });
}
```

## 旧 Session 兼容

旧版本创建的 session 无 `unifiedSession` 标记，系统自动兼容：

| 场景 | `unifiedSession` | `sdkSessionId` | Resume 行为 |
|------|-------------------|----------------|-------------|
| v0.1.11+ 新 session | `true` | 等于 `id` | 使用 `id` |
| v0.1.10 及之前的 session | `undefined` | SDK 生成的 UUID | 使用 `sdkSessionId` |
| 从未 query 过的 session | `true`/`undefined` | `undefined` | 不 resume，重新开始 |

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/types/session.ts` | `SessionMetadata` 类型定义、`createSessionMetadata()` |
| `src/server/SessionStore.ts` | `updateSessionMetadata()` 持久化 |
| `src/server/agent-session.ts` | `query()` 调用、`switchToSession()`、system-init 处理 |

## 相关文档

- [Session 存储架构](./session_storage.md) — 存储格式、JSONL、文件锁
- [SSE 状态同步](./session_state_sync.md) — 前后端状态同步、新会话机制
