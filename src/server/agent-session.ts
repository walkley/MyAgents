import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { query, type Query, type SDKUserMessage, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { getScriptDir, getBundledBunDir } from './utils/runtime';
import { getCrossPlatformEnv } from './utils/platform';
import { cronToolsServer, getCronTaskContext, clearCronTaskContext } from './tools/cron-tools';
import { imCronToolServer, getImCronContext } from './tools/im-cron-tool';

import type { ToolInput } from '../renderer/types/chat';
import { parsePartialJson } from '../shared/parsePartialJson';
import type { SystemInitInfo } from '../shared/types/system';
import { saveSessionMetadata, updateSessionTitleFromMessage, saveSessionMessages, saveAttachment, updateSessionMetadata, getSessionMetadata, getSessionData } from './SessionStore';
import { createSessionMetadata, type SessionMessage, type MessageAttachment, type MessageUsage } from './types/session';
import { broadcast } from './sse';
import { initLogger, appendLog, getLogLines as getLogLinesFromLogger } from './AgentLogger';

// Module-level debug mode check (avoids repeated environment variable access)
const isDebugMode = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

// Decorative text filter thresholds (for third-party API wrappers like 智谱 GLM-4.7)
// Decorative blocks are typically 100-2000 chars; we use wider range for safety margin
const DECORATIVE_TEXT_MIN_LENGTH = 50;
const DECORATIVE_TEXT_MAX_LENGTH = 5000;

// ===== Product Directory Configuration =====
// Our product (MyAgents) uses ~/.myagents/ for user configuration
// This is SEPARATE from Claude CLI's ~/.claude/ directory
// Only subscription-related features may access ~/.claude/ (handled by SDK internally)
const MYAGENTS_USER_DIR = '.myagents';

/**
 * Get the MyAgents user directory path
 * All user configs (MCP, providers, projects, etc.) are stored here
 */
export function getMyAgentsUserDir(): string {
  const { home, temp } = getCrossPlatformEnv();
  // Fallback to temp directory if home is not available (extremely rare)
  // temp is now guaranteed to have a valid platform-specific fallback
  const homeDir = home || temp;
  return join(homeDir, MYAGENTS_USER_DIR);
}

type SessionState = 'idle' | 'running' | 'error';

// Permission mode types - UI values
export type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

// Map UI permission mode to SDK permission mode
function mapToSdkPermissionMode(mode: PermissionMode): 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default' {
  switch (mode) {
    case 'auto':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'fullAgency':
      return 'bypassPermissions';
    case 'custom':
    default:
      return 'default';
  }
}

type ToolUseState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  subagentCalls?: SubagentToolCall[];
};

type SubagentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex?: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
};

type ContentBlock = {
  type: 'text' | 'tool_use' | 'thinking' | 'server_tool_use';
  text?: string;
  tool?: ToolUseState;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
};

export type MessageWire = {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: string;
  sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
  attachments?: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    savedPath?: string;
    relativePath?: string;
    previewUrl?: string;
    isImage?: boolean;
  }[];
  metadata?: {
    source: 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';
    sourceId?: string;
    senderName?: string;
  };
};

const requireModule = createRequire(import.meta.url);

let agentDir = '';
let hasInitialPrompt = false;
let sessionState: SessionState = 'idle';
let querySession: Query | null = null;
let isProcessing = false;
let shouldAbortSession = false;
// Deferred config restart: when MCP/Agents config changes during an active turn,
// we defer the session restart until the current turn completes naturally.
// This prevents Tab config sync from aborting a shared IM session mid-response.
let pendingConfigRestart = false;
let sessionTerminationPromise: Promise<void> | null = null;
let isInterruptingResponse = false;
let isStreamingMessage = false;
const messages: MessageWire[] = [];
const streamIndexToToolId: Map<number, string> = new Map();
const toolResultIndexToId: Map<number, string> = new Map();

// IM Draft Stream: callback for streaming text to Telegram
type ImStreamCallback = (event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity', data: string) => void;
let imStreamCallback: ImStreamCallback | null = null;
// Flag: auto-reset session after image content pollutes conversation history
let shouldResetSessionAfterError = false;
// Track text block indices for detecting text-type content_block_stop
const imTextBlockIndices = new Set<number>();
const childToolToParent: Map<string, string> = new Map();
let messageSequence = 0;
let sessionId = randomUUID();

// Pre-warm: start SDK subprocess + MCP servers before user sends first message
let isPreWarming = false;
let preWarmTimer: ReturnType<typeof setTimeout> | null = null;
let preWarmFailCount = 0;
const PRE_WARM_MAX_RETRIES = 3;
let systemInitInfo: SystemInitInfo | null = null;
type MessageQueueItem = {
  id: string;                     // Unique queue item ID
  message: SDKUserMessage['message'];
  messageText: string;            // Original text for cancel/restore
  wasQueued: boolean;             // true if added via non-blocking path (AI was busy)
  resolve: () => void;
  attachments?: MessageWire['attachments'];  // Saved attachments for deferred user message rendering
};
const messageQueue: MessageQueueItem[] = [];
// Pending attachments to persist with user messages
const _pendingAttachments: MessageAttachment[] = [];
// Current permission mode for the session (updates on each user message)
let currentPermissionMode: PermissionMode = 'auto';
// Current model for the session (updates on each user message if changed)
let currentModel: string | undefined = undefined;
// Provider environment config (baseUrl, apiKey, authType) for third-party providers
export type ProviderEnv = {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
};
let currentProviderEnv: ProviderEnv | undefined = undefined;
// SDK 是否已注册当前 sessionId。true 时后续 query 必须用 resume。
// 仅由非 pre-warm 的 system_init 设为 true，仅由 sessionId 变更设为 false。
// Pre-warm 永不修改此标志 — 从结构上消除超时/重试导致的状态错误。
let sessionRegistered = false;

// 时间回溯：对话截断后，下次 query 需携带 resumeSessionAt 截断 SDK 对话历史
let pendingResumeSessionAt: string | undefined;
// 时间回溯进行中 — 阻止 enqueueUserMessage 并发写入
let rewindPromise: Promise<unknown> | null = null;

// ===== 持久 Session 门控 =====
// 消息交付：事件驱动替代轮询，generator 阻塞在 waitForMessage 直到新消息到达
let messageResolver: ((item: MessageQueueItem | null) => void) | null = null;
// 回合同步：等待 result 后才 yield 下一条消息
let resolveTurnComplete: (() => void) | null = null;

/** 唤醒 generator — 投递消息或 null（退出信号） */
function wakeGenerator(item: MessageQueueItem | null): void {
  if (messageResolver) {
    const resolve = messageResolver;
    messageResolver = null;
    resolve(item);
  } else if (item) {
    messageQueue.push(item);
  }
}

/** generator 等待下一条消息（事件驱动，无轮询） */
function waitForMessage(): Promise<MessageQueueItem | null> {
  if (shouldAbortSession) return Promise.resolve(null);
  if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift()!);
  return new Promise(resolve => { messageResolver = resolve; });
}

/** result handler 调用：解锁 generator 进入下一轮 */
function signalTurnComplete(): void {
  if (resolveTurnComplete) {
    const resolve = resolveTurnComplete;
    resolveTurnComplete = null;
    resolve();
  }
}

/** generator 等待当前回合 AI 回复完成 */
function waitForTurnComplete(): Promise<void> {
  if (shouldAbortSession) return Promise.resolve();
  return new Promise(resolve => { resolveTurnComplete = resolve; });
}

/** 中止持久 session：唤醒所有被阻塞的 Promise */
function abortPersistentSession(): void {
  shouldAbortSession = true;
  // Notify IM stream callback before abort
  if (imStreamCallback) {
    imStreamCallback('error', '会话已中断，请重新发送');
    imStreamCallback = null;
  }
  // 唤醒被阻塞的 generator（waitForMessage）
  if (messageResolver) {
    const resolve = messageResolver;
    messageResolver = null;
    resolve(null);
  }
  // 唤醒被阻塞的 generator（waitForTurnComplete）
  signalTurnComplete();
  // 强制 subprocess 产出消息/错误，解除 for-await 阻塞
  querySession?.interrupt().catch(() => {});
}

// ===== System Prompt Configuration =====
// Supports three modes:
// - 'preset': Use default claude_code system prompt (default)
// - 'replace': Completely replace with custom system prompt
// - 'append': Append content to the default claude_code system prompt
export type SystemPromptMode = 'preset' | 'replace' | 'append';

export type SystemPromptConfig =
  | { mode: 'preset' }
  | { mode: 'replace'; content: string }
  | { mode: 'append'; content: string };

let currentSystemPromptConfig: SystemPromptConfig = { mode: 'preset' };

/**
 * Set custom system prompt configuration.
 * This affects the next session creation (when query() is called).
 *
 * @param config - System prompt configuration
 *   - { mode: 'preset' }: Use default claude_code preset
 *   - { mode: 'replace', content: '...' }: Replace with custom system prompt
 *   - { mode: 'append', content: '...' }: Append to claude_code preset
 */
export function setSystemPromptConfig(config: SystemPromptConfig): void {
  currentSystemPromptConfig = config;
  if (isDebugMode) {
    console.log(`[agent] System prompt config set: mode=${config.mode}${config.mode !== 'preset' ? `, content length=${config.content.length}` : ''}`);
  }
}

/**
 * Clear system prompt configuration back to default preset.
 */
export function clearSystemPromptConfig(): void {
  currentSystemPromptConfig = { mode: 'preset' };
  if (isDebugMode) {
    console.log('[agent] System prompt config cleared to default preset');
  }
}

/**
 * Get current system prompt configuration.
 * Returns a shallow copy to prevent external mutation.
 */
export function getSystemPromptConfig(): SystemPromptConfig {
  // Return a copy to prevent external mutation of internal state
  return { ...currentSystemPromptConfig };
}

/**
 * Build the systemPrompt option for SDK query() call.
 * Translates our config format to SDK's expected format.
 */
function buildSystemPromptOption(): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  switch (currentSystemPromptConfig.mode) {
    case 'replace':
      // Complete replacement with custom system prompt
      return currentSystemPromptConfig.content;
    case 'append':
      // Use preset with appended content
      return {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: currentSystemPromptConfig.content
      };
    case 'preset':
    default:
      // Default preset without modifications
      return {
        type: 'preset' as const,
        preset: 'claude_code' as const
      };
  }
}
// SDK ready signal - prevents messageGenerator from yielding before SDK's ProcessTransport is ready
let _sdkReadyResolve: (() => void) | null = null;
let _sdkReadyPromise: Promise<void> | null = null;

// ===== Turn-level Usage Tracking =====
// Token usage for the current turn, extracted from SDK result message
import type { ModelUsageEntry } from './types/session';

let currentTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: undefined as string | undefined,
  modelUsage: undefined as Record<string, ModelUsageEntry> | undefined,
};
// Timestamp when current assistant response started
let currentTurnStartTime: number | null = null;
// Tool count for current turn
let currentTurnToolCount = 0;

function resetTurnUsage(): void {
  currentTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: undefined,
    modelUsage: undefined,
  };
  currentTurnStartTime = null;
  currentTurnToolCount = 0;
}

// ===== MCP Configuration =====
import type { McpServerDefinition } from '../renderer/config/types';

// SDK MCP server config type (subset of what SDK accepts)
type SdkMcpServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
};

// Current MCP servers enabled for this workspace (set per-query)
// null = never set (use config file fallback), [] = explicitly set to none
let currentMcpServers: McpServerDefinition[] | null = null;

// Current sub-agent definitions (set per-query via /api/agents/set)
// null = no agents configured, {} = explicitly set to none
let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;

// Preset MCP servers (same as renderer/config/types.ts)
const PRESET_MCP_SERVERS: McpServerDefinition[] = [
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    description: '浏览器自动化能力，支持网页浏览、截图、表单填写等',
    type: 'stdio',
    command: 'npx',
    // --user-data-dir is configured by user via config.mcpServerArgs for browser state persistence
    args: ['@playwright/mcp@latest'],
    env: {},
    isBuiltin: true,
  },
];

/**
 * Load MCP config from ~/.myagents/config.json
 * This provides a file-based approach that works across all sidecars
 */
