// Custom MCP Tools for Cron Task Management
// Uses Claude Agent SDK's createSdkMcpServer for in-process tool definitions

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { broadcast } from '../sse';

// MCP Tool Result type (matches @modelcontextprotocol/sdk/types.js CallToolResult)
type CallToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

// ============= Cron Task Detection Constants =============
// These are used to detect AI exit requests in response text

/** Marker for AI-initiated task completion (legacy format) */
export const CRON_TASK_COMPLETE_MARKER = 'CRON_TASK_COMPLETE';

/** Pattern to match completion marker with reason */
export const CRON_TASK_COMPLETE_PATTERN = /\[CRON_TASK_COMPLETE:\s*(.+?)\]/;

/** Text indicating AI requested task exit via tool */
export const CRON_TASK_EXIT_TEXT = 'Scheduled task exit requested';

/** Pattern to extract exit reason from tool response */
export const CRON_TASK_EXIT_REASON_PATTERN = /Reason:\s*(.+?)(?:\n|$)/;

/**
 * Cron task context for tool execution
 * This is set by the agent session when executing a cron task
 */
let currentCronTaskId: string | null = null;
let currentCronTaskCanExit: boolean = false;

/**
 * Set the current cron task context
 * Called by agent-session before executing a cron task prompt
 */
export function setCronTaskContext(taskId: string | null, canExit: boolean = false): void {
  currentCronTaskId = taskId;
  currentCronTaskCanExit = canExit;
  console.log(`[cron-tools] Context set: taskId=${taskId}, canExit=${canExit}`);
}

/**
 * Get the current cron task context
 */
export function getCronTaskContext(): { taskId: string | null; canExit: boolean } {
  return { taskId: currentCronTaskId, canExit: currentCronTaskCanExit };
}

/**
 * Clear the cron task context
 * Called after task execution completes
 */
export function clearCronTaskContext(): void {
  currentCronTaskId = null;
  currentCronTaskCanExit = false;
  console.log('[cron-tools] Context cleared');
}

/**
 * Exit cron task tool handler
 * AI calls this tool when it determines the scheduled task goal is achieved
 */
async function exitCronTaskHandler(args: { reason: string }): Promise<CallToolResult> {
  const { reason } = args;

  // Check if we're in a cron task context
  if (!currentCronTaskId) {
    return {
      content: [{
        type: 'text',
        text: 'Error: exit_cron_task can only be called during a scheduled task execution. No active cron task found.'
      }],
      isError: true
    };
  }

  // Check if AI is allowed to exit this task
  if (!currentCronTaskCanExit) {
    return {
      content: [{
        type: 'text',
        text: 'Error: This scheduled task does not allow AI to exit. The task creator has disabled the "Allow AI to exit" option.'
      }],
      isError: true
    };
  }

  console.log(`[cron-tools] exit_cron_task called: taskId=${currentCronTaskId}, reason="${reason}"`);

  // Broadcast the completion event to frontend
  // The frontend will handle updating the task status via Tauri IPC
  broadcast('cron:task-exit-requested', {
    taskId: currentCronTaskId,
    reason,
    timestamp: new Date().toISOString()
  });

  return {
    content: [{
      type: 'text',
      text: `${CRON_TASK_EXIT_TEXT}. Reason: ${reason}\n\nThe task will be marked as completed and no further scheduled executions will occur.`
    }]
  };
}

/**
 * Create the cron tools MCP server
 * This server provides tools for AI to interact with the cron task system
 */
export function createCronToolsServer() {
  return createSdkMcpServer({
    name: 'cron-tools',
    version: '1.0.0',
    tools: [
      tool(
        'exit_cron_task',
        `End the current scheduled task. Call this tool when:
1. The task's goal has been fully achieved and no further executions are needed
2. You determine that continuing the task would be pointless or counterproductive
3. An unrecoverable error makes the task impossible to complete

The reason you provide will be displayed to the user in a notification.

IMPORTANT: This tool can only be used during scheduled task execution, and only if the task creator has enabled "Allow AI to exit".`,
        {
          reason: z.string()
            .min(1)
            .max(500)
            .describe('A clear explanation of why the task should end. This will be shown to the user.')
        },
        exitCronTaskHandler
      )
    ]
  });
}

/**
 * Get the cron tools server for use in agent session
 * Returns the server config that can be passed to mcpServers option
 */
export const cronToolsServer = createCronToolsServer();

/**
 * MCP tool name for exit_cron_task
 * Format: mcp__<server-name>__<tool-name>
 */
export const EXIT_CRON_TASK_TOOL_NAME = 'mcp__cron-tools__exit_cron_task';
