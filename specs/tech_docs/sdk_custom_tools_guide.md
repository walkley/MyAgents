# Claude Agent SDK Custom Tools Guide

> 技术文档：如何在 MyAgents 中使用 Claude Agent SDK 创建自定义 MCP 工具

## 概述

Claude Agent SDK 提供了 `createSdkMcpServer` 和 `tool` 函数，允许开发者创建内置的 MCP（Model Context Protocol）服务器，为 AI Agent 提供自定义工具能力。与外部 MCP 服务器不同，这些工具直接在应用进程内运行，无需启动额外的子进程。

## 核心 API

### 1. createSdkMcpServer

创建一个内置的 MCP 服务器实例。

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const myServer = createSdkMcpServer({
  name: 'my-tools',          // 服务器名称（用于工具命名）
  version: '1.0.0',          // 版本号
  tools: [                   // 工具定义数组
    // ... tool() 定义
  ]
});
```

### 2. tool() 函数

定义单个工具的 helper 函数，提供类型安全的参数验证。

```typescript
import { z } from 'zod/v4';  // 必须使用 zod/v4

tool(
  'tool_name',               // 工具名称（snake_case）
  'Tool description',        // 工具描述（告诉 AI 何时使用）
  {                          // Zod schema 定义输入参数
    param1: z.string().describe('参数说明'),
    param2: z.number().optional()
  },
  async (args) => {          // 工具处理函数
    // args 的类型由 schema 推断
    return {
      content: [{
        type: 'text',
        text: '工具执行结果'
      }]
    };
  }
)
```

## 工具返回格式

工具处理函数必须返回符合 MCP `CallToolResult` 格式的对象：

```typescript
type CallToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;  // 可选：标记为错误响应
};
```

### 成功响应示例

```typescript
return {
  content: [{
    type: 'text',
    text: '操作成功完成'
  }]
};
```

### 错误响应示例

```typescript
return {
  content: [{
    type: 'text',
    text: 'Error: 操作失败的原因'
  }],
  isError: true
};
```

## 工具命名约定

当工具注册到 SDK 后，其完整名称遵循以下格式：

```
mcp__{server-name}__{tool-name}
```

例如：
- 服务器名：`cron-tools`
- 工具名：`exit_cron_task`
- 完整名称：`mcp__cron-tools__exit_cron_task`

这个命名格式用于：
- `allowedTools` 配置
- `canUseTool` 回调中的工具名判断
- 日志和调试

## 集成到 Agent Session

### 1. 创建工具服务器文件

在 `src/server/tools/` 目录下创建工具定义文件：

```typescript
// src/server/tools/my-tools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

export const myToolsServer = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [
    tool(
      'my_action',
      '执行自定义操作',
      { input: z.string() },
      async (args) => {
        // 实现逻辑
        return { content: [{ type: 'text', text: `处理: ${args.input}` }] };
      }
    )
  ]
});
```

### 2. 在 agent-session.ts 中注册

```typescript
// agent-session.ts
import { myToolsServer } from './tools/my-tools';

function buildSdkMcpServers(): Record<string, SdkMcpServerConfig | typeof myToolsServer> {
  const result: Record<string, SdkMcpServerConfig | typeof myToolsServer> = {};

  // 条件性添加工具服务器
  if (shouldEnableMyTools) {
    result['my-tools'] = myToolsServer;
  }

  // 其他 MCP 服务器配置...

  return result;
}
```

### 3. 传递给 query() 函数

```typescript
querySession = query({
  prompt: messageGenerator(),
  options: {
    mcpServers: buildSdkMcpServers(),
    // 其他选项...
  }
});
```

## 实际案例：exit_cron_task 工具

以下是 MyAgents 中 `exit_cron_task` 工具的完整实现：

```typescript
// src/server/tools/cron-tools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { broadcast } from '../sse';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// 模块级状态：跟踪当前执行的 cron 任务
let currentCronTaskId: string | null = null;
let currentCronTaskCanExit: boolean = false;

// 上下文设置函数（由外部调用）
export function setCronTaskContext(taskId: string | null, canExit: boolean): void {
  currentCronTaskId = taskId;
  currentCronTaskCanExit = canExit;
}