function loadMcpServersFromConfig(): McpServerDefinition[] {
  if (isDebugMode) console.log('[agent] ==> loadMcpServersFromConfig() called');
  try {
    const configPath = join(getMyAgentsUserDir(), 'config.json');
    if (isDebugMode) console.log('[agent] Config path:', configPath);

    if (!existsSync(configPath)) {
      if (isDebugMode) console.log('[agent] No MCP config file found at:', configPath);
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic fs import for config loading
    const content = require('fs').readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Get globally enabled server IDs
    const globalEnabledIds: string[] = config.mcpEnabledServers ?? [];
    if (globalEnabledIds.length === 0) {
      if (isDebugMode) console.log('[agent] No MCP servers enabled globally');
      return [];
    }

    // Get custom servers from config + preset servers
    const customServers: McpServerDefinition[] = config.mcpServers ?? [];
    const allServers = [...PRESET_MCP_SERVERS, ...customServers];

    // Filter to only globally enabled servers
    const enabledServers = allServers.filter(s => globalEnabledIds.includes(s.id));

    // Apply server-specific args and env overrides
    const serverArgsConfig: Record<string, string[]> = config.mcpServerArgs ?? {};
    const serverEnvConfig: Record<string, Record<string, string>> = config.mcpServerEnv ?? {};

    return enabledServers.map(server => ({
      ...server,
      args: [...(server.args ?? []), ...(serverArgsConfig[server.id] ?? [])],
      env: { ...server.env, ...(serverEnvConfig[server.id] ?? {}) }
    }));
  } catch (error) {
    console.error('[agent] Failed to load MCP config from file:', error);
    return [];
  }
}

/**
 * Set the MCP servers to use for subsequent queries
 * Called from renderer when user toggles MCP in workspace
 * If MCP config changed and a session is running, it will be restarted with resume
 */
export function setMcpServers(servers: McpServerDefinition[]): void {
  // Check if MCP config actually changed
  const currentIds = (currentMcpServers ?? []).map(s => s.id).sort().join(',');
  const newIds = servers.map(s => s.id).sort().join(',');
  const mcpChanged = currentIds !== newIds;

  currentMcpServers = servers;
  if (isDebugMode) {
    console.log(`[agent] MCP servers set: ${servers.map(s => s.id).join(', ') || 'none'}`);
    // Log servers with custom env vars for debugging
    for (const s of servers) {
      if (s.env && Object.keys(s.env).length > 0) {
        console.log(`[agent] MCP ${s.id}: Has custom env vars: ${Object.keys(s.env).join(', ')}`);
      }
    }
  }

  // If MCP changed and session is running, restart with resume to apply new config
  if (mcpChanged && querySession) {
    if (isProcessing && !isPreWarming) {
      // Active user turn in progress (e.g. IM responding) — defer restart to avoid killing mid-response.
      // The restart will fire after the current turn completes (see signalTurnComplete handler).
      // Pre-warm sessions are safe to abort immediately (no user message to lose).
      console.log(`[agent] MCP config changed (${currentIds || 'none'} -> ${newIds || 'none'}), deferring restart (active turn)`);
      pendingConfigRestart = true;
    } else {
      if (isDebugMode) console.log(`[agent] MCP config changed (${currentIds || 'none'} -> ${newIds || 'none'}), restarting session with resume`);
      abortPersistentSession();
    }
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  preWarmFailCount = 0; // Config changed — reset retry tracking
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/**
 * Get current MCP servers
 * Returns null if never set (workspace not initialized), or array (possibly empty)
 */
export function getMcpServers(): McpServerDefinition[] | null {
  return currentMcpServers;
}

/**
 * Set the sub-agent definitions for subsequent queries
 * If agents changed and a session is running, it will be restarted with resume
 */
export function setAgents(agents: Record<string, AgentDefinition>): void {
  const currentNames = currentAgentDefinitions ? Object.keys(currentAgentDefinitions).sort().join(',') : '';
  const newNames = Object.keys(agents).sort().join(',');
  const agentsChanged = currentNames !== newNames;

  currentAgentDefinitions = agents;
  if (isDebugMode) {
    console.log(`[agent] Sub-agents set: ${newNames || 'none'}`);
  }

  // If agents changed and session is running, restart with resume
  if (agentsChanged && querySession) {
    if (isProcessing && !isPreWarming) {
      console.log(`[agent] Sub-agents changed (${currentNames || 'none'} -> ${newNames || 'none'}), deferring restart (active turn)`);
      pendingConfigRestart = true;
    } else {
      if (isDebugMode) console.log(`[agent] Sub-agents changed (${currentNames || 'none'} -> ${newNames || 'none'}), restarting session with resume`);
      abortPersistentSession();
    }
  }

  // Pre-warm: start/restart subprocess + MCP servers ahead of user's first message
  preWarmFailCount = 0; // Config changed — reset retry tracking
  if (!isProcessing || isPreWarming) {
    schedulePreWarm();
  }
}

/**
 * Set the default model for subsequent queries.
 * Called during tab initialization so the backend has a real default model
 * before pre-warm starts. This ensures:
 * 1. Pre-warm uses the correct model (no undefined → SDK guesses)
 * 2. Gateway clients (Telegram, API) can omit model and get a proper default
 * 3. First user message doesn't trigger a blocking setModel() call
 *
 * Unlike MCP/agents, model changes don't require session restart —
 * so this does NOT trigger schedulePreWarm(). The debounced pre-warm
 * from MCP/agents sync will pick up the model automatically.
 */
export function getSessionModel(): string | undefined {
  return currentModel;
}

export function setSessionModel(model: string): void {
  if (model === currentModel) return;

  const oldModel = currentModel;
  currentModel = model;
  console.log(`[agent] session model set: ${oldModel ?? 'undefined'} -> ${model}`);

  // If a session is actively running (not pre-warming), apply model change to subprocess.
  // This ensures dropdown model switches take effect immediately, even if the sync
  // arrives before the next user message triggers applySessionConfig.
  if (querySession && !isPreWarming) {
    querySession.setModel(model).catch(err => {
      console.error('[agent] failed to apply model to running session:', err);
    });
  }
}

/**
 * Schedule a pre-warm of the SDK subprocess and MCP servers.
 * Uses debounce to batch rapid config changes during tab initialization.
 * The pre-warmed session is invisible to the frontend until the first user message.
 */
function schedulePreWarm(): void {
  if (preWarmTimer) clearTimeout(preWarmTimer);
  if (!agentDir) return;

  // Stop retrying after consecutive failures to avoid infinite loop
  if (preWarmFailCount >= PRE_WARM_MAX_RETRIES) {
    console.warn(`[agent] pre-warm skipped: ${preWarmFailCount} consecutive failures, giving up`);
    return;
  }

  preWarmTimer = setTimeout(() => {
    preWarmTimer = null;
    if (!isSessionActive() && agentDir) {
      console.log('[agent] pre-warming SDK subprocess + MCP servers');
      startStreamingSession(true).catch((error) => {
        console.error('[agent] pre-warm failed:', error);
      });
    }
  }, 500);
}

/**
 * Get current sub-agent definitions
 */
export function getAgents(): Record<string, AgentDefinition> | null {
  return currentAgentDefinitions;
}

/**
 * Check if an MCP tool is allowed based on user's MCP settings
 *
 * MCP tool naming convention: mcp__<server-id>__<tool-name>
 * e.g., mcp__playwright__browser_navigate
 *
 * @returns 'allow' if tool is permitted, 'deny' with reason otherwise
 */
function checkMcpToolPermission(toolName: string): { allowed: true } | { allowed: false; reason: string } {
  // Not an MCP tool - let other permission logic handle it
  if (!toolName.startsWith('mcp__')) {
    return { allowed: true };
  }

  // Extract server ID from tool name: mcp__<server-id>__<tool-name>
  const parts = toolName.split('__');
  if (parts.length < 3) {
    return { allowed: false, reason: '无效的 MCP 工具名称' };
  }
  const serverId = parts[1];

  // Special case: cron-tools is a built-in MCP server for cron task management
  // Always allow when we're in a cron task context (regardless of user's MCP settings)
  if (serverId === 'cron-tools') {
    const cronContext = getCronTaskContext();
    if (cronContext.taskId) {
      return { allowed: true };
    }
    // Not in cron context - this tool shouldn't be available
    return { allowed: false, reason: '定时任务工具只能在定时任务执行期间使用' };
  }

  // Special case: im-cron is a built-in MCP server for IM Bot scheduled tasks
  if (serverId === 'im-cron') {
    const imCtx = getImCronContext();
    if (imCtx) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'IM 定时任务工具只能在 IM Bot 会话中使用' };
  }

  // Case 1: MCP not set (null) - allow all (backward compatible)
  if (currentMcpServers === null) {
    return { allowed: true };
  }

  // Case 2: User disabled all MCP
  if (currentMcpServers.length === 0) {
    return { allowed: false, reason: 'MCP 工具已被禁用' };
  }

  // Case 3: User enabled specific MCP - check if this tool's server is enabled
  // Check if this server is in the enabled list
  const isEnabled = currentMcpServers.some(s => s.id === serverId);
  if (isEnabled) {
    return { allowed: true };
  }

  return { allowed: false, reason: `MCP 服务「${serverId}」未启用` };
}

/**
 * Build SDK settingSources
 *
 * settingSources controls where SDK reads settings from:
 * - 'user': ~/.claude/ (Claude CLI's user directory)
 * - 'project': <cwd>/.claude/ (project-level config)
 *
 * We use 'project' only:
 * - Enables SDK to read project's .claude/skills/, .claude/commands/, CLAUDE.md
 * - Project-level MCP in .claude/ will also be discovered (acceptable - it's project config)
 *
 * We exclude 'user' because:
 * - ~/.claude/ is Claude CLI's directory, not our product's directory
 * - Our product (MyAgents) uses ~/.myagents/ for user-level config
 * - We manage additional MCP explicitly via mcpServers option
 */
function buildSettingSources(): ('user' | 'project')[] {
  // Always use 'project' to enable SDK reading from <cwd>/.claude/
  // This is required for: skills, commands, CLAUDE.md, project settings
  // Note: Project-level MCP in .claude/ will also be discovered (acceptable)
  return ['project'];
}

// Known MCP package versions — pin these to avoid npm registry lookups on every startup
// Update these when upgrading MCP server dependencies
const PINNED_MCP_VERSIONS: Record<string, string> = {
  '@playwright/mcp': '0.0.64',
};

/**
 * Replace @latest tags with pinned versions for known MCP packages.
 * This eliminates the npm registry network check that adds 2-5s latency per startup.
 * Unknown packages keep their original version specifiers.
 */
function pinMcpPackageVersions(args: string[]): string[] {
  return args.map(arg => {
    // Match patterns like @playwright/mcp@latest or @scope/pkg@latest
    const latestMatch = arg.match(/^(@?[^@]+)@latest$/);
    if (latestMatch) {
      const pkgName = latestMatch[1];
      const pinned = PINNED_MCP_VERSIONS[pkgName];
      if (pinned) {
        console.log(`[agent] MCP version pinned: ${arg} → ${pkgName}@${pinned}`);
        return `${pkgName}@${pinned}`;
      }
    }
    return arg;
  });
}

/**
 * Convert McpServerDefinition to SDK mcpServers format
 *
 * Execution strategy:
 * - For npx commands: Uses bundled bun (bun x), fallback to npx if bun unavailable
 * - For other commands: Uses user-specified command directly (node/python etc.)
 * - Does NOT inject proxy env vars (follows Claude Code's approach)
 *   Child process inherits environment naturally from shell
 *
 * This approach:
 * - Zero external dependencies: bundled bun ensures MCP works without Node.js
 * - Fallback to npx for environments where bun is unavailable
 * - Custom MCP can use any user-preferred tools
 */
function buildSdkMcpServers(): Record<string, SdkMcpServerConfig | typeof cronToolsServer> {
  // Use memory cache if set (even if empty - user explicitly disabled all MCP)
  // Only fall back to config file if never set (null)
  let servers: McpServerDefinition[];
  if (currentMcpServers === null) {
    servers = loadMcpServersFromConfig();
    console.log(`[agent] Loaded MCP from config file: ${servers.map(s => s.id).join(', ') || 'none'}`);
  } else {
    servers = currentMcpServers;
    if (isDebugMode) console.log(`[agent] Using workspace MCP: ${servers.map(s => s.id).join(', ') || 'none'}`);
  }

  const result: Record<string, SdkMcpServerConfig | typeof cronToolsServer> = {};

  // Add cron tools server if we're in a cron task context
  const cronContext = getCronTaskContext();
  if (cronContext.taskId) {
    result['cron-tools'] = cronToolsServer;
    console.log(`[agent] Added cron-tools MCP server for task ${cronContext.taskId}`);
  }

  // Add IM cron tool if we're in an IM context with management API available
  const imCronCtx = getImCronContext();
  if (imCronCtx && process.env.MYAGENTS_MANAGEMENT_PORT) {
    result['im-cron'] = imCronToolServer;
    console.log(`[agent] Added im-cron MCP server for bot ${imCronCtx.botId}`);
  }

  // Return early if no user MCP servers (but may have cron-tools)
  if (servers.length === 0) {
    if (Object.keys(result).length > 0) {
      console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ')}`);
    }
    return result;
  }

  for (const server of servers) {
    // Log server env for debugging
    if (isDebugMode && server.env && Object.keys(server.env).length > 0) {
      console.log(`[agent] MCP ${server.id}: Custom env vars: ${Object.keys(server.env).join(', ')}`);
    }

    if (server.type === 'stdio' && server.command) {
      let command = server.command;
      let args = server.args || [];

      // For npx commands: builtin MCP uses bundled bun, custom MCP uses system npx
      if (command === 'npx') {
        if (server.isBuiltin) {
          // Builtin MCP: use bundled bun x (no Node.js dependency)
          // Pin @latest to known versions to avoid npm registry check on every startup
          args = pinMcpPackageVersions(args);

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic import for runtime detection
          const { getBundledRuntimePath, isBunRuntime } = require('./utils/runtime');
          const runtime = getBundledRuntimePath();

          if (isBunRuntime(runtime)) {
            command = runtime;
            args = ['x', ...args];
            console.log(`[agent] MCP ${server.id}: Using bundled bun x`);
          } else {
            args = ['-y', ...args];
            console.log(`[agent] MCP ${server.id}: Using npx (bun not available)`);
          }
        } else {
          // Custom MCP: use system npx with -y for auto-confirm
          if (!args.includes('-y')) {
            args = ['-y', ...args];
          }
          console.log(`[agent] MCP ${server.id}: Using system npx`);
        }
      }

      // Log full command for debugging
      console.log(`[agent] MCP ${server.id}: ${command} ${args.join(' ')}`);

      // Build MCP config - follow Claude Code's approach:
      // Don't pass explicit env vars, let child process inherit naturally
      // This avoids issues with proxy env vars affecting WebSocket connections
      const mcpConfig: SdkMcpServerConfig = {
        command,
        args,
      };

      // Only add env if server has custom env vars defined
      if (server.env && Object.keys(server.env).length > 0) {
        mcpConfig.env = server.env;
      }

      result[server.id] = mcpConfig;
    } else if ((server.type === 'sse' || server.type === 'http') && server.url) {
      result[server.id] = {
        type: server.type,
        url: server.url,
        headers: server.headers,
      };
    }
  }

  console.log(`[agent] Built SDK MCP servers: ${Object.keys(result).join(', ') || 'none'}`);
  // Always return result (even if empty) to prevent SDK from using default config
  return result;
}

/**
 * Permission rules for each mode
 */
interface PermissionRules {
  allowedTools: string[];    // Auto-approved tools (glob patterns supported)
  deniedTools: string[];     // Always denied tools
  // Tools not in either list will prompt user for confirmation
}

/**
 * Get permission rules based on current permission mode
 */
function getPermissionRules(mode: PermissionMode): PermissionRules {
  switch (mode) {
    case 'auto':
      return {
        allowedTools: [
          'Read', 'Glob', 'Grep', 'LS',           // Read operations
          'Edit', 'Write', 'MultiEdit',           // Write operations (acceptEdits)
          'NotebookEdit', 'TodoRead', 'TodoWrite', // Notebook/Todo operations
          'Skill'                                  // Skills - auto-approve skill invocations
        ],
        deniedTools: [],
        // Bash, Task, WebFetch, WebSearch, mcp__* → need confirmation
      };
    case 'plan':
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'LS'], // Read-only
        deniedTools: ['*'], // Everything else denied in plan mode
      };
    case 'fullAgency':
      return {
        allowedTools: ['*'], // Everything auto-approved
        deniedTools: [],
      };
    case 'custom':
    default:
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'Skill'], // Read-only + Skills auto-approved
        deniedTools: [],
        // Everything else needs confirmation
      };
  }
}

/**
 * Session-scoped permission state
 * Tracks tools that user has granted "always allow" for this session
 */
const sessionAlwaysAllowed = new Set<string>();

// Pending permission requests waiting for user response
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  toolName: string;
  input: unknown;
  timer: ReturnType<typeof setTimeout>;  // Timer reference for cleanup
}>();

// AskUserQuestion types - import from shared
import type { AskUserQuestionInput } from '../shared/types/askUserQuestion';
export type { AskUserQuestionInput, AskUserQuestion, AskUserQuestionOption } from '../shared/types/askUserQuestion';

// Pending AskUserQuestion requests waiting for user response
const pendingAskUserQuestions = new Map<string, {
  resolve: (answers: Record<string, string> | null) => void;
  input: AskUserQuestionInput;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Validate AskUserQuestion input structure
 */
function isValidAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;

  // Validate each question has required fields
  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      typeof question.multiSelect === 'boolean'
    );
  });
}

/**
 * Handle AskUserQuestion tool - prompts user for structured answers
 * Returns the input with answers filled in, or null if denied/aborted
 */
