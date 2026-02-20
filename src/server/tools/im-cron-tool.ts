// IM Bot Cron Tool — AI-driven scheduled task management for IM Bots
// Uses Rust Management API (via MYAGENTS_MANAGEMENT_PORT) for cron task CRUD

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== IM Cron Context =====

interface ImCronContext {
  botId: string;
  chatId: string;
  platform: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  providerEnv?: { baseUrl?: string; apiKey?: string };
}

let imCronContext: ImCronContext | null = null;

export function setImCronContext(ctx: ImCronContext): void {
  imCronContext = ctx;
  console.log(`[im-cron] Context set: botId=${ctx.botId}, chatId=${ctx.chatId}`);
}

export function clearImCronContext(): void {
  imCronContext = null;
  console.log('[im-cron] Context cleared');
}

export function getImCronContext(): ImCronContext | null {
  return imCronContext;
}

// ===== Management API client =====

const MANAGEMENT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;

async function managementApi(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  if (!MANAGEMENT_PORT) {
    throw new Error('MYAGENTS_MANAGEMENT_PORT not set — management API unavailable');
  }

  const url = `http://127.0.0.1:${MANAGEMENT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  return resp.json();
}

// ===== Tool handler =====

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('at'),
    at: z.string().describe('ISO-8601 datetime for one-shot execution, e.g. "2024-12-01T14:30:00+08:00"'),
  }),
  z.object({
    kind: z.literal('every'),
    minutes: z.number().min(5).describe('Interval in minutes (minimum 5)'),
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z.string().describe('Cron expression, e.g. "0 9 * * *" for daily 9 AM'),
    tz: z.string().optional().describe('IANA timezone, e.g. "Asia/Shanghai"'),
  }),
]);

async function imCronToolHandler(args: {
  action: 'list' | 'add' | 'update' | 'remove' | 'run';
  job?: {
    name?: string;
    schedule: z.infer<typeof scheduleSchema>;
    message: string;
    sessionTarget?: 'new_session' | 'single_session';
  };
  taskId?: string;
  patch?: Record<string, unknown>;
}): Promise<CallToolResult> {
  if (!MANAGEMENT_PORT) {
    return {
      content: [{ type: 'text', text: 'Error: Cron management API is not available (MYAGENTS_MANAGEMENT_PORT not set).' }],
      isError: true,
    };
  }

  try {
    switch (args.action) {
      case 'add': {
        if (!args.job) {
          return {
            content: [{ type: 'text', text: 'Error: "job" is required for "add" action.' }],
            isError: true,
          };
        }
        if (!imCronContext) {
          return {
            content: [{ type: 'text', text: 'Error: No IM context available. This tool can only be used within an IM Bot session.' }],
            isError: true,
          };
        }

        const result = await managementApi('/api/cron/create', 'POST', {
          name: args.job.name,
          schedule: args.job.schedule,
          message: args.job.message,
          sessionTarget: args.job.sessionTarget ?? 'new_session',
          sourceBotId: imCronContext.botId,
          delivery: {
            botId: imCronContext.botId,
            chatId: imCronContext.chatId,
            platform: imCronContext.platform,
          },
          workspacePath: imCronContext.workspacePath,
          model: imCronContext.model,
          permissionMode: imCronContext.permissionMode ?? 'auto',
          providerEnv: imCronContext.providerEnv,
          intervalMinutes: args.job.schedule.kind === 'every' ? args.job.schedule.minutes : 30,
        }) as { ok: boolean; taskId?: string; error?: string };

        if (result.ok) {
          return {
            content: [{
              type: 'text',
              text: `Scheduled task created successfully.\nTask ID: ${result.taskId}\nSchedule: ${formatSchedule(args.job.schedule)}\nMessage: ${args.job.message}`,
            }],
          };
        }
        return {
          content: [{ type: 'text', text: `Error creating task: ${result.error}` }],
          isError: true,
        };
      }

      case 'list': {
        const query = imCronContext ? `?sourceBotId=${encodeURIComponent(imCronContext.botId)}` : '';
        const result = await managementApi(`/api/cron/list${query}`) as {
          tasks: Array<{
            id: string;
            name?: string;
            prompt: string;
            status: string;
            schedule?: unknown;
            intervalMinutes: number;
            executionCount: number;
            lastExecutedAt?: string;
            createdAt: string;
          }>;
        };

        if (result.tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No scheduled tasks found.' }],
          };
        }

        const lines = result.tasks.map((t, i) => {
          const schedule = t.schedule ? JSON.stringify(t.schedule) : `every ${t.intervalMinutes} min`;
          return `${i + 1}. [${t.status}] ${t.name || t.id}\n   Schedule: ${schedule}\n   Message: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}\n   Executions: ${t.executionCount}${t.lastExecutedAt ? `, last: ${t.lastExecutedAt}` : ''}`;
        });

        return {
          content: [{ type: 'text', text: `Scheduled Tasks:\n\n${lines.join('\n\n')}` }],
        };
      }

      case 'update': {
        if (!args.taskId || !args.patch) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" and "patch" are required for "update" action.' }],
            isError: true,
          };
        }
        const result = await managementApi('/api/cron/update', 'POST', {
          taskId: args.taskId,
          patch: args.patch,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} updated successfully.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      case 'remove': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" is required for "remove" action.' }],
            isError: true,
          };
        }
        const result = await managementApi('/api/cron/delete', 'POST', {
          taskId: args.taskId,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} deleted.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      case 'run': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" is required for "run" action.' }],
            isError: true,
          };
        }
        const result = await managementApi('/api/cron/run', 'POST', {
          taskId: args.taskId,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} triggered for immediate execution.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown action: ${args.action}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function formatSchedule(schedule: z.infer<typeof scheduleSchema>): string {
  switch (schedule.kind) {
    case 'at':
      return `One-shot at ${schedule.at}`;
    case 'every':
      return `Every ${schedule.minutes} minutes`;
    case 'cron':
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
}

// ===== Server creation =====

export function createImCronToolServer() {
  return createSdkMcpServer({
    name: 'im-cron',
    version: '1.0.0',
    tools: [
      tool(
        'cron',
        `Create, list, update, remove, or manually trigger scheduled tasks.

Use this tool when the user wants to:
- Set a reminder ("remind me in 30 minutes")
- Create a recurring check ("check email every hour")
- Schedule a one-time task ("at 3pm, send me the weather")
- List/update/delete existing scheduled tasks

Schedules can be:
- "at": One-shot at a specific ISO-8601 datetime
- "every": Recurring at fixed intervals (minimum 5 minutes)
- "cron": Standard cron expression with optional timezone

The task runs independently in a new AI session. Results are delivered to this chat.`,
        {
          action: z.enum(['list', 'add', 'update', 'remove', 'run'])
            .describe('Action to perform'),
          job: z.object({
            name: z.string().optional().describe('Human-readable task name'),
            schedule: scheduleSchema,
            message: z.string().describe('The prompt/instruction for the AI to execute'),
            sessionTarget: z.enum(['new_session', 'single_session']).optional()
              .describe('Whether to create a new session each time (default) or reuse one'),
          }).optional().describe('Required for "add" action'),
          taskId: z.string().optional().describe('Task ID (required for update/remove/run)'),
          patch: z.record(z.string(), z.any()).optional().describe('Fields to update (for "update" action)'),
        },
        imCronToolHandler,
      ),
    ],
  });
}

export const imCronToolServer = createImCronToolServer();