export function clearCronTaskContext(): void {
  currentCronTaskId = null;
  currentCronTaskCanExit = false;
}

// 工具处理函数
async function exitCronTaskHandler(args: { reason: string }): Promise<CallToolResult> {
  // 验证上下文
  if (!currentCronTaskId) {
    return {
      content: [{ type: 'text', text: 'Error: 只能在定时任务执行期间调用此工具' }],
      isError: true
    };
  }

  if (!currentCronTaskCanExit) {
    return {
      content: [{ type: 'text', text: 'Error: 此任务不允许 AI 自主退出' }],
      isError: true
    };
  }

  // 广播事件给前端处理
  broadcast('cron:task-exit-requested', {
    taskId: currentCronTaskId,
    reason: args.reason,
    timestamp: new Date().toISOString()
  });

  return {
    content: [{
      type: 'text',
      text: `定时任务退出请求已提交。原因: ${args.reason}`
    }]
  };
}

// 创建并导出服务器
export const cronToolsServer = createSdkMcpServer({
  name: 'cron-tools',
  version: '1.0.0',
  tools: [
    tool(
      'exit_cron_task',
      `结束当前定时任务。当任务目标已完成或继续执行无意义时调用。
仅在定时任务执行期间且任务允许 AI 退出时可用。`,
      {
        reason: z.string()
          .min(1)
          .max(500)
          .describe('结束任务的原因，将显示给用户')
      },
      exitCronTaskHandler
    )
  ]
});
```

## 工具权限控制

### 使用 canUseTool 回调

可以通过 `canUseTool` 回调精细控制工具权限：

```typescript
canUseTool: async (toolName, input, options) => {
  // 检查是否是 MCP 工具
  if (toolName.startsWith('mcp__')) {
    // 提取服务器名和工具名
    const parts = toolName.split('__');
    const serverName = parts[1];
    const actualToolName = parts[2];

    // 自定义权限逻辑
    if (serverName === 'my-tools' && !isFeatureEnabled) {
      return { behavior: 'deny', message: '功能未启用' };
    }
  }

  return { behavior: 'allow', updatedInput: input };
}
```

### 使用 allowedTools 配置

在 query options 中指定允许的工具：

```typescript
query({
  options: {
    allowedTools: [
      'mcp__cron-tools__exit_cron_task',  // 允许特定工具
      'mcp__my-tools__*',                  // 允许服务器下所有工具
    ]
  }
});
```

## 最佳实践

### 1. 工具描述要清晰

工具描述是 AI 决定是否使用该工具的关键信息：

```typescript
tool(
  'my_tool',
  `简明扼要的功能描述。

何时使用此工具：
1. 场景一
2. 场景二

注意事项：
- 限制条件
- 前置要求`,
  // ...
)
```

### 2. 参数验证要严格

使用 Zod 的验证能力确保输入合法：

```typescript
{
  url: z.string().url().describe('必须是有效的 URL'),
  count: z.number().int().min(1).max(100),
  mode: z.enum(['fast', 'slow']).default('fast')
}
```

### 3. 错误处理要友好

```typescript
async (args) => {
  try {
    const result = await doSomething(args);
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return {
      content: [{ type: 'text', text: `操作失败: ${message}` }],
      isError: true
    };
  }
}
```

### 4. 状态管理要安全

如果工具需要访问外部状态，使用模块级变量或注入依赖：

```typescript
// 模块级状态
let state: SomeState | null = null;

export function setState(newState: SomeState) {
  state = newState;
}

// 工具内使用
async (args) => {
  if (!state) {
    return { content: [{ type: 'text', text: 'Error: 状态未初始化' }], isError: true };
  }
  // 使用 state...
}
```

## 调试技巧

1. **查看工具注册日志**：在 `buildSdkMcpServers` 中添加日志
2. **检查工具调用**：在 `canUseTool` 回调中记录工具调用
3. **验证参数**：在工具处理函数开头记录收到的参数
4. **SSE 事件跟踪**：监听 `chat:tool-use` 事件查看工具调用详情

## 相关文档

- [Claude Agent SDK 官方文档](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [MCP 协议规范](https://modelcontextprotocol.io)
- [Zod v4 文档](https://zod.dev)