async function handleAskUserQuestion(
  input: unknown,
  signal?: AbortSignal
): Promise<Record<string, string> | null> {
  console.log('[AskUserQuestion] Requesting user input');

  // Validate input structure
  if (!isValidAskUserQuestionInput(input)) {
    console.error('[AskUserQuestion] Invalid input structure:', input);
    return null;
  }

  const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const questionInput = input;

  // Broadcast AskUserQuestion request to frontend
  broadcast('ask-user-question:request', {
    requestId,
    questions: questionInput.questions,
  });

  // Wait for user response or abort
  return new Promise((resolve) => {
    // Timeout after 10 minutes (user needs time to think)
    const timer = setTimeout(() => {
      if (pendingAskUserQuestions.has(requestId)) {
        cleanup();
        console.warn('[AskUserQuestion] Timed out after 10 minutes');
        resolve(null);
      }
    }, 10 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      pendingAskUserQuestions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug('[AskUserQuestion] Aborted by SDK signal');
      cleanup();
      resolve(null);
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    pendingAskUserQuestions.set(requestId, { resolve, input: questionInput, timer });
  });
}

/**
 * Handle user's AskUserQuestion response from frontend
 */
export function handleAskUserQuestionResponse(
  requestId: string,
  answers: Record<string, string> | null
): boolean {
  console.debug(`[AskUserQuestion] handleResponse: requestId=${requestId}, answers=${JSON.stringify(answers)}`);

  const pending = pendingAskUserQuestions.get(requestId);
  if (!pending) {
    console.warn(`[AskUserQuestion] Unknown request: ${requestId}`);
    return false;
  }

  // Clear the timeout timer to prevent memory leak
  clearTimeout(pending.timer);
  pendingAskUserQuestions.delete(requestId);

  if (answers === null) {
    console.log('[AskUserQuestion] User cancelled');
    pending.resolve(null);
  } else {
    console.log('[AskUserQuestion] User answered');
    pending.resolve(answers);
  }

  return true;
}

/**
 * Check if a glob pattern matches a tool name
 */
function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  // Simple glob: mcp__playwright__* matches mcp__playwright__browser_tabs
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

/**
 * Check if tool is in a list (supports glob patterns)
 */
function isToolInList(toolName: string, list: string[]): boolean {
  return list.some(pattern => matchesPattern(pattern, toolName));
}

/**
 * Check tool permission - returns immediately for allowed/denied tools,
 * or waits for user response for unknown tools
 */
async function checkToolPermission(
  toolName: string,
  input: unknown,
  mode: PermissionMode,
  signal?: AbortSignal
): Promise<'allow' | 'deny'> {
  const rules = getPermissionRules(mode);

  // 1. Check if tool is always allowed for this mode
  if (isToolInList(toolName, rules.allowedTools)) {
    console.debug(`[permission] ${toolName}: auto-allowed by mode rules`);
    return 'allow';
  }

  // 1.5. Auto-allow Task tool when sub-agents are configured (needed for delegation)
  if (toolName === 'Task' && currentAgentDefinitions && Object.keys(currentAgentDefinitions).length > 0) {
    console.debug(`[permission] ${toolName}: auto-allowed for sub-agent delegation`);
    return 'allow';
  }

  // 2. Check if tool is denied for this mode
  if (isToolInList(toolName, rules.deniedTools)) {
    console.debug(`[permission] ${toolName}: denied by mode rules`);
    return 'deny';
  }

  // 3. Check if user already granted "always allow" in this session
  if (sessionAlwaysAllowed.has(toolName)) {
    console.debug(`[permission] ${toolName}: allowed by session grant`);
    return 'allow';
  }

  // 4. Check if already aborted
  if (signal?.aborted) {
    console.debug(`[permission] ${toolName}: already aborted, denying`);
    return 'deny';
  }

  // 5. Request user confirmation via frontend
  console.log(`[permission] ${toolName}: requesting user confirmation`);  // Keep as info - user action needed

  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const inputPreview = typeof input === 'object' ? JSON.stringify(input).slice(0, 500) : String(input).slice(0, 500);

  // Broadcast permission request to frontend
  broadcast('permission:request', {
    requestId,
    toolName,
    input: inputPreview,
  });

  // Forward to IM stream if active (for interactive approval cards)
  if (imStreamCallback) {
    imStreamCallback('permission-request', JSON.stringify({ requestId, toolName, input: inputPreview }));
  }

  // Wait for user response or abort
  return new Promise((resolve) => {
    const cleanup = () => {
      pendingPermissions.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      console.debug(`[permission] ${toolName}: aborted by SDK signal, denying`);
      cleanup();
      resolve('deny');
    };

    // Listen for SDK abort signal
    signal?.addEventListener('abort', onAbort);

    // Timeout after 10 minutes (consistent with AskUserQuestion timeout)
    const timer = setTimeout(() => {
      if (pendingPermissions.has(requestId)) {
        cleanup();
        console.warn(`[permission] ${toolName}: timed out after 10 minutes, denying`);
        resolve('deny');
      }
    }, 10 * 60 * 1000);

    pendingPermissions.set(requestId, { resolve, toolName, input, timer });
  });
}

/**
 * Handle user's permission response from frontend
 */
export function handlePermissionResponse(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow'
): boolean {
  console.debug(`[permission] handlePermissionResponse: requestId=${requestId}, decision=${decision}`);

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.warn(`[permission] Unknown permission request: ${requestId}`);
    return false;
  }

  // Clear the timeout timer to prevent memory leak
  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);

  if (decision === 'deny') {
    console.log(`[permission] ${pending.toolName}: user denied`);
    pending.resolve('deny');
  } else if (decision === 'allow_once' || decision === 'always_allow') {
    if (decision === 'always_allow') {
      console.log(`[permission] ${pending.toolName}: user granted session permission`);
      sessionAlwaysAllowed.add(pending.toolName);
    } else {
      console.log(`[permission] ${pending.toolName}: user allowed once`);
    }
    pending.resolve('allow');

    // Cascade: auto-approve all other pending requests for the same tool.
    // The frontend only shows one permission card at a time. When multiple requests
    // for the same tool arrive in parallel (e.g., 3 WebSearch calls), the others
    // are invisible to the user and would be stuck until the 10-minute timeout.
    // Since the user already approved this tool (once or always), approve them all.
    for (const [otherId, otherPending] of pendingPermissions) {
      if (otherPending.toolName === pending.toolName) {
        console.log(`[permission] ${otherPending.toolName}: cascade auto-approved (requestId=${otherId})`);
        clearTimeout(otherPending.timer);
        pendingPermissions.delete(otherId);
        otherPending.resolve('allow');
      }
    }
  }

  return true;
}

/**
 * Clear session permission state (call when session ends)
 */
export function clearSessionPermissions(): void {
  sessionAlwaysAllowed.clear();
  pendingPermissions.clear();
  pendingAskUserQuestions.clear();
}

/**
 * Get pending interactive requests (permission + ask-user-question).
 * Used to replay these to newly connected SSE clients (e.g., Tab joining shared session).
 */
export function getPendingInteractiveRequests(): Array<{
  type: 'permission:request' | 'ask-user-question:request';
  data: unknown;
}> {
  const result: Array<{ type: 'permission:request' | 'ask-user-question:request'; data: unknown }> = [];
  for (const [requestId, p] of pendingPermissions) {
    result.push({
      type: 'permission:request',
      data: {
        requestId,
        toolName: p.toolName,
        input: typeof p.input === 'object' ? JSON.stringify(p.input).slice(0, 500) : String(p.input).slice(0, 500),
      },
    });
  }
  for (const [requestId, q] of pendingAskUserQuestions) {
    result.push({
      type: 'ask-user-question:request',
      data: { requestId, questions: q.input.questions },
    });
  }
  return result;
}

/**
 * Persist messages to SessionStore for session recovery
 * @param lastAssistantUsage - Usage info for the last assistant message (on message complete)
 * @param lastAssistantToolCount - Tool count for the last assistant message
 * @param lastAssistantDurationMs - Duration for the last assistant response
 */
function persistMessagesToStorage(
  lastAssistantUsage?: MessageUsage,
  lastAssistantToolCount?: number,
  lastAssistantDurationMs?: number
): void {
  const sessionMessages: SessionMessage[] = messages.map((msg, index) => {
    const isLastAssistant = index === messages.length - 1 && msg.role === 'assistant';
    // Strip Playwright tool results from disk persistence (keep in-memory data for SDK context)
    const contentForDisk = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(stripPlaywrightResults(msg.content));
    return {
      id: msg.id,
      role: msg.role,
      content: contentForDisk,
      timestamp: msg.timestamp,
      sdkUuid: msg.sdkUuid,
      attachments: msg.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        path: att.relativePath ?? '', // Map relativePath to path for storage
      })),
      metadata: msg.metadata,
      // Attach usage info only to the last assistant message if provided
      usage: isLastAssistant && lastAssistantUsage ? lastAssistantUsage : undefined,
      toolCount: isLastAssistant && lastAssistantToolCount ? lastAssistantToolCount : undefined,
      durationMs: isLastAssistant && lastAssistantDurationMs ? lastAssistantDurationMs : undefined,
    };
  });
  saveSessionMessages(sessionId, sessionMessages);
  // Update lastActiveAt
  updateSessionMetadata(sessionId, { lastActiveAt: new Date().toISOString() });
}

export function getSessionId(): string {
  return sessionId;
}

/** Localize SDK/system error messages for IM end-users */
function localizeImError(rawError: string): string {
  if (!rawError) return '模型处理消息时出错';

  // Image content not supported by model
  if (rawError.includes('unknown variant') && rawError.includes('image')) {
    return '当前模型不支持图片，请发送文字消息';
  }
  // Model validation error (SDK rejects unknown model for the configured provider)
  if (rawError.includes('issue with the selected model')) {
    return '所选模型不可用，请检查 IM Bot 的模型和供应商配置';
  }
  // SDK subprocess crashed (Windows: anti-virus, OOM, etc.)
  if (rawError.includes('process exited with code') || rawError.includes('process terminated')) {
    return 'AI 引擎异常退出，正在自动恢复，请稍后重试';
  }
  // API authentication errors
  if (rawError.includes('authentication') || rawError.includes('unauthorized') || rawError.includes('401')) {
    return 'API 认证失败，请检查 API Key 配置';
  }
  // Rate limiting
  if (rawError.includes('rate_limit') || rawError.includes('429')) {
    return 'API 请求频率超限，请稍后重试';
  }
  // Billing errors
  if (rawError.includes('billing') || rawError.includes('insufficient_quota') || rawError.includes('quota_exceeded')) {
    return 'API 余额不足，请充值后重试';
  }
  // Server overloaded
  if (rawError.includes('overloaded') || rawError.includes('503')) {
    return 'AI 服务繁忙，请稍后重试';
  }
  // Callback replaced
  if (rawError.includes('Replaced by a newer') || rawError.includes('消息处理被新请求取代')) {
    return '消息处理被新请求取代，请重新发送';
  }
  // Default: truncate long API errors for readability
  if (rawError.length > 100) {
    return rawError.substring(0, 100) + '...';
  }
  return rawError;
}

export function setImStreamCallback(cb: ImStreamCallback | null): void {
  // Defense-in-depth: if there's already an active callback when setting a new one,
  // notify the old callback with an error so its SSE stream terminates cleanly.
  // This should not happen when peer_locks are properly used, but guards against
  // silent callback replacement that would leave the old SSE stream hanging.
  if (cb !== null && imStreamCallback !== null) {
    console.warn('[agent] setImStreamCallback: replacing active callback — notifying old stream');
    try {
      imStreamCallback('error', '消息处理被新请求取代');
    } catch { /* old stream may already be closed */ }
  }
  imStreamCallback = cb;
}

function resetAbortFlag(): void {
  shouldAbortSession = false;
}

export function resolveClaudeCodeCli(): string {
  try {
    const cliPath = requireModule.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (cliPath.includes('app.asar')) {
      const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpackedPath)) {
        return unpackedPath;
      }
    }
    return cliPath;
  } catch (error) {
    // Fallback for bundled environment (Production)
    // We copy claude-agent-sdk to src-tauri/resources/claude-agent-sdk during build
    // process.cwd() is set to resources directory by sidecar.rs
    const bundledPath = join(process.cwd(), 'claude-agent-sdk', 'cli.js');
    if (existsSync(bundledPath)) {
      console.log(`[resolveClaudeCodeCli] Using bundled SDK at: ${bundledPath}`);
      return bundledPath;
    }
    console.error(`[resolveClaudeCodeCli] Failed to resolve SDK. Bundled path not found: ${bundledPath}`);
    throw error;
  }
}

/**
 * Build environment for Claude session
 * @param providerEnv - Optional provider environment override (for verification or external calls)
 */
export function buildClaudeSessionEnv(providerEnv?: ProviderEnv): NodeJS.ProcessEnv {
  // Ensure essential paths are always present, even when launched from Finder
  // (Finder launches via launchd which doesn't inherit shell environment variables)
  const { home } = getCrossPlatformEnv();
  const isDebug = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

  // Cross-platform PATH separator
  const PATH_SEP = process.platform === 'win32' ? ';' : ':';
  const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

  // Detect bundled bun directory using shared utility from runtime.ts
  // This ensures consistent path detection across the codebase (DRY principle)
  const isWindows = process.platform === 'win32';
  const bundledBunDir = getBundledBunDir();

  if (isDebug) {
    console.log('[env] Script directory:', getScriptDir());
    console.log(`[env] Checking bundled bun: ${bundledBunDir || 'NOT FOUND'} -> ${bundledBunDir ? 'EXISTS' : 'NOT FOUND'}`);
  }

  // Build essential paths based on platform
  const essentialPaths: string[] = [];

  // Bundled bun directory (highest priority)
  if (bundledBunDir) {
    essentialPaths.push(bundledBunDir);
  }

  // System bun/runtime installations (fallback)
  if (isWindows) {
    // Windows paths
    if (home) {
      essentialPaths.push(resolve(home, '.bun', 'bin'));
    }
  } else {
    // macOS/Linux paths
    if (home) {
      essentialPaths.push(`${home}/.bun/bin`);
    }
    essentialPaths.push('/opt/homebrew/bin');
    essentialPaths.push('/usr/local/bin');
    essentialPaths.push('/usr/bin');
    essentialPaths.push('/bin');
  }

  const existingPath = process.env[PATH_KEY] || process.env.PATH || '';
  if (isDebug) console.log('[env] Original PATH:', existingPath.substring(0, 200) + (existingPath.length > 200 ? '...' : ''));

  const pathParts = existingPath ? existingPath.split(PATH_SEP) : [];

  // Add essential paths if not already present (in reverse order so first in list ends up first in PATH)
  // Use case-insensitive comparison on Windows since paths are case-insensitive
  const pathIncludes = (parts: string[], path: string): boolean => {
    if (isWindows) {
      const lowerPath = path.toLowerCase();
      return parts.some(p => p.toLowerCase() === lowerPath);
    }
    return parts.includes(path);
  };

  for (const p of [...essentialPaths].reverse()) {
    if (p && !pathIncludes(pathParts, p)) {
      pathParts.unshift(p);
    }
  }

  const finalPath = pathParts.join(PATH_SEP);
  if (isDebug) {
    console.log('[env] Final PATH (first 5 entries):', pathParts.slice(0, 5).join(PATH_SEP));
    console.log('[env] Bundled bun will be used:', bundledBunDir ? 'YES' : 'NO (using system bun)');
  }

  // Build base environment
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PATH_KEY]: finalPath,
  };

  // Use provided providerEnv or fall back to currentProviderEnv
  const effectiveProviderEnv = providerEnv ?? currentProviderEnv;

  // Handle provider-specific environment variables
  // IMPORTANT: Must explicitly delete these when switching back to Anthropic subscription
  // to avoid using stale third-party provider settings
  if (effectiveProviderEnv?.baseUrl) {
    env.ANTHROPIC_BASE_URL = effectiveProviderEnv.baseUrl;
    console.log(`[env] ANTHROPIC_BASE_URL set to: ${effectiveProviderEnv.baseUrl}`);
  } else {
    // Clear any previously set third-party baseUrl
    delete env.ANTHROPIC_BASE_URL;
    console.log('[env] ANTHROPIC_BASE_URL cleared (using Anthropic default)');
  }

  if (effectiveProviderEnv?.apiKey) {
    // Set auth based on authType setting
    const authType = effectiveProviderEnv.authType ?? 'both'; // Default to 'both' for backward compatibility

    switch (authType) {
      case 'auth_token':
        // Only set AUTH_TOKEN, delete API_KEY
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        delete env.ANTHROPIC_API_KEY;
        console.log('[env] ANTHROPIC_AUTH_TOKEN set (authType: auth_token)');
        break;
      case 'api_key':
        // Only set API_KEY, delete AUTH_TOKEN
        delete env.ANTHROPIC_AUTH_TOKEN;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_API_KEY set (authType: api_key)');
        break;
      case 'auth_token_clear_api_key':
        // Set AUTH_TOKEN and explicitly set API_KEY to empty string (required by OpenRouter)
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = '';
        console.log('[env] ANTHROPIC_AUTH_TOKEN set, ANTHROPIC_API_KEY cleared (authType: auth_token_clear_api_key)');
        break;
      case 'both':
      default:
        // Set both variants for compatibility with different SDK versions
        env.ANTHROPIC_AUTH_TOKEN = effectiveProviderEnv.apiKey;
        env.ANTHROPIC_API_KEY = effectiveProviderEnv.apiKey;
        console.log('[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY both set (authType: both)');
        break;
    }
  } else {
    // Clear any previously set third-party apiKey, let SDK use default auth
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    console.log('[env] ANTHROPIC_AUTH_TOKEN cleared (using default auth)');
  }

  return env;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => safeStringify(item));
}

function parseSystemInitInfo(message: unknown): SystemInitInfo | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    type: asString(record.type),
    subtype: asString(record.subtype),
    cwd: asString(record.cwd),
    session_id: asString(record.session_id),
    tools: asStringArray(record.tools),
    mcp_servers: asStringArray(record.mcp_servers),
    model: asString(record.model),
    permissionMode: asString(record.permissionMode),
    slash_commands: asStringArray(record.slash_commands),
    apiKeySource: asString(record.apiKeySource),
    claude_code_version: asString(record.claude_code_version),
    output_style: asString(record.output_style),
    agents: asStringArray(record.agents),
    skills: asStringArray(record.skills),
    plugins: asStringArray(record.plugins),
    uuid: asString(record.uuid)
  };
}

/**
 * Parse SDK status message (e.g., compacting)
 * Returns { isStatusMessage, status } to distinguish between:
 * - Not a status message at all (isStatusMessage: false)
 * - A status message with status: null (clearing the status)
 * - A status message with status: 'compacting' etc.
 */
function parseSystemStatus(message: unknown): { isStatusMessage: boolean; status: string | null } {
  if (!message || typeof message !== 'object') {
    return { isStatusMessage: false, status: null };
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'status') {
    return { isStatusMessage: false, status: null };
  }
  // This IS a status message, status can be 'compacting' or null
  return {
    isStatusMessage: true,
    status: typeof record.status === 'string' ? record.status : null
  };
}

function setSessionState(nextState: SessionState): void {
  if (sessionState === nextState) {
    return;
  }
  sessionState = nextState;
  broadcast('chat:status', { sessionState });
}

function ensureAssistantMessage(): MessageWire {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant' && isStreamingMessage) {
    return lastMessage;
  }
  const assistant: MessageWire = {
    id: String(messageSequence++),
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  };
  messages.push(assistant);
  isStreamingMessage = true;
  return assistant;
}

function ensureContentArray(message: MessageWire): ContentBlock[] {
  if (typeof message.content === 'string') {
    const contentArray: ContentBlock[] = [];
    if (message.content) {
      contentArray.push({ type: 'text', text: message.content });
    }
    message.content = contentArray;
    return contentArray;
  }
  return message.content;
}

/**
 * Check if text is a decorative wrapper from third-party APIs (e.g., 智谱 GLM-4.7)
 * These APIs wrap server_tool_use with decorative text blocks that shouldn't be displayed
 *
 * IMPORTANT: This function must be very precise to avoid filtering legitimate content.
 * We require MULTIPLE specific markers to be present before filtering.
 *
 * @returns { filtered: boolean, reason?: string } - reason is for debugging
 */
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  // Safety: never filter very short or very long text
  if (!text || text.length < DECORATIVE_TEXT_MIN_LENGTH || text.length > DECORATIVE_TEXT_MAX_LENGTH) {
    return { filtered: false };
  }

  const trimmed = text.trim();

  // Pattern 1: 智谱 GLM-4.7 tool invocation wrapper
  // Must have ALL of these markers (very specific combination):
  // - "🌐 Z.ai Built-in Tool:" or "Z.ai Built-in Tool:"
  // - "**Input:**" (markdown bold)
  // - Either "```json" or "Executing on server"
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');

  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 GLM-4.7 tool output wrapper
  // Must have ALL of these markers:
  // - Starts with "**Output:**"
  // - Contains "_result_summary:" (specific to Zhipu's format)
  // - Contains JSON-like content (starts with "[" or "{")
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    // Additional check: should contain JSON-like structure
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}

function appendTextChunk(chunk: string): void {
  // Filter out decorative text from third-party APIs (e.g., 智谱 GLM-4.7)
  const decorativeCheck = checkDecorativeToolText(chunk);
  if (decorativeCheck.filtered) {
    console.log(`[agent] Filtered decorative text (${decorativeCheck.reason}), length=${chunk.length}`);
    return;
  }

  const message = ensureAssistantMessage();
  if (typeof message.content === 'string') {
    message.content += chunk;
    return;
  }
  const contentArray = message.content;
  const lastBlock = contentArray[contentArray.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.text = `${lastBlock.text ?? ''}${chunk}`;
  } else {
    contentArray.push({ type: 'text', text: chunk });
  }
}

function handleThinkingStart(index: number): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'thinking',
    thinking: '',
    thinkingStreamIndex: index,
    thinkingStartedAt: Date.now()
  });
}

function handleThinkingChunk(index: number, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.thinking = `${thinkingBlock.thinking ?? ''}${delta}`;
  }
}

function handleToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
}): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'tool_use',
    tool: {
      ...tool,
      inputJson: ''
    }
  });
  // Increment tool count for this turn
  currentTurnToolCount++;
}

/**
 * Handle server_tool_use content block start
 * server_tool_use is a tool executed by the API provider (e.g., 智谱 GLM-4.7's webReader)
 * Unlike tool_use (client-side MCP tools), these run on the server and results come back in the stream
 */
function handleServerToolUseStart(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
}): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  contentArray.push({
    type: 'server_tool_use',
    tool: {
      ...tool,
      inputJson: JSON.stringify(tool.input, null, 2), // Server tools come with complete input
      parsedInput: tool.input as unknown as ToolInput
    }
  });
  // Server tools also count towards tool usage
  currentTurnToolCount++;
}

function handleSubagentToolUseStart(
  parentToolUseId: string,
  tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    streamIndex?: number;
  }
): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  childToolToParent.set(tool.id, parentToolUseId);
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === tool.id);
  if (existing) {
    existing.name = tool.name;
    existing.input = tool.input;
    existing.streamIndex = tool.streamIndex;
    return;
  }
  parentTool.tool.subagentCalls.push({
    id: tool.id,
    name: tool.name,
    input: tool.input,
    streamIndex: tool.streamIndex,
    inputJson: JSON.stringify(tool.input, null, 2),
    isLoading: true
  });
}

function ensureSubagentToolPlaceholder(parentToolUseId: string, toolUseId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (existing) {
    return;
  }
  childToolToParent.set(toolUseId, parentToolUseId);
  parentTool.tool.subagentCalls.push({
    id: toolUseId,
    name: 'Tool',
    input: {},
    inputJson: '{}',
    isLoading: true
  });
}

function handleToolInputDelta(index: number, toolId: string, delta: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const toolBlock = contentArray.find(
    (block) => block.type === 'tool_use' && block.tool?.id === toolId
  );
  if (!toolBlock || toolBlock.type !== 'tool_use' || !toolBlock.tool) {
    return;
  }
  const newInputJson = `${toolBlock.tool.inputJson ?? ''}${delta}`;
  toolBlock.tool.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    toolBlock.tool.parsedInput = parsedInput;
  }
}

function handleSubagentToolInputDelta(
  parentToolUseId: string,
  toolId: string,
  delta: string
): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall) {
    return;
  }
  const newInputJson = `${subCall.inputJson ?? ''}${delta}`;
  subCall.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    subCall.parsedInput = parsedInput;
  }
}

function finalizeSubagentToolInput(parentToolUseId: string, toolId: string): void {
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall?.inputJson) {
    return;
  }
  try {
    subCall.parsedInput = JSON.parse(subCall.inputJson) as ToolInput;
  } catch {
    const parsed = parsePartialJson<ToolInput>(subCall.inputJson);
    if (parsed) {
      subCall.parsedInput = parsed;
    }
  }
}

function handleContentBlockStop(index: number, toolId?: string): void {
  const message = ensureAssistantMessage();
  const contentArray = ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.isComplete = true;
    thinkingBlock.thinkingDurationMs =
      thinkingBlock.thinkingStartedAt ? Date.now() - thinkingBlock.thinkingStartedAt : undefined;
    return;
  }

  const toolBlock =
    toolId ?
      contentArray.find((block) => block.type === 'tool_use' && block.tool?.id === toolId)
      : contentArray.find((block) => block.type === 'tool_use' && block.tool?.streamIndex === index);

  if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool?.inputJson) {
    try {
      toolBlock.tool.parsedInput = JSON.parse(toolBlock.tool.inputJson) as ToolInput;
    } catch {
      const parsed = parsePartialJson<ToolInput>(toolBlock.tool.inputJson);
      if (parsed) {
        toolBlock.tool.parsedInput = parsed;
      }
    }
  }
}

function handleToolResultStart(toolUseId: string, content: string, isError: boolean): void {
  if (handleSubagentToolResultStart(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

function handleToolResultComplete(toolUseId: string, content: string, isError?: boolean): void {
  if (handleSubagentToolResultComplete(toolUseId, content, isError)) {
    return;
  }
  setToolResult(toolUseId, content, isError);
}

function handleMessageComplete(): void {
  isStreamingMessage = false;
  // Notify IM stream: turn complete
  if (imStreamCallback) {
    imStreamCallback('complete', '');
    imStreamCallback = null;
  }
  // 跨回合状态清理（持久 session 下多回合共享同一个 for-await 循环）
  // SDK 的 stream event index 是 per-message 的，不同回合的 index 可能冲突
  streamIndexToToolId.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();
  clearCronTaskContext();

  // Only transition to idle if no queued messages waiting.
  if (messageQueue.length === 0) {
    setSessionState('idle');
  }

  // Calculate duration for this turn
  const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;

  // Persist messages with usage info after AI response completes
  persistMessagesToStorage({
    inputTokens: currentTurnUsage.inputTokens,
    outputTokens: currentTurnUsage.outputTokens,
    cacheReadTokens: currentTurnUsage.cacheReadTokens || undefined,
    cacheCreationTokens: currentTurnUsage.cacheCreationTokens || undefined,
    model: currentTurnUsage.model,
    modelUsage: currentTurnUsage.modelUsage,
  }, currentTurnToolCount, durationMs);
}

function handleMessageStopped(): void {
  isStreamingMessage = false;
  // Notify IM stream: turn complete (stopped)
  if (imStreamCallback) {
    imStreamCallback('complete', '');
    imStreamCallback = null;
  }
  // 跨回合状态清理（与 handleMessageComplete 保持一致）
  streamIndexToToolId.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();

  // Only transition to idle if no queued messages waiting (same logic as handleMessageComplete)
  if (messageQueue.length === 0) {
    setSessionState('idle');
  }
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant' || typeof lastMessage.content === 'string') {
    // Persist even if no assistant message
    persistMessagesToStorage();
    return;
  }
  lastMessage.content = lastMessage.content.map((block) => {
    if (block.type === 'thinking' && !block.isComplete) {
      return {
        ...block,
        isComplete: true,
        thinkingDurationMs:
          block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
      };
    }
    return block;
  });
  // Persist after processing message
  persistMessagesToStorage();
}

function handleMessageError(error: string): void {
  isStreamingMessage = false;
  // Notify IM stream: localized error
  if (imStreamCallback) {
    imStreamCallback('error', localizeImError(error));
    imStreamCallback = null;
  }
  setSessionState('idle');

  // Don't persist expected termination signals as errors
  // These occur during normal session switching or app shutdown
  const isExpectedTermination =
    error.includes('SIGTERM') ||
    error.includes('SIGKILL') ||
    error.includes('SIGINT') ||
    error.includes('process terminated') ||
    error.includes('AbortError');

  if (isExpectedTermination) {
    console.log('[agent] Skipping error persistence for expected termination:', error);
    return;
  }

  messages.push({
    id: String(messageSequence++),
    role: 'assistant',
    content: `Error: ${error}`,
    timestamp: new Date().toISOString()
  });
  // Persist error message
  persistMessagesToStorage();
}

function findToolBlockById(toolUseId: string): { tool: ToolUseState } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    if (typeof message.content === 'string') {
      continue;
    }
    const toolBlock = message.content.find(
      (block) => block.type === 'tool_use' && block.tool?.id === toolUseId
    );
    if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool) {
      return { tool: toolBlock.tool };
    }
  }
  return null;
}

/** Sentinel value for stripped Playwright tool results (truthy, so ProcessRow sees tool as complete) */
const PLAYWRIGHT_RESULT_SENTINEL = '[playwright_result_stripped]';

/** Set of tool_use IDs whose results are stripped from frontend broadcast in the current turn */
const strippedToolResultIds = new Set<string>();

function isPlaywrightTool(toolUseId: string): boolean {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.name.startsWith('mcp__playwright__') ?? false;
}

/**
 * Strip Playwright tool results from ContentBlock[] for frontend/persistence.
 * Replaces tool.result with a sentinel so ProcessRow still sees the tool as complete.
 * Keeps in-memory SDK data intact for conversation context.
 */
export function stripPlaywrightResults(content: ContentBlock[]): ContentBlock[] {
  return content.map(block => {
    if (
      block.type === 'tool_use' &&
      block.tool?.name.startsWith('mcp__playwright__') &&
      block.tool.result &&
      block.tool.result !== PLAYWRIGHT_RESULT_SENTINEL
    ) {
      return { ...block, tool: { ...block.tool, result: PLAYWRIGHT_RESULT_SENTINEL } };
    }
    return block;
  });
}

function appendToolResultDelta(toolUseId: string, delta: string): void {
  if (appendSubagentToolResultDelta(toolUseId, delta)) {
    return;
  }
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = `${toolBlock.tool.result ?? ''}${delta}`;
}

function handleSubagentToolResultStart(
  toolUseId: string,
  content: string,
  isError: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  subCall.isError = isError;
  subCall.isLoading = true;
  return true;
}

function handleSubagentToolResultComplete(
  toolUseId: string,
  content: string,
  isError?: boolean
): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  if (typeof isError === 'boolean') {
    subCall.isError = isError;
  }
  subCall.isLoading = false;
  return true;
}

function appendSubagentToolResultDelta(toolUseId: string, delta: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = `${subCall.result ?? ''}${delta}`;
  subCall.isLoading = true;
  return true;
}

function finalizeSubagentToolResult(toolUseId: string): boolean {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.isLoading = false;
  return true;
}

function getSubagentToolResult(toolUseId: string): string | undefined {
  const parentToolUseId = childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return undefined;
  }
  const parentTool = findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return undefined;
  }
  return parentTool.tool.subagentCalls.find((call) => call.id === toolUseId)?.result;
}

function setToolResult(toolUseId: string, content: string, isError?: boolean): void {
  const toolBlock = findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = content;
  if (typeof isError === 'boolean') {
    toolBlock.tool.isError = isError;
  }
}

function getToolResult(toolUseId: string): string | undefined {
  const toolBlock = findToolBlockById(toolUseId);
  return toolBlock?.tool.result;
}

function appendToolResultContent(toolUseId: string, content: string, isError?: boolean): string {
  const existing = getToolResult(toolUseId);
  const next = existing ? `${existing}\n${content}` : content;
  setToolResult(toolUseId, next, isError);
  return next;
}

function formatAssistantContent(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ('type' in block && block.type === 'text' && 'text' in block) {
      parts.push(String(block.text ?? ''));
      continue;
    }
    if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
      const text = String(block.thinking ?? '').trim();
      if (text) {
        parts.push(`Thinking:\n${text}`);
      }
      continue;
    }
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Append log line and broadcast to frontend
 */
function appendLogLine(line: string): void {
  appendLog(line);
  broadcast('chat:log', line);
}

function extractAgentErrorFromContent(content: unknown): string | null {
  const text = formatAssistantContent(content);
  if (!text) {
    return null;
  }
  if (/api error|authentication_error|unauthorized|forbidden/i.test(text)) {
    return text;
  }
  return null;
}

function extractAgentError(sdkMessage: unknown): string | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  const candidate = (sdkMessage as { error?: unknown }).error;
  if (candidate) {
    if (typeof candidate === 'string') {
      return candidate;
    }
    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  if (
    'type' in sdkMessage &&
    (sdkMessage as { type?: string }).type === 'assistant' &&
    'message' in sdkMessage
  ) {
    const assistantMessage = (sdkMessage as { message?: { content?: unknown } }).message;
    return extractAgentErrorFromContent(assistantMessage?.content);
  }

  return null;
}

export function getAgentState(): {
  agentDir: string;
  sessionState: SessionState;
  hasInitialPrompt: boolean;
} {
  return { agentDir, sessionState, hasInitialPrompt };
}

export function getSystemInitInfo(): SystemInitInfo | null {
  return systemInitInfo;
}

export function getLogLines(): string[] {
  return getLogLinesFromLogger();
}

export function getMessages(): MessageWire[] {
  return messages;
}

/**
 * Internal: Clear all message-related state
 * Used by both resetSession() and initializeAgent()
 */
function clearMessageState(): void {
  messages.length = 0;
  messageQueue.length = 0;
  streamIndexToToolId.clear();
  toolResultIndexToId.clear();
  childToolToParent.clear();
  imTextBlockIndices.clear();
  strippedToolResultIds.clear();
  isStreamingMessage = false;
  messageSequence = 0;
  pendingConfigRestart = false;
}

/**
 * Load persisted messages from SessionMessage[] into in-memory messages[].
 * Sets messageSequence to continue from the last stored message ID.
 * Used by initializeAgent (resume) and switchToSession to restore conversation state.
 */
function loadMessagesFromStorage(storedMessages: SessionMessage[]): void {
  for (const storedMsg of storedMessages) {
    let parsedContent: string | ContentBlock[] = storedMsg.content;
    if (storedMsg.content.startsWith('[')) {
      try {
        const parsed = JSON.parse(storedMsg.content);
        if (Array.isArray(parsed)) {
          parsedContent = parsed as ContentBlock[];
        }
      } catch {
        // Keep as string if parse fails
      }
    }
    messages.push({
      id: storedMsg.id,
      role: storedMsg.role,
      content: parsedContent,
      timestamp: storedMsg.timestamp,
      sdkUuid: storedMsg.sdkUuid,
      attachments: storedMsg.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        size: 0,
        mimeType: att.mimeType,
        relativePath: att.path,
      })),
      metadata: storedMsg.metadata,
    });
  }
  // Update messageSequence to continue from the last message
  if (storedMessages.length > 0) {
    const lastMsgId = storedMessages[storedMessages.length - 1].id;
    const parsedId = parseInt(lastMsgId, 10);
    if (!isNaN(parsedId)) {
      messageSequence = parsedId + 1;
    }
  }
}

/**
 * Reset the current session for "new conversation" functionality
 * This FULLY terminates the SDK session and clears all state
 * Call this from frontend when user clicks "新对话"
 *
 * IMPORTANT: Must properly terminate SDK session to prevent context leakage.
 * Simply interrupting is not enough - we must wait for the session to fully end.
 */
export async function resetSession(): Promise<void> {
  console.log('[agent] resetSession: starting new conversation');

  // 1. Properly terminate the SDK session (same pattern as switchToSession)
  // Must abort persistent session so the generator exits and subprocess terminates
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] resetSession: terminating existing SDK session');
    abortPersistentSession();
    messageQueue.length = 0; // Clear queue so old session doesn't pick up stale messages

    // Wait for the session to fully terminate
    if (sessionTerminationPromise) {
      try {
        await sessionTerminationPromise;
        console.log('[agent] resetSession: SDK session terminated');
      } catch (error) {
        console.warn('[agent] resetSession: session termination error:', error);
      }
    }
    querySession = null;
  }

  // 1b. Persist in-memory messages from the old session before clearing.
  // If streaming was aborted mid-turn, handleMessageComplete was never called,
  // so these messages exist only in memory. Persist them to prevent data loss
  // in the old session (user may revisit it from history).
  // sessionId still points to the OLD session here (updated in step 3).
  if (messages.length > 0) {
    console.log(`[agent] resetSession: persisting ${messages.length} in-memory messages before clearing`);
    persistMessagesToStorage();
  }

  // 2. Clear all message state (shared with initializeAgent)
  clearMessageState();

  // 3. Generate new session ID (don't persist yet - wait for first message)
  sessionId = randomUUID();
  hasInitialPrompt = false; // Reset so first message creates a new session in SessionStore

  // 4. Clear SDK resume state - CRITICAL: prevents SDK from resuming old context!
  sessionRegistered = false;
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to new session
  messageResolver = null;
  resolveTurnComplete = null;
  systemInitInfo = null; // Clear old system info so new session gets fresh init

  // 4b. Clear sub-agent definitions (will be re-set by frontend if needed)
  currentAgentDefinitions = null;

  // 5. Clear SDK ready signal state (same as switchToSession)
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // 6. Clear pre-warm state
  isPreWarming = false;
  preWarmFailCount = 0;
  if (preWarmTimer) { clearTimeout(preWarmTimer); preWarmTimer = null; }

  // 7. Reset processing state
  shouldAbortSession = false;
  isProcessing = false;
  setSessionState('idle');

  // 8. Clear session-scoped permissions
  clearSessionPermissions();

  // 9. Broadcast empty state to frontend
  broadcast('chat:init', { agentDir, sessionState: 'idle', hasInitialPrompt: false });

  console.log('[agent] resetSession: complete, new sessionId=' + sessionId);

  // Pre-warm with fresh session so next message is fast
  schedulePreWarm();
}

/**
 * Initialize agent with a new working directory
 * Called when switching to a different project/workspace
 */
export async function initializeAgent(
  nextAgentDir: string,
  initialPrompt?: string | null,
  initialSessionId?: string,
): Promise<void> {
  agentDir = nextAgentDir;
  hasInitialPrompt = Boolean(initialPrompt && initialPrompt.trim());
  systemInitInfo = null;

  if (initialSessionId) {
    // Use caller-specified session_id (IM / Tab opening existing session / CronTask)
    sessionId = initialSessionId as typeof sessionId;

    // Check if this session has any prior metadata → decide resume vs create.
    // We check for metadata existence (not just sdkSessionId) because sdkSessionId
    // is only written after system_init succeeds. If the previous Bun process crashed
    // before system_init, metadata exists (with unifiedSession:true) but sdkSessionId
    // is absent — yet the SDK session directory already exists on disk.
    const meta = getSessionMetadata(initialSessionId);
    if (meta) {
      sessionRegistered = true;
      console.log(`[agent] initializeAgent: will resume session ${initialSessionId} (sdkSessionId=${meta.sdkSessionId ?? 'unknown'})`);
    } else {
      sessionRegistered = false;
      console.log(`[agent] initializeAgent: will create new session ${initialSessionId}`);
    }
  } else {
    // No specified ID → auto-generate (standard Tab new conversation flow)
    sessionId = randomUUID();
    sessionRegistered = false; // Fresh session, no SDK data to resume
  }

  // Clear message state (shared with resetSession)
  clearMessageState();

  // For resume sessions: load existing messages from disk into memory.
  // This is critical for shared Sidecar (IM + Desktop Tab):
  // 1. SSE replay (chat:message-replay) includes old messages when Tab connects
  // 2. messageSequence continues from last ID (prevents ID collision with disk messages)
  // 3. saveSessionMessages incremental append works correctly (messages.slice(existingCount))
  // Same pattern as switchToSession's message loading.
  if (initialSessionId && sessionRegistered) {
    const sessionData = getSessionData(initialSessionId);
    if (sessionData?.messages?.length) {
      loadMessagesFromStorage(sessionData.messages);
      console.log(`[agent] initializeAgent: loaded ${sessionData.messages.length} existing messages, messageSequence=${messageSequence}`);
    }
  }

  // Initialize logger for new session (lazy file creation)
  initLogger(sessionId);
  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'} sessionId=${sessionId} resume=${sessionRegistered}`);
  if (hasInitialPrompt) {
    void enqueueUserMessage(initialPrompt!.trim());
  } else {
    // Pre-warm subprocess + MCP so first message is fast
    schedulePreWarm();
  }
}

/**
 * Switch to an existing session for resume functionality
 * This terminates the current session and prepares to resume from the target session
 * 
 * Key behavior:
 * - Preserves target sessionId so messages are saved to the same session
 * - Sets sessionRegistered if sdkSessionId exists so SDK continues conversation context
 * - If no sdkSessionId exists (old session), starts fresh but keeps same session ID
 */
export async function switchToSession(targetSessionId: string): Promise<boolean> {
  console.log(`[agent] switchToSession: ${targetSessionId}`);

  // Skip if already on the target session — prevents aborting an active streaming task
  // when frontend calls loadSession on the same session (e.g., after cron timeout)
  if (targetSessionId === sessionId) {
    console.log(`[agent] switchToSession: already on session ${targetSessionId}, skipping`);
    return true;
  }

  // Get the target session metadata to find SDK session_id
  const sessionMeta = getSessionMetadata(targetSessionId);
  if (!sessionMeta) {
    console.error(`[agent] switchToSession: session ${targetSessionId} not found`);
    return false;
  }

  // Properly terminate the old session if one is running
  // Must abort persistent session so the generator exits and subprocess terminates
  // Otherwise the old session continues processing messages with stale settings
  if (querySession || sessionTerminationPromise) {
    console.log('[agent] switchToSession: aborting current session');
    abortPersistentSession();
    messageQueue.length = 0; // Clear queue before waiting so old session doesn't pick up stale messages
    if (sessionTerminationPromise) {
      await sessionTerminationPromise;
    }
    querySession = null;
  }

  // Persist current in-memory messages before clearing to prevent data loss
  // (e.g., if an active streaming session accumulated messages not yet saved to disk)
  if (messages.length > 0) {
    console.log(`[agent] switchToSession: persisting ${messages.length} in-memory messages before clearing`);
    persistMessagesToStorage();
  }

  // Reset message/queue/streaming state (shared with initializeAgent, resetSession)
  clearMessageState();

  // Reset session-level runtime state
  shouldAbortSession = false;
  isProcessing = false;
  sessionRegistered = false; // Will re-set from sessionMeta below
  pendingResumeSessionAt = undefined; // Prevent leaking rewind state to different session
  messageResolver = null;
  resolveTurnComplete = null;
  setSessionState('idle');
  systemInitInfo = null;

  // Clear SDK ready signal state
  _sdkReadyResolve = null;
  _sdkReadyPromise = null;

  // Clear pre-warm state from old session
  isPreWarming = false;
  preWarmFailCount = 0;
  if (preWarmTimer) { clearTimeout(preWarmTimer); preWarmTimer = null; }

  // Preserve target sessionId so new messages are saved to the same session
  sessionId = targetSessionId as `${string}-${string}-${string}-${string}-${string}`;

  // Load existing messages from storage into memory
  // This is critical for incremental save logic in saveSessionMessages
  const sessionData = getSessionData(targetSessionId);
  if (sessionData?.messages?.length) {
    loadMessagesFromStorage(sessionData.messages);
    console.log(`[agent] switchToSession: loaded ${sessionData.messages.length} existing messages`);
  }

  // Set sessionRegistered based on whether SDK has this session
  if (sessionMeta.sdkSessionId) {
    // SDK 已注册此 session，后续 query 必须用 resume
    sessionRegistered = true;
    console.log(`[agent] switchToSession: will resume session ${sessionId}`);
  } else {
    // 从未 query 过的 session，用 sessionId 创建
    sessionRegistered = false;
    console.warn(`[agent] switchToSession: no SDK session_id, will start fresh`);
  }

  // Update agentDir from session
  if (sessionMeta.agentDir) {
    agentDir = sessionMeta.agentDir;
  }

  // Initialize logger for the target session (lazy file creation)
  initLogger(sessionId);

  // Session already exists, skip first-message session creation logic
  hasInitialPrompt = true;

  console.log(`[agent] switchToSession: ready, agentDir=${agentDir}, sessionRegistered=${sessionRegistered}`);

  // Pre-warm with resumed session so subprocess + MCP are ready before user types
  schedulePreWarm();
  return true;
}

type ImagePayload = {
  name: string;
  mimeType: string;
  data: string; // base64
};

/**
 * Apply runtime configuration changes to the active session.
 * Calls SDK setModel/setPermissionMode if config has changed.
 */
async function applySessionConfig(newModel?: string, newPermissionMode?: PermissionMode): Promise<void> {
  if (!querySession) {
    return;
  }

  // Apply permission mode change if different
  if (newPermissionMode && newPermissionMode !== currentPermissionMode) {
    const sdkMode = mapToSdkPermissionMode(newPermissionMode);
    try {
      await querySession.setPermissionMode(sdkMode);
      currentPermissionMode = newPermissionMode;
      console.log(`[agent] runtime permission mode switched to: ${newPermissionMode} (SDK: ${sdkMode})`);
    } catch (error) {
      console.error('[agent] failed to set permission mode:', error);
    }
  }

  // Apply model change if different
  if (newModel && newModel !== currentModel) {
    try {
      await querySession.setModel(newModel);
      currentModel = newModel;
      console.log(`[agent] runtime model switched to: ${newModel}`);
    } catch (error) {
      console.error('[agent] failed to set model:', error);
    }
  }
}

export type EnqueueResult = {
  queued: boolean;   // true if message was queued (not immediately processed)
  queueId?: string;  // queue item ID, present when queued=true
  error?: string;    // present when queue is full or other rejection
};

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  permissionMode?: PermissionMode,
  model?: string,
  providerEnv?: ProviderEnv,
  metadata?: { source: 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group'; sourceId?: string; senderName?: string },
): Promise<EnqueueResult> {
  // 等待进行中的时间回溯完成，防止并发写入 messages/session 状态
  if (rewindPromise) {
    await rewindPromise;
  }

  const trimmed = text.trim();
  const hasImages = images && images.length > 0;

  if (!trimmed && !hasImages) {
    return { queued: false };
  }

  // Session is "busy" if AI is streaming OR there are pending messages in the queue.
  // This prevents config changes and turn-usage resets during the brief gap between turns.
  const isSessionBusy = isStreamingMessage || messageQueue.length > 0;

  // Reset turn usage tracking — only for direct (non-queued) messages.
  // For queued messages, this is done in messageGenerator when the item is yielded,
  // to avoid corrupting the in-flight turn's usage counters.
  if (!isSessionBusy) {
    resetTurnUsage();
    currentTurnStartTime = Date.now();
  }

  // Check if provider has changed (requires session restart since environment vars can't be updated)
  // Also detect switching TO subscription (providerEnv=undefined) FROM an API provider
  // SKIP for queued messages: provider/model changes during streaming would cause a session
  // restart that wipes the queue and races with the active stream. Queued messages inherit
  // the current session's provider/model configuration.
  const switchingToSubscription = !isSessionBusy && !providerEnv && currentProviderEnv;
  const baseUrlChanged = switchingToSubscription ||
    (!isSessionBusy && providerEnv && providerEnv.baseUrl !== currentProviderEnv?.baseUrl);
  const providerChanged = baseUrlChanged || (!isSessionBusy && providerEnv && (
    providerEnv.apiKey !== currentProviderEnv?.apiKey
  ));

  if (providerChanged && querySession) {
    const fromLabel = currentProviderEnv?.baseUrl ?? 'anthropic';
    const toLabel = providerEnv?.baseUrl ?? 'anthropic';
    if (isDebugMode) console.log(`[agent] provider changed from ${fromLabel} to ${toLabel}, restarting session`);

    // Resume logic: Anthropic official validates thinking block signatures, third-party providers don't.
    // Only skip resume when switching FROM third-party (has baseUrl) TO Anthropic official (no baseUrl).
    // All other transitions (official→third-party, third-party→third-party, official→official) can safely resume.
    const switchingFromThirdPartyToAnthropic = currentProviderEnv?.baseUrl && !providerEnv?.baseUrl;
    if (switchingFromThirdPartyToAnthropic) {
      // Anthropic 官方验证 thinking block 签名，第三方不验证，必须新建 session
      sessionRegistered = false;
      sessionId = randomUUID();
      hasInitialPrompt = false;   // 确保新 session 创建 metadata
      messages.length = 0;        // 清除旧 provider 不兼容的消息
      systemInitInfo = null;      // 清除旧 init info
      console.log('[agent] Fresh session: third-party → Anthropic (signature incompatible)');
    }
    // 其他 provider 切换：sessionRegistered 保持不变，自动走正确路径

    // Update provider env BEFORE terminating so the new session picks it up
    currentProviderEnv = providerEnv; // undefined for subscription, object for API
    // Terminate current session - it will restart automatically when processing the message
    abortPersistentSession();
    // Wait for the current session to fully terminate before proceeding
    // This prevents race conditions where old session continues processing
    if (sessionTerminationPromise) {
      await sessionTerminationPromise;
    }
    querySession = null;
    isProcessing = false;
    setSessionState('idle');
    // Clear message queue to avoid duplicate messages
    // The current message will be added to the queue below
    messageQueue.length = 0;
    // Clear stream state mappings (will be rebuilt by new session)
    streamIndexToToolId.clear();
    toolResultIndexToId.clear();
    imTextBlockIndices.clear();
    if (isDebugMode) console.log(`[agent] session terminated for provider switch`);
  } else if (providerEnv) {
    // Provider not changed (or first message with API provider), just update tracking
    currentProviderEnv = providerEnv;
    if (isDebugMode) console.log(`[agent] provider env set: baseUrl=${providerEnv.baseUrl ?? 'anthropic'}`);
  } else if (!providerEnv && !currentProviderEnv) {
    // Both undefined — subscription mode, no change needed
    if (isDebugMode) console.log('[agent] subscription mode, no provider env');
  }

  // Apply runtime config changes if session is active (model/permission changes don't require restart)
  // Skip for queued messages — config is locked to the current session while streaming
  if (!isSessionBusy) {
    await applySessionConfig(model, permissionMode);

    // Update local tracking even if SDK call is skipped (first message)
    if (permissionMode && permissionMode !== currentPermissionMode) {
      currentPermissionMode = permissionMode;
      if (isDebugMode) console.log(`[agent] permission mode set to: ${permissionMode}`);
    }
    if (model && model !== currentModel) {
      currentModel = model;
      if (isDebugMode) console.log(`[agent] model set to: ${model}`);
    }
  }

  // Persist session to SessionStore on first message
  if (!hasInitialPrompt) {
    hasInitialPrompt = true;
    // Create and save session metadata
    const sessionMeta = createSessionMetadata(agentDir);
    sessionMeta.id = sessionId; // Use existing sessionId
    sessionMeta.title = trimmed ? trimmed.slice(0, 40) : '图片消息';
    if (sessionMeta.title.length < trimmed.length) {
      sessionMeta.title += '...';
    }
    saveSessionMetadata(sessionMeta);
    console.log(`[agent] session ${sessionId} persisted to SessionStore`);
  } else {
    // Update session title from first real message if needed
    if (trimmed && messages.length === 0) {
      updateSessionTitleFromMessage(sessionId, trimmed);
    }
  }

  console.log(`[agent] enqueue user message len=${trimmed.length} images=${images?.length ?? 0} mode=${currentPermissionMode}`);

  // Transition from pre-warm to active session
  if (isPreWarming) {
    isPreWarming = false;
    // Pre-warm 已收到 system_init → SDK 已注册此 session，后续必须用 resume
    if (systemInitInfo) {
      sessionRegistered = true;
    }
    console.log(`[agent] pre-warm → active, first user message, sessionRegistered=${sessionRegistered}`);
    // Replay buffered system_init so frontend gets tools/session info
    if (systemInitInfo) {
      broadcast('chat:system-init', { info: systemInitInfo, sessionId });
    }
  }
  // Cancel any pending pre-warm timer (user is sending a message now)
  if (preWarmTimer) {
    clearTimeout(preWarmTimer);
    preWarmTimer = null;
  }
  setSessionState('running');

  // Save images to disk and create attachment records
  const savedAttachments: MessageWire['attachments'] = [];
  if (hasImages) {
    for (const img of images) {
      try {
        const attachmentId = randomUUID();
        const relativePath = saveAttachment(sessionId, attachmentId, img.name, img.data, img.mimeType);
        savedAttachments.push({
          id: attachmentId,
          name: img.name,
          size: img.data.length, // Approximate size from base64
          mimeType: img.mimeType,
          relativePath,
          isImage: true,
        });
      } catch (error) {
        console.error('[agent] Failed to save attachment:', error);
      }
    }
  }

  // Build multimodal content array for Claude API
  // Images are sent as base64-encoded source blocks
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = [];

  // Add images first so Claude can see them before the text query
  if (hasImages) {
    for (const img of images) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.data,
        },
      });
    }
  }

  // Add text content if present
  if (trimmed) {
    contentBlocks.push({ type: 'text', text: trimmed });
  }

  const queueId = randomUUID();

  // Queue if session is busy: either AI is streaming or there are pending messages
  // in the queue waiting to be processed. This prevents a race condition where
  // isStreamingMessage is false briefly between turns (handleMessageComplete resets it)
  // but the generator hasn't picked up the next queued item yet.
  // IMPORTANT: Do NOT push to messages[] or broadcast here — queued messages
  // are rendered in the frontend only when they start executing (see messageGenerator).
  if (isStreamingMessage || messageQueue.length > 0) {
    // Backend queue limit (defense-in-depth — frontend also enforces limit)
    const MAX_QUEUE_SIZE = 10;
    if (messageQueue.length >= MAX_QUEUE_SIZE) {
      return { queued: false, error: `Queue full (max ${MAX_QUEUE_SIZE})` };
    }
    messageQueue.push({
      id: queueId,
      message: { role: 'user', content: contentBlocks },
      messageText: trimmed,
      wasQueued: true,
      resolve: () => {},  // No-op: no one is awaiting
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    });
    console.log(`[agent] Message queued (deferred render): queueId=${queueId} text="${trimmed.slice(0, 50)}"`);
    broadcast('queue:added', { queueId, messageText: trimmed.slice(0, 100) });
    return { queued: true, queueId };
  }

  // Direct send path: push user message to messages[] and broadcast immediately
  const userMessage: MessageWire = {
    id: String(messageSequence++),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString(),
    attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
    metadata,
  };
  messages.push(userMessage);
  broadcast('chat:message-replay', { message: userMessage });

  // Persist messages to disk after adding user message
  persistMessagesToStorage();

  const queueItem: MessageQueueItem = {
    id: queueId,
    message: { role: 'user', content: contentBlocks },
    messageText: trimmed,
    wasQueued: false,
    resolve: () => {},  // No-op: no one is awaiting
  };

  if (!isSessionActive()) {
    // 无活跃 session（pre-warm 失败或首次启动）→ 先入队再启动 session
    console.log('[agent] starting session (idle -> running)');
    messageQueue.push(queueItem);
    startStreamingSession().catch((error) => {
      console.error('[agent] failed to start session', error);
    });
  } else {
    // Session 已在运行（generator 在 waitForMessage 中等待）→ 直接投递
    wakeGenerator(queueItem);
  }

  return { queued: false };
}

export function isSessionActive(): boolean {
  return isProcessing || querySession !== null;
}

/**
 * Wait for the current session to become idle
 * Returns true if idle, false if timeout
 * @param timeoutMs Maximum time to wait in milliseconds (default: 10 minutes)
 * @param pollIntervalMs How often to check status (default: 500ms)
 */
// Helper function to check if session is idle (avoids TypeScript type narrowing issues)
function isSessionIdle(): boolean {
  return sessionState === 'idle';
}

export async function waitForSessionIdle(
  timeoutMs: number = 600000,
  pollIntervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();
  console.log(`[agent] waitForSessionIdle: starting, sessionState=${sessionState}`);

  // Brief wait to allow async operations to start (prevents false early return)
  // Note: Only check sessionState === 'idle' because isProcessing and querySession
  // remain set until the entire session ends (for await loop in startStreamingSession).
  // The sessionState is set to 'idle' by handleMessageComplete() after each message,
  // which correctly indicates "no message is being processed" for cron sync execution.
  if (isSessionIdle()) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (isSessionIdle()) {
      console.log('[agent] waitForSessionIdle: already idle, returning true');
      return true;
    }
  }

  while (Date.now() - startTime < timeoutMs) {
    if (isSessionIdle()) {
      console.log(`[agent] waitForSessionIdle: became idle after ${Date.now() - startTime}ms`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  console.warn('[agent] waitForSessionIdle: timeout reached');
  return false;
}

export async function interruptCurrentResponse(): Promise<boolean> {
  if (!querySession) {
    // 即使没有 querySession，如果 isStreamingMessage 为 true，也需要重置状态
    if (isStreamingMessage) {
      console.log('[agent] No querySession but streaming flag set, resetting state');
      broadcast('chat:message-stopped', null);
      handleMessageStopped();
      return true;
    }
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  isInterruptingResponse = true;
  try {
    // 使用 Promise.race 添加 5 秒超时
    const interruptPromise = querySession.interrupt();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Interrupt timeout')), 5000);
    });

    try {
      await Promise.race([interruptPromise, timeoutPromise]);
    } catch (error) {
      console.error('[agent] Interrupt error or timeout:', error);
      // 超时或出错时也要清理状态，避免 UI 卡住
    }

    broadcast('chat:message-stopped', null);
    handleMessageStopped();
    return true;
  } finally {
    isInterruptingResponse = false;
  }
}

/**
 * Cancel a queued message by its queueId.
 * Returns the original message text (for restoring to input box) or null if not found.
 */
export function cancelQueueItem(queueId: string): string | null {
  const index = messageQueue.findIndex(item => item.id === queueId);
  if (index === -1) return null;

  const [item] = messageQueue.splice(index, 1);
  // Only resolve if this was a non-blocking queued item (wasQueued: true has no-op resolve).
  // For blocking items (wasQueued: false), resolve would unblock enqueueUserMessage's await,
  // but the message was removed from the queue — messageGenerator won't find it, which is safe.
  item.resolve();
  broadcast('queue:cancelled', { queueId });
  console.log(`[agent] Queue item ${queueId} cancelled (wasQueued=${item.wasQueued})`);
  return item.messageText;
}

/**
 * Force-execute a queued message: move it to front of queue and interrupt current response.
 */
export async function forceExecuteQueueItem(queueId: string): Promise<boolean> {
  const index = messageQueue.findIndex(item => item.id === queueId);
  if (index === -1) return false;

  // Move to front of queue
  if (index > 0) {
    const [item] = messageQueue.splice(index, 1);
    messageQueue.unshift(item);
  }

  // Interrupt current AI response — messageGenerator will naturally yield the queue front
  await interruptCurrentResponse();
  return true;
}

/**
 * Get current queue status — list of queued items with their IDs and preview text.
 */
export function getQueueStatus(): Array<{ id: string; messagePreview: string }> {
  return messageQueue.map(item => ({
    id: item.id,
    messagePreview: item.messageText.slice(0, 100),
  }));
}

/**
 * 时间回溯：截断对话历史 + 即时回退文件状态。
 * 持久 session 下 subprocess 存活，可直接调用 rewindFiles（无需临时 session）。
 */
export async function rewindSession(userMessageId: string): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: MessageWire['attachments'];
}> {
  const doRewind = async () => {
    // 1. 找到目标 user message
    const targetIndex = messages.findIndex(m => m.id === userMessageId && m.role === 'user');
    if (targetIndex < 0) return { success: false as const, error: 'Message not found' };
    const targetMessage = messages[targetIndex];

    // 2. 找到目标前的最后一个 assistant UUID
    //    持久 session 模式下，user 消息不会通过 SDK stdout 回传（无 resume 重放），
    //    因此 user 消息没有 sdkUuid。使用前一个 assistant 的 UUID 替代：
    //    - rewindFiles(assistantUuid) → 回退该 assistant 之后的文件变更
    //    - pendingResumeSessionAt = assistantUuid → 下次 resume 从该 assistant 截断
    let lastAssistantUuid: string | undefined;
    for (let i = targetIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].sdkUuid) {
        lastAssistantUuid = messages[i].sdkUuid;
        break;
      }
    }

    // 3. 在活跃 session 上直接执行 rewindFiles（subprocess 存活，即时调用！）
    if (querySession && lastAssistantUuid) {
      try {
        const result = await querySession.rewindFiles(lastAssistantUuid);
        console.log('[agent] rewindFiles result:', JSON.stringify(result));
        if (!result.canRewind) {
          console.warn('[agent] rewindFiles cannot rewind:', result.error);
        }
      } catch (err) {
        console.error('[agent] rewindFiles error:', err);
        // 文件回溯失败不阻断消息截断
      }
    }

    // 4. 中止当前 session（需要新 session 用 resumeSessionAt 截断 SDK 历史）
    abortPersistentSession();
    messageQueue.length = 0;
    if (sessionTerminationPromise) {
      try { await sessionTerminationPromise; } catch { /* ignore */ }
    }
    shouldAbortSession = false;

    // 5. 收集被删消息内容（恢复到输入框）
    const removedContent = typeof targetMessage.content === 'string' ? targetMessage.content : '';
    const removedAttachments = targetMessage.attachments;

    // 6. 截断消息
    messages.length = targetIndex;
    persistMessagesToStorage();

    // 7. 设置下次 query 的对话截断点
    if (lastAssistantUuid) {
      pendingResumeSessionAt = lastAssistantUuid;
    } else {
      pendingResumeSessionAt = undefined;
      sessionRegistered = false;
      sessionId = randomUUID();
    }

    // 8. 预热下次 session
    schedulePreWarm();

    return { success: true as const, content: removedContent, attachments: removedAttachments };
  };

  const promise = doRewind();
  rewindPromise = promise;
  try {
    return await promise;
  } finally {
    rewindPromise = null;
  }
}

async function startStreamingSession(preWarm = false): Promise<void> {
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  if (isProcessing || querySession) {
    return;
  }

  isPreWarming = preWarm;
  const env = buildClaudeSessionEnv();
  console.log(`[agent] ${preWarm ? 'pre-warm' : 'start'} session cwd=${agentDir}`);
  shouldAbortSession = false;
  resetAbortFlag();
  isProcessing = true;
  let preWarmStartedOk = false; // Tracks whether pre-warm received system_init
  let abortedByTimeout = false; // Distinguishes timeout abort from config-change abort
  let detectedAlreadyInUse = false; // stderr reported "Session ID already in use"
  streamIndexToToolId.clear();
  imTextBlockIndices.clear();
  // Don't broadcast 'running' during pre-warm — session is invisible to frontend
  if (!preWarm) {
    setSessionState('running');
  }

  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  // Declared outside try so finally can clean up
  let startupTimeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const sdkPermissionMode = mapToSdkPermissionMode(currentPermissionMode);
    // 单一变量决策：sessionRegistered 为 true 则 resume，否则创建新 session
    const resumeFrom = sessionRegistered ? sessionId : undefined;
    // sessionRegistered 不在此处修改 — 等待 system_init 确认

    // 消费 rewind 设置的对话截断点
    // 持久 session 模式下，pre-warm 即最终 session（用户消息通过 wakeGenerator 投递），
    // 必须在 pre-warm 时就传 resumeSessionAt，否则 SDK 会加载完整历史不截断
    const rewindResumeAt = pendingResumeSessionAt;
    if (rewindResumeAt) pendingResumeSessionAt = undefined;

    const mcpStatus = currentMcpServers === null ? 'auto' : currentMcpServers.length === 0 ? 'disabled' : `enabled(${currentMcpServers.length})`;
    console.log(`[agent] starting query with model: ${currentModel ?? 'default'}, permissionMode: ${currentPermissionMode} -> SDK: ${sdkPermissionMode}, MCP: ${mcpStatus}, ${resumeFrom ? `resume: ${resumeFrom}` : `sessionId: ${sessionId}`}${rewindResumeAt ? `, resumeSessionAt: ${rewindResumeAt}` : ''}`);

    const promptGen = messageGenerator();

    // Build common query options (shared between normal start and "already in use" fallback)
    const commonQueryOptions = {
      enableFileCheckpointing: true,
      maxThinkingTokens: 32_000,
      // Only use project-level settings from .claude/ directory
      // We don't use 'user' (~/.claude/) because our config is in ~/.myagents/
      // MCP is explicitly configured via mcpServers, not SDK auto-discovery
      settingSources: buildSettingSources(),
      // Permission mode mapping (uses mapToSdkPermissionMode):
      // - auto → acceptEdits (auto-accept edits, check others via canUseTool)
      // - plan → plan
      // - fullAgency → bypassPermissions (skip all checks)
      // - custom → default (all tools go through canUseTool)
      permissionMode: sdkPermissionMode,
      // allowDangerouslySkipPermissions is required when using bypassPermissions
      ...(sdkPermissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      model: currentModel, // Use currently selected model
      pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
      executable: 'bun' as const,
      env,
      stderr: (message: string) => {
        // Always log stderr to help diagnose subprocess issues (especially on older Windows)
        console.error('[sdk-stderr]', message);
        // Detect "Session ID already in use" early — stderr arrives before process exit error
        if (message.includes('already in use')) {
          detectedAlreadyInUse = true;
        }
        if (process.env.DEBUG === '1') {
          broadcast('chat:debug-message', message);
        }
      },
      systemPrompt: buildSystemPromptOption(),
      cwd: agentDir,
      includePartialMessages: true,
      mcpServers: buildSdkMcpServers(),
      // Sub-agents: inject custom agent definitions if configured
      // When agents are injected, ensure 'Task' tool is in allowedTools so the model can delegate
      ...(currentAgentDefinitions && Object.keys(currentAgentDefinitions).length > 0
        ? { agents: currentAgentDefinitions, allowedTools: ['Task'] } : {}),
      // Custom permission handling - check rules and prompt user for unknown tools
      // Effective when permissionMode is 'default' or 'acceptEdits' (not 'bypassPermissions')
      canUseTool: async (toolName: string, input: unknown, options: { signal: AbortSignal }) => {
        console.debug(`[permission] canUseTool checking: ${toolName}`);

        // First check MCP tool permission based on user's enabled MCP servers
        const mcpCheck = checkMcpToolPermission(toolName);
        if (!mcpCheck.allowed) {
          if (isDebugMode) console.log(`[permission] MCP tool blocked: ${toolName} - ${mcpCheck.reason}`);
          return {
            behavior: 'deny' as const,
            message: mcpCheck.reason
          };
        }

        // Special case: built-in trusted MCP servers (cron-tools, im-cron)
        // When allowed by checkMcpToolPermission, skip user confirmation entirely
        if (toolName.startsWith('mcp__cron-tools__') || toolName.startsWith('mcp__im-cron__')) {
          console.log(`[permission] built-in tool auto-allowed: ${toolName}`);
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        }

        // Special handling for AskUserQuestion - always requires user interaction
        if (toolName === 'AskUserQuestion') {
          console.log('[canUseTool] AskUserQuestion detected, prompting user');
          const answers = await handleAskUserQuestion(input, options.signal);
          if (answers === null) {
            return {
              behavior: 'deny' as const,
              message: '用户取消了问答'
            };
          }
          // Return with answers filled in
          const inputWithAnswers = input as Record<string, unknown>;
          return {
            behavior: 'allow' as const,
            updatedInput: { ...inputWithAnswers, answers }
          };
        }

        const decision = await checkToolPermission(
          toolName,
          input,
          currentPermissionMode,
          options.signal
        );
        console.debug(`[permission] canUseTool result for ${toolName}: ${decision}`);
        if (decision === 'allow') {
          // Must include updatedInput for SDK to properly process the tool call
          return {
            behavior: 'allow' as const,
            updatedInput: input as Record<string, unknown>
          };
        } else {
          return {
            behavior: 'deny' as const,
            message: '用户拒绝了此工具的使用权限'
          };
        }
      },
    };

    // sessionId 和 resume 互斥（SDK 约束）
    // 新 session：传 sessionId 让 SDK 使用我们的 UUID
    // Resume：传 resume 恢复对话上下文
    const sessionOption = resumeFrom
      ? { resume: resumeFrom, ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}) }
      : { sessionId: sessionId };

    try {
      querySession = query({
        prompt: promptGen,
        options: { ...sessionOption, ...commonQueryOptions },
      });
    } catch (queryError: unknown) {
      // Defensive fallback: metadata lost but SDK disk data exists → switch to resume
      // Note: "already in use" may surface asynchronously during for-await iteration
      // rather than synchronously here; this catch covers the sync case if SDK validates early.
      const msg = queryError instanceof Error ? queryError.message : String(queryError);
      if (!resumeFrom && msg.includes('already in use')) {
        console.warn(`[agent] Session ${sessionId} already exists on disk, switching to resume`);
        sessionRegistered = true;
        querySession = query({
          prompt: promptGen,
          options: {
            resume: sessionId,
            ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}),
            ...commonQueryOptions,
          },
        });
      } else {
        throw queryError;
      }
    }

    console.log('[agent] session started');
    console.log('[agent] starting for-await loop on querySession');

    // Startup timeout: if no SDK message arrives within 60s, abort
    const STARTUP_TIMEOUT_MS = 60_000;
    let firstMessageReceived = false;

    startupTimeoutId = setTimeout(() => {
        if (!firstMessageReceived && !shouldAbortSession) {
            console.error(`[agent] Startup timeout: no SDK message in ${STARTUP_TIMEOUT_MS / 1000}s`);
            abortedByTimeout = true;
            if (!isPreWarming) {
                broadcast('chat:agent-error', {
                    message: 'Agent 启动超时，请重试。如果持续出现，请检查网络连接和 API 配置。'
                });
                broadcast('chat:message-error', 'Agent 启动超时');
            }
            // abortPersistentSession 统一处理：设置 shouldAbortSession、唤醒 generator
            // 的 waitForMessage/waitForTurnComplete、调用 interrupt() 解除 for-await 阻塞
            abortPersistentSession();
        }
    }, STARTUP_TIMEOUT_MS);

    let messageCount = 0;

    for await (const sdkMessage of querySession) {
      messageCount++;
      if (!firstMessageReceived) {
          firstMessageReceived = true;
          clearTimeout(startupTimeoutId);
      }
      console.log(`[agent][sdk] message #${messageCount} type=${sdkMessage.type}`);
      try {
        const line = `${new Date().toISOString()} ${JSON.stringify(sdkMessage)}`;
        console.log('[agent][sdk]', JSON.stringify(sdkMessage));
        appendLogLine(line);
      } catch (error) {
        console.log('[agent][sdk] (unserializable)', error);
      }
      const nextSystemInit = parseSystemInitInfo(sdkMessage);
      if (nextSystemInit) {
        systemInitInfo = nextSystemInit;
        // Buffer system_init during pre-warm; replay when first user message arrives
        if (!isPreWarming) {
          sessionRegistered = true;  // SDK 确认注册，后续必须 resume
          broadcast('chat:system-init', { info: systemInitInfo, sessionId });
        } else {
          // Pre-warm 不设 sessionRegistered — 这是核心设计约束
          // Pre-warm 的 system_init 只意味着 subprocess 准备好了，
          // 但 SDK 不会在没有用户消息的情况下持久化 session
          preWarmStartedOk = true;
          preWarmFailCount = 0;
          console.log('[agent] pre-warm: system_init buffered (will replay on first message)');
        }

        // Save SDK session_id and verify unified session status
        if (nextSystemInit.session_id) {
          const isUnified = nextSystemInit.session_id === sessionId;
          updateSessionMetadata(sessionId, {
            sdkSessionId: nextSystemInit.session_id,
            unifiedSession: isUnified,
          });
          if (isUnified) {
            console.log(`[agent] SDK session_id confirmed unified: ${nextSystemInit.session_id}`);
          } else {
            console.log(`[agent] SDK session_id saved (pre-unified): ${nextSystemInit.session_id} (our: ${sessionId})`);
          }
        }

      }

      // Handle system status (e.g., compacting)
      const statusResult = parseSystemStatus(sdkMessage);
      if (statusResult.isStatusMessage) {
        console.log(`[agent] System status: ${statusResult.status}`);
        broadcast('chat:system-status', { status: statusResult.status });
      }

      const agentError = extractAgentError(sdkMessage);
      if (agentError) {
        broadcast('chat:agent-error', { message: agentError });
      }
      if (shouldAbortSession) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            if (sdkMessage.parent_tool_use_id) {
              const parentToolUseId = childToolToParent.get(sdkMessage.parent_tool_use_id) ?? null;
              if (parentToolUseId) {
                broadcast('chat:subagent-tool-result-delta', {
                  parentToolUseId,
                  toolUseId: sdkMessage.parent_tool_use_id,
                  delta: streamEvent.delta.text
                });
              } else {
                // Skip broadcasting delta for stripped Playwright tools (keep in-memory data intact)
                if (!strippedToolResultIds.has(sdkMessage.parent_tool_use_id)) {
                  broadcast('chat:tool-result-delta', {
                    toolUseId: sdkMessage.parent_tool_use_id,
                    delta: streamEvent.delta.text
                  });
                }
              }
              appendToolResultDelta(sdkMessage.parent_tool_use_id, streamEvent.delta.text);
            } else {
              // Skip empty chunks (null, undefined, '')
              if (!streamEvent.delta.text) {
                console.log('[agent] Skipping empty chunk');
              } else {
                // Filter out decorative text from third-party APIs before broadcasting
                const decorativeCheck = checkDecorativeToolText(streamEvent.delta.text);
                if (!decorativeCheck.filtered) {
                  broadcast('chat:message-chunk', streamEvent.delta.text);
                  appendTextChunk(streamEvent.delta.text);
                  // IM stream: forward non-subagent text delta
                  imStreamCallback?.('delta', streamEvent.delta.text);
                } else {
                  console.log(`[agent] Filtered decorative text from stream (${decorativeCheck.reason})`);
                }
              }
            }
          } else if (streamEvent.delta.type === 'thinking_delta') {
            broadcast('chat:thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            });
            handleThinkingChunk(streamEvent.index, streamEvent.delta.thinking);
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const toolId = streamIndexToToolId.get(streamEvent.index) ?? '';
            if (sdkMessage.parent_tool_use_id) {
              broadcast('chat:subagent-tool-input-delta', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                toolId,
                delta: streamEvent.delta.partial_json
              });
              handleSubagentToolInputDelta(
                sdkMessage.parent_tool_use_id,
                toolId,
                streamEvent.delta.partial_json
              );
            } else {
              broadcast('chat:tool-input-delta', {
                index: streamEvent.index,
                toolId,
                delta: streamEvent.delta.partial_json
              });
              handleToolInputDelta(streamEvent.index, toolId, streamEvent.delta.partial_json);
            }
          }
        } else if (streamEvent.type === 'content_block_start') {
          // IM stream: track text block indices (non-subagent only)
          if (imStreamCallback && !sdkMessage.parent_tool_use_id) {
            if (streamEvent.content_block.type === 'text') {
              imTextBlockIndices.add(streamEvent.index);
            } else {
              // Notify non-text block activity (thinking, tool_use) so IM can show placeholder
              imStreamCallback('activity', streamEvent.content_block.type);
            }
          }
          if (streamEvent.content_block.type === 'thinking') {
            broadcast('chat:thinking-start', { index: streamEvent.index });
            handleThinkingStart(streamEvent.index);
          } else if (streamEvent.content_block.type === 'tool_use') {
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);
            const toolPayload = {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: streamEvent.content_block.input || {},
              streamIndex: streamEvent.index
            };
            if (sdkMessage.parent_tool_use_id) {
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: toolPayload
              });
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, toolPayload);
            } else {
              broadcast('chat:tool-use-start', toolPayload);
              handleToolUseStart(toolPayload);
            }
          } else if (streamEvent.content_block.type === 'server_tool_use') {
            // Server-side tool use (e.g., 智谱 GLM-4.7's webReader, analyze_image)
            // These are executed by the API provider, not locally
            const serverToolBlock = streamEvent.content_block as {
              type: 'server_tool_use';
              id: string;
              name: string;
              input: Record<string, unknown> | string; // Some APIs return input as JSON string
            };
            streamIndexToToolId.set(streamEvent.index, serverToolBlock.id);

            // Parse input if it's a JSON string (智谱 GLM-4.7 returns input as string)
            let parsedInput: Record<string, unknown> = {};
            if (typeof serverToolBlock.input === 'string') {
              try {
                parsedInput = JSON.parse(serverToolBlock.input);
              } catch {
                // If parsing fails, wrap the string as-is
                parsedInput = { raw: serverToolBlock.input };
              }
            } else {
              parsedInput = serverToolBlock.input || {};
            }

            const toolPayload = {
              id: serverToolBlock.id,
              name: serverToolBlock.name,
              input: parsedInput,
              streamIndex: streamEvent.index
            };
            // Server tools are always top-level (no subagent concept)
            broadcast('chat:server-tool-use-start', toolPayload);
            handleServerToolUseStart(toolPayload);
          } else if (
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result' ||
              streamEvent.content_block.type === 'tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            let contentStr = '';
            if (typeof toolResultBlock.content === 'string') {
              contentStr = toolResultBlock.content;
            } else if (toolResultBlock.content !== null && toolResultBlock.content !== undefined) {
              contentStr = JSON.stringify(toolResultBlock.content, null, 2);
            }

            toolResultIndexToId.set(streamEvent.index, toolResultBlock.tool_use_id);
            if (contentStr) {
              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-start', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              } else {
                // Strip Playwright tool results from frontend broadcast
                const shouldStripResult = isPlaywrightTool(toolResultBlock.tool_use_id);
                if (shouldStripResult) {
                  strippedToolResultIds.add(toolResultBlock.tool_use_id);
                }
                broadcast('chat:tool-result-start', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: shouldStripResult ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  isError: toolResultBlock.is_error || false
                });
              }
              handleToolResultStart(
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const toolId = streamIndexToToolId.get(streamEvent.index);
          if (sdkMessage.parent_tool_use_id) {
            if (toolId) {
              finalizeSubagentToolInput(sdkMessage.parent_tool_use_id, toolId);
            }
            const toolResultId = toolResultIndexToId.get(streamEvent.index);
            if (toolResultId) {
              toolResultIndexToId.delete(streamEvent.index);
              if (finalizeSubagentToolResult(toolResultId)) {
                const result = getSubagentToolResult(toolResultId) ?? '';
                const parentToolUseId = childToolToParent.get(toolResultId);
                if (parentToolUseId) {
                  broadcast('chat:subagent-tool-result-complete', {
                    parentToolUseId,
                    toolUseId: toolResultId,
                    content: result
                  });
                }
              }
            }
          } else {
            broadcast('chat:content-block-stop', {
              index: streamEvent.index,
              toolId: toolId || undefined
            });
            handleContentBlockStop(streamEvent.index, toolId || undefined);
            // IM stream: signal text block end
            if (imStreamCallback && imTextBlockIndices.has(streamEvent.index)) {
              imStreamCallback('block-end', '');
              imTextBlockIndices.delete(streamEvent.index);
            }
          }
        }
      } else if (sdkMessage.type === 'user') {
        // Track SDK user UUID — only for non-synthetic messages
        if (!(sdkMessage as { isSynthetic?: boolean }).isSynthetic && sdkMessage.uuid) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user' && !messages[i].sdkUuid) {
              messages[i].sdkUuid = sdkMessage.uuid;
              broadcast('chat:message-sdk-uuid', { messageId: messages[i].id, sdkUuid: sdkMessage.uuid });
              break;
            }
          }
        }
        // Process tool_result blocks from user messages
        // This handles both subagent results (parent_tool_use_id set) and top-level tool results (parent_tool_use_id null)
        if (sdkMessage.message?.content) {
          const messageContent = sdkMessage.message.content;

          // Handle local command output (e.g., /cost, /context commands)
          // SDK sends these as user messages with string content wrapped in <local-command-stdout> tags
          if (typeof messageContent === 'string' && messageContent.includes('<local-command-stdout>')) {
            const localCommandMessage: MessageWire = {
              id: String(messageSequence++),
              role: 'user',
              content: messageContent,
              timestamp: new Date().toISOString(),
            };
            messages.push(localCommandMessage);
            broadcast('chat:message-replay', { message: localCommandMessage });
            persistMessagesToStorage();
          }

          // Check for structured tool_use_result data (e.g., WebSearch results)
          const toolUseResultData = (sdkMessage as { tool_use_result?: unknown }).tool_use_result;

          // Only iterate if content is an array (tool_result blocks)
          if (Array.isArray(messageContent)) {
            for (const block of messageContent) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result' &&
              'tool_use_id' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown;
              };

              // For WebSearch/WebFetch, prefer structured tool_use_result data if available
              // This contains query, results array with titles/urls, etc.
              let contentStr: string;
              if (toolUseResultData && typeof toolUseResultData === 'object') {
                contentStr = JSON.stringify(toolUseResultData);
              } else if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else {
                contentStr = JSON.stringify(toolResultBlock.content ?? '', null, 2);
              }

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr
                });
              } else {
                // Top-level tool result (e.g., WebSearch without parent)
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr
                });
              }
              handleToolResultComplete(toolResultBlock.tool_use_id, contentStr);
            }
          }
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        // Track SDK assistant UUID for resumeSessionAt / rewindFiles
        const currentAssistant = ensureAssistantMessage();
        // 始终更新为最新的 UUID — SDK 一个回合可能输出多条 assistant 消息
        // （thinking → text），resumeSessionAt 需要最后一条的 UUID 才能保留完整回答
        if (sdkMessage.uuid) {
          currentAssistant.sdkUuid = sdkMessage.uuid;
        }
        const assistantMessage = sdkMessage.message;
        // Main turn token usage is extracted from result message (more reliable across providers)
        // Here we extract usage only for subagent tool broadcasts (Task tool runtime stats)
        const rawUsage = (assistantMessage as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        }).usage;
        const subagentUsage = rawUsage ? {
          input_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens,
          output_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens,
        } : undefined;

        if (sdkMessage.parent_tool_use_id && assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_use' &&
              'id' in block &&
              'name' in block
            ) {
              const toolBlock = block as {
                id: string;
                name: string;
                input?: Record<string, unknown>;
              };
              const payload = {
                id: toolBlock.id,
                name: toolBlock.name,
                input: toolBlock.input || {}
              };
              broadcast('chat:subagent-tool-use', {
                parentToolUseId: sdkMessage.parent_tool_use_id,
                tool: payload,
                usage: subagentUsage
              });
              handleSubagentToolUseStart(sdkMessage.parent_tool_use_id, payload);
            }
          }
        }
        if (sdkMessage.parent_tool_use_id) {
          const text = formatAssistantContent(assistantMessage.content);
          if (text) {
            const next = appendToolResultContent(sdkMessage.parent_tool_use_id, text);
            const stripped = strippedToolResultIds.has(sdkMessage.parent_tool_use_id) || isPlaywrightTool(sdkMessage.parent_tool_use_id);
            broadcast('chat:tool-result-complete', {
              toolUseId: sdkMessage.parent_tool_use_id,
              content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : next
            });
          }
        }
        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              let contentStr: string;
              if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                contentStr = toolResultBlock.content
                  .map((c) => {
                    if (typeof c === 'string') {
                      return c;
                    }
                    if (typeof c === 'object' && c !== null) {
                      if ('text' in c && typeof c.text === 'string') {
                        return c.text;
                      }
                      if ('type' in c && c.type === 'text' && 'text' in c) {
                        return String(c.text);
                      }
                      return JSON.stringify(c, null, 2);
                    }
                    return String(c);
                  })
                  .join('\n');
              } else if (typeof toolResultBlock.content === 'object' && toolResultBlock.content) {
                contentStr = JSON.stringify(toolResultBlock.content, null, 2);
              } else {
                contentStr = String(toolResultBlock.content);
              }

              const parentToolUseId =
                childToolToParent.get(toolResultBlock.tool_use_id) ?? sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(parentToolUseId, toolResultBlock.tool_use_id);
                }
                broadcast('chat:subagent-tool-result-complete', {
                  parentToolUseId,
                  toolUseId: toolResultBlock.tool_use_id,
                  content: contentStr,
                  isError: toolResultBlock.is_error || false
                });
              } else {
                const stripped = strippedToolResultIds.has(toolResultBlock.tool_use_id) || isPlaywrightTool(toolResultBlock.tool_use_id);
                broadcast('chat:tool-result-complete', {
                  toolUseId: toolResultBlock.tool_use_id,
                  content: stripped ? PLAYWRIGHT_RESULT_SENTINEL : contentStr,
                  isError: toolResultBlock.is_error || false
                });
              }
              handleToolResultComplete(
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        // Extract token usage from result message
        // SDK result contains modelUsage (per-model stats) and/or usage (aggregate)
        // This is the authoritative source for token statistics
        const resultMessage = sdkMessage as {
          type: 'result';
          is_error?: boolean;
          result?: string;
          errors?: string[];
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
          }>;
        };

        // Forward SDK error results to IM callback (prevents "(No Response)")
        if (resultMessage.is_error) {
          const rawError = resultMessage.result || resultMessage.errors?.join('; ') || '';
          // Detect image content error — reset session to clear polluted history
          // (applies to both IM and desktop: prevents all subsequent messages from failing)
          if (rawError.includes('unknown variant') && rawError.includes('image')) {
            shouldResetSessionAfterError = true;
          }
          if (imStreamCallback) {
            const errorText = localizeImError(rawError);
            console.warn('[agent] SDK result is_error, forwarding to IM:', errorText);
            imStreamCallback('error', errorText);
            imStreamCallback = null;
          }
        }

        // Prefer modelUsage (per-model breakdown), fallback to aggregate usage
        if (resultMessage.modelUsage) {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheCreation = 0;
          let primaryModel: string | undefined;
          let maxModelTokens = 0;
          const modelUsageMap: Record<string, ModelUsageEntry> = {};

          for (const [model, stats] of Object.entries(resultMessage.modelUsage)) {
            const modelInput = stats.inputTokens ?? 0;
            const modelOutput = stats.outputTokens ?? 0;
            const modelCacheRead = stats.cacheReadInputTokens ?? 0;
            const modelCacheCreation = stats.cacheCreationInputTokens ?? 0;

            totalInput += modelInput;
            totalOutput += modelOutput;
            totalCacheRead += modelCacheRead;
            totalCacheCreation += modelCacheCreation;

            // Save per-model breakdown
            modelUsageMap[model] = {
              inputTokens: modelInput,
              outputTokens: modelOutput,
              cacheReadTokens: modelCacheRead || undefined,
              cacheCreationTokens: modelCacheCreation || undefined,
            };

            // Track primary model (highest token usage)
            const modelTotal = modelInput + modelOutput;
            if (modelTotal > maxModelTokens) {
              maxModelTokens = modelTotal;
              primaryModel = model;
            }
          }

          currentTurnUsage.inputTokens = totalInput;
          currentTurnUsage.outputTokens = totalOutput;
          currentTurnUsage.cacheReadTokens = totalCacheRead;
          currentTurnUsage.cacheCreationTokens = totalCacheCreation;
          currentTurnUsage.model = primaryModel;
          currentTurnUsage.modelUsage = modelUsageMap;

          if (isDebugMode) {
            console.log(`[agent] Token usage from result.modelUsage: input=${totalInput}, output=${totalOutput}, models=${Object.keys(modelUsageMap).join(', ')}`);
          }
        } else if (resultMessage.usage) {
          currentTurnUsage.inputTokens = resultMessage.usage.input_tokens ?? 0;
          currentTurnUsage.outputTokens = resultMessage.usage.output_tokens ?? 0;
          currentTurnUsage.cacheReadTokens = resultMessage.usage.cache_read_input_tokens ?? 0;
          currentTurnUsage.cacheCreationTokens = resultMessage.usage.cache_creation_input_tokens ?? 0;
          if (isDebugMode) {
            console.log(`[agent] Token usage from result.usage: input=${currentTurnUsage.inputTokens}, output=${currentTurnUsage.outputTokens}`);
          }
        } else {
          console.warn('[agent] Result message has no usage data, token statistics may be incomplete');
        }

        // Calculate duration for analytics
        const durationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : 0;

        console.log('[agent][sdk] Broadcasting chat:message-complete');
        // Include usage data for frontend analytics tracking
        broadcast('chat:message-complete', {
          model: currentTurnUsage.model,
          input_tokens: currentTurnUsage.inputTokens,
          output_tokens: currentTurnUsage.outputTokens,
          cache_read_tokens: currentTurnUsage.cacheReadTokens,
          cache_creation_tokens: currentTurnUsage.cacheCreationTokens,
          tool_count: currentTurnToolCount,
          duration_ms: durationMs,
        });
        handleMessageComplete();
        signalTurnComplete();  // 解锁 generator 进入下一轮

        // Auto-reset session if image content polluted conversation history
        if (shouldResetSessionAfterError) {
          shouldResetSessionAfterError = false;
          console.warn('[agent] Auto-resetting session due to image content error in history');
          resetSession().catch(e => console.error('[agent] Auto-reset failed:', e));
        }

        // Deferred config restart: MCP/Agents changed during this turn but we didn't
        // abort mid-response. Now that the turn completed naturally, restart the session
        // so the new config takes effect. The generator will see shouldAbortSession and exit.
        // schedulePreWarm() ensures a new session starts after the abort completes.
        // The 500ms timer gives enough time for the finally block to run (isProcessing=false)
        // before the new startStreamingSession is called.
        // sessionRegistered is preserved, so the new session will use resume.
        if (pendingConfigRestart) {
          console.log('[agent] Turn complete, applying deferred config restart');
          pendingConfigRestart = false;
          abortPersistentSession();
          schedulePreWarm();
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : String(error);
    console.error('[agent] session error:', errorMessage);
    console.error('[agent] session error stack:', errorStack);

    // "Session ID already in use" recovery: SDK session dir exists on disk but our
    // in-memory metadata was lost (fresh Bun process after crash/restart).
    // Fix: switch to resume mode. Pre-warm retry (finally block) will use resume.
    // For non-pre-warm: schedule pre-warm to establish resumed session; user's message
    // is lost for this attempt, but the next message will work correctly.
    if (detectedAlreadyInUse && !sessionRegistered) {
      console.warn(`[agent] Session ${sessionId} exists on disk but metadata lost, switching to resume for retry`);
      sessionRegistered = true;
      if (!isPreWarming) {
        schedulePreWarm(); // Establish resumed session so next user message works
      }
      return; // Skip error broadcast, let finally handle cleanup + pre-warm retry
    }

    // Enhanced error diagnostics for Windows subprocess failures
    let userFacingError = errorMessage;
    if (errorMessage.includes('process exited with code 1') && process.platform === 'win32') {
      console.error('[agent] Windows subprocess failure detected. Possible causes:');
      console.error('[agent] 1. Git for Windows not installed (most common)');
      console.error('[agent] 2. Git Bash not in PATH');
      console.error('[agent] 3. CLAUDE_CODE_GIT_BASH_PATH environment variable not set');
      console.error('[agent] Windows version:', process.env.OS || 'unknown');
      userFacingError = '子进程启动失败 (exit code 1)。最可能原因：未安装 Git for Windows。请安装 Git：https://git-scm.com/downloads/win';
    }

    // Don't broadcast errors to frontend during pre-warm.
    // Failure counting is handled uniformly in the finally block via preWarmStartedOk flag,
    // so we don't increment preWarmFailCount here — avoids double-counting when both
    // catch and finally execute for the same failed pre-warm.
    if (!isPreWarming) {
      broadcast('chat:message-error', userFacingError);
      handleMessageError(errorMessage);
      setSessionState('error');
    }
  } finally {
    clearTimeout(startupTimeoutId);
    const wasPreWarming = isPreWarming;
    isPreWarming = false;
    isProcessing = false;

    // 确保 generator 退出（防止 streamInput 永远阻塞）
    if (messageResolver) {
      const resolve = messageResolver;
      messageResolver = null;
      resolve(null);
    }
    signalTurnComplete();

    // 安全关闭 SDK session
    const session = querySession;
    querySession = null;
    try { session?.close(); } catch { /* subprocess 可能已退出 */ }

    // sessionRegistered 已在 system_init handler 中设置，无需重复

    // Don't broadcast state changes from pre-warm sessions
    if (!wasPreWarming) {
      if (sessionState !== 'error') {
        setSessionState('idle');
      }
    }

    clearCronTaskContext();
    resolveTermination!();

    if (wasPreWarming) {
      // sessionRegistered 不修改 — pre-warm 永不触碰此标志

      if (!preWarmStartedOk) {
        if (!shouldAbortSession || abortedByTimeout) {
          preWarmFailCount++;
          console.warn(`[agent] pre-warm failed, failCount=${preWarmFailCount}${abortedByTimeout ? ' (timeout)' : ''}`);
        } else {
          console.log('[agent] pre-warm aborted by config change');
        }
      }

      if (!preWarmStartedOk || shouldAbortSession) {
        schedulePreWarm();
      }
    } else if (!shouldAbortSession && sessionRegistered && sessionState !== 'error') {
      // 非主动中止的意外退出（subprocess crash）→ 安排恢复
      console.log('[agent] Unexpected session exit, scheduling recovery pre-warm');
      schedulePreWarm();
    }
  }
}

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  // 持久 yield 模式：generator 不 return → subprocess 全程存活 → 消除每轮重启开销。
  // while(true) 循环等待消息 → yield 到 SDK stdin → 等待 AI 回复完成 → 下一轮。
  // 唯一退出信号：waitForMessage() 返回 null（由 abortPersistentSession 触发）。
  console.log('[messageGenerator] Started (persistent mode)');

  while (true) {
    // 等待队列中的消息（事件驱动，无轮询）
    const item = await waitForMessage();
    if (!item) {
      console.log('[messageGenerator] Received null — exiting (abort or session end)');
      return; // generator return → SDK endInput() → stdin EOF → subprocess 退出
    }

    // 排队消息的延迟渲染（原逻辑不变）
    if (item.wasQueued) {
      const userMessage: MessageWire = {
        id: String(messageSequence++),
        role: 'user',
        content: item.messageText,
        timestamp: new Date().toISOString(),
        attachments: item.attachments,
      };
      messages.push(userMessage);
      persistMessagesToStorage();
      resetTurnUsage();
      currentTurnStartTime = Date.now();
      broadcast('queue:started', {
        queueId: item.id,
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          content: userMessage.content,
          timestamp: userMessage.timestamp,
          attachments: userMessage.attachments,
        },
      });
    }

    // Yield 消息到 SDK stdin
    isStreamingMessage = true;
    console.log(`[messageGenerator] Yielding message, wasQueued=${item.wasQueued}`);
    yield {
      type: 'user' as const,
      message: item.message,
      parent_tool_use_id: null,
      session_id: getSessionId()
    };
    item.resolve();

    // 等待本轮 AI 回复完成（result 消息到达后解锁）
    await waitForTurnComplete();
    if (shouldAbortSession) {
      console.log('[messageGenerator] Abort flag set after turn complete, exiting');
      return;
    }
  }
}
