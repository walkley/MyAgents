import { appendFileSync, copyFileSync, cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, join, relative, resolve, extname } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import {
  BUILTIN_SLASH_COMMANDS,
  parseSkillFrontmatter,
  extractCommandName,
  parseFullSkillContent,
  parseFullCommandContent,
  serializeSkillContent,
  serializeCommandContent,
  type SlashCommand,
  type SkillFrontmatter,
  type CommandFrontmatter
} from '../shared/slashCommands';
import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';
import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';
import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta } from './agents/agent-loader';
import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';
import type { McpServerDefinition } from '../renderer/config/types';
import {
  setCronTaskContext,
  clearCronTaskContext,
  CRON_TASK_COMPLETE_PATTERN,
  CRON_TASK_EXIT_TEXT,
  CRON_TASK_EXIT_REASON_PATTERN,
} from './tools/cron-tools';

// ============= CRASH DIAGNOSTICS =============
// File-based logging to capture crashes before process dies
const CRASH_LOG = '/tmp/myagents-crash.log';

function crashLog(prefix: string, ...args: unknown[]) {
  try {
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(' ');
    appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${prefix} ${msg}\n`);
  } catch { /* ignore */ }
}

process.on('exit', (code) => {
  crashLog('EXIT', `code=${code}`);
});

process.on('beforeExit', (code) => {
  crashLog('BEFORE_EXIT', `code=${code}`);
});

process.on('uncaughtException', (err) => {
  crashLog('UNCAUGHT_EXCEPTION', err);
  console.error('[process] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  crashLog('UNHANDLED_REJECTION', reason);
  console.error('[process] unhandledRejection:', reason);
});

process.on('SIGTERM', () => {
  crashLog('SIGNAL', 'SIGTERM');
  console.error('[process] SIGTERM received');
});

process.on('SIGINT', () => {
  crashLog('SIGNAL', 'SIGINT');
  console.error('[process] SIGINT received');
});

crashLog('STARTUP', 'Server starting...');
// ============= END CRASH DIAGNOSTICS =============


import {
  enqueueUserMessage,
  cancelQueueItem,
  forceExecuteQueueItem,
  getQueueStatus,
  getAgentState,
  getLogLines,
  getMessages,
  getSessionId,
  getSystemInitInfo,
  initializeAgent,
  interruptCurrentResponse,
  switchToSession,
  setMcpServers,
  getMcpServers,
  setAgents,
  setSessionModel,
  resetSession,
  waitForSessionIdle,
  setImStreamCallback,
  setSystemPromptConfig,
  clearSystemPromptConfig,
  rewindSession,
  getPendingInteractiveRequests,
} from './agent-session';
import { getHomeDirOrNull } from './utils/platform';
import { getScriptDir } from './utils/runtime';
import { buildDirectoryTree, expandDirectory } from './dir-info';
import {
  createSession,
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionMetadata,
  getSessionsByAgentDir,
  updateSessionMetadata,
  getAttachmentDataUrl,
} from './SessionStore';
import { initLogger, getLoggerDiagnostics } from './logger';
import { cleanupOldLogs } from './AgentLogger';
import { cleanupOldUnifiedLogs, appendUnifiedLogBatch } from './UnifiedLogger';
import { broadcast, createSseClient, getClients } from './sse';
import { checkAnthropicSubscription, getGitBranch, verifyApiKey, verifySubscription } from './provider-verify';

type ImagePayload = {
  name: string;
  mimeType: string;
  data: string; // base64
};

type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

/**
 * Runtime download URLs for common MCP commands
 */
const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {
  'node': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },
  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'deno': { name: 'Deno', url: 'https://deno.land/' },
  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
};

/**
 * Get download info for a command
 */
function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {
  const info = RUNTIME_DOWNLOAD_URLS[command];
  if (info) {
    return { runtimeName: info.name, downloadUrl: info.url };
  }
  return {};
}

type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  model?: string;
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
  };
};

// Cron task execution payload
type CronExecutePayload = {
  taskId: string;
  prompt: string;
  /** Session ID for single_session mode (reuse existing session) */
  sessionId?: string;
  isFirstExecution?: boolean;
  aiCanExit?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
  };
  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */
  runMode?: 'single_session' | 'new_session';
  /** Task execution interval in minutes (for System Prompt context) */
  intervalMinutes?: number;
  /** Current execution number, 1-based (for System Prompt context) */
  executionNumber?: number;
};

/**
 * Build the System Prompt append content for cron task execution.
 * This content will be appended to the default claude_code system prompt.
 *
 * Note: User's original prompt is sent separately via enqueueUserMessage(),
 * keeping it clean without wrapper templates.
 */
function buildCronSystemPromptAppend(
  taskId: string,
  intervalMinutes: number,
  executionNumber: number,
  aiCanExit: boolean
): string {
  // Format interval for display
  const intervalText = intervalMinutes >= 60
    ? `${Math.floor(intervalMinutes / 60)} 小时${intervalMinutes % 60 > 0 ? ` ${intervalMinutes % 60} 分钟` : ''}`
    : `${intervalMinutes} 分钟`;

  // Build base content - always present
  let content = `<cron-task-instructions>
你正处于循环任务模式 (Task ID: ${taskId})。
每隔 ${intervalText} 系统触发执行一次，当前是第 ${executionNumber} 次执行。`;

  // Only add exit instructions if AI can exit (avoid redundant info)
  if (aiCanExit) {
    content += `

如果任务目标已完全达成，无需继续定时执行，请调用 \`mcp__cron-tools__exit_cron_task\` 工具来结束任务。`;
  }

  content += `
</cron-task-instructions>`;

  return content;
}

function parseArgs(argv: string[]): { agentDir: string; initialPrompt?: string; port: number; sessionId?: string } {
  const args = argv.slice(2);
  const getArgValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return null;
    }
    return args[index + 1] ?? null;
  };

  const agentDir = getArgValue('--agent-dir') ?? '';
  const initialPrompt = getArgValue('--prompt') ?? undefined;
  const port = Number(getArgValue('--port') ?? 3000);
  const sessionId = getArgValue('--session-id') ?? undefined;

  if (!agentDir) {
    throw new Error('Missing required argument: --agent-dir <path>');
  }

  return { agentDir, initialPrompt, port: Number.isNaN(port) ? 3000 : port, sessionId };
}

/**
 * Expand ~ to user's home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const homeDir = getHomeDirOrNull() || '';
    return path.replace(/^~/, homeDir);
  }
  return path;
}

async function ensureAgentDir(dir: string): Promise<string> {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    await mkdir(resolved, { recursive: true });
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Agent directory is not a directory: ${resolved}`);
  }
  return resolved;
}

// ============= SKILLS CONFIG & SEED =============

interface SkillsConfig {
  seeded: string[];
  disabled: string[];
}

function getSkillsConfigPath(): string {
  const homeDir = getHomeDirOrNull() || '';
  return join(homeDir, '.myagents', 'skills-config.json');
}

function readSkillsConfig(): SkillsConfig {
  const configPath = getSkillsConfigPath();
  const defaults: SkillsConfig = { seeded: [], disabled: [] };
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return {
        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,
        disabled: Array.isArray(raw?.disabled) ? raw.disabled : defaults.disabled,
      };
    }
  } catch (err) {
    console.warn('[skills-config] Error reading config:', err);
  }
  return defaults;
}

function writeSkillsConfig(config: SkillsConfig): void {
  const configPath = getSkillsConfigPath();
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[skills-config] Error writing config:', err);
  }
}

/**
 * Resolve bundled-skills directory.
 * - Production (macOS): Contents/Resources/bundled-skills/
 * - Production (Windows): <install-dir>/bundled-skills/
 * - Development: <project-root>/bundled-skills/
 */
function resolveBundledSkillsDir(): string | null {
  const scriptDir = getScriptDir();

  // Production: bundled-skills is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, 'bundled-skills');
  if (existsSync(prodPath)) return prodPath;

  // Development: bundled-skills is at project root
  // In dev, scriptDir is something like <project>/src/server/utils
  // Walk up to find bundled-skills at project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  return null;
}

/**
 * Seed bundled skills to ~/.myagents/skills/ on first launch.
 * Only copies skills that haven't been seeded before (tracked in skills-config.json).
 */
function seedBundledSkills(): void {
  try {
    const bundledDir = resolveBundledSkillsDir();
    if (!bundledDir) {
      console.log('[seed] Bundled skills directory not found, skipping seed');
      return;
    }

    const config = readSkillsConfig();
    const homeDir = getHomeDirOrNull() || '';
    const userSkillsDir = join(homeDir, '.myagents', 'skills');

    if (!existsSync(userSkillsDir)) mkdirSync(userSkillsDir, { recursive: true });

    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let changed = false;
    for (const folder of bundledFolders) {
      if (config.seeded.includes(folder)) continue;

      const src = join(bundledDir, folder);
      const dst = join(userSkillsDir, folder);
      // Skip if destination already exists (don't overwrite user's custom content)
      if (existsSync(dst)) {
        config.seeded.push(folder);
        changed = true;
        console.log(`[seed] Skipped existing folder: ${folder}`);
        continue;
      }
      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] Seeded skill: ${folder}`);
      } catch (err) {
        console.warn(`[seed] Failed to seed skill ${folder}:`, err);
        continue;
      }

      config.seeded.push(folder);
      changed = true;
    }

    if (changed) {
      writeSkillsConfig(config);
    }
  } catch (err) {
    console.error('[seed] Error seeding bundled skills:', err);
  }
}

// ============= END SKILLS CONFIG & SEED =============

/**
 * Validate that the agent directory is safe to access.
 * Prevents directory traversal attacks and access to sensitive directories.
 */
function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  const homeDir = getHomeDirOrNull() || '';

  // Must be an absolute path
  if (!resolved.startsWith('/') && !resolved.match(/^[A-Z]:\\/i)) {
    return { valid: false, reason: 'Path must be absolute' };
  }

  // Forbidden system directories
  const forbiddenPaths = [
    '/etc',
    '/var',
    '/usr',
    '/bin',
    '/sbin',
    '/boot',
    '/root',
    '/sys',
    '/proc',
    '/dev',
    join(homeDir, '.ssh'),
    join(homeDir, '.gnupg'),
    join(homeDir, '.config/op'),  // 1Password
    join(homeDir, 'Library/Keychains'),
  ];

  for (const forbidden of forbiddenPaths) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/')) {
      return { valid: false, reason: `Access to ${forbidden} is not allowed` };
    }
  }

  // Must be under a reasonable parent (home, documents, or common dev paths)
  const allowedParents = [
    homeDir,
    '/tmp',
    '/Users',
    '/home',
    'C:\\Users',
  ];

  const isUnderAllowed = allowedParents.some(
    parent => parent && resolved.startsWith(parent)
  );

  if (!isUnderAllowed) {
    return { valid: false, reason: 'Path must be under user directory' };
  }

  return { valid: true };
}

function resolveAgentPath(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/^\/+/, '');
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}


const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'yaml',
  'yml',
  'log',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
  'htm',
  'xml',
  'svg',
  'env',
  'toml',
  'ini',
  'conf',
  'sh',
  'py',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'c',
  'cpp',
  'h',
  'hpp',
  'sql',
  'graphql',
  'gql',
  // Dotfiles - added for common dev files
  'gitignore',
  'gitattributes',
  'editorconfig',
  'npmrc',
  'yarnrc',
  'prettierrc',
  'eslintrc',
  'babelrc',
  'dockerignore',
]);

function isPreviewableText(name: string, mimeType: string | undefined): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) {
      return true;
    }
    if (['application/json', 'application/xml', 'application/x-yaml'].includes(mimeType)) {
      return true;
    }
  }
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return TEXT_EXTENSIONS.has(extension);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Recursively copy a directory (synchronous version)
 * Security: Skips symbolic links to prevent following links to sensitive locations
 * @param src Source directory path
 * @param dest Destination directory path
 * @param logPrefix Optional prefix for log messages
 */
function copyDirRecursiveSync(src: string, dest: string, logPrefix = '[copyDir]'): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // Security: Skip symbolic links to prevent following links to sensitive locations
    if (entry.isSymbolicLink()) {
      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath, logPrefix);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Validate folder name for security (no path traversal)
 */
function isValidFolderName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0;
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const distRoot = resolve(process.cwd(), 'dist');
  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = join(distRoot, resolvedPath);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }

  const indexFile = Bun.file(join(distRoot, 'index.html'));
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return null;
}

interface SwitchPayload {
  agentDir: string;
  initialPrompt?: string;
}

async function main() {
  const { agentDir, initialPrompt, port, sessionId: initialSessionId } = parseArgs(process.argv);
  let currentAgentDir = await ensureAgentDir(agentDir);

  // Initialize unified logging system (intercepts console.log and sends to SSE)
  initLogger(getClients);

  // Clean up old logs (30+ days)
  cleanupOldLogs();        // Agent session logs
  cleanupOldUnifiedLogs(); // Unified console logs

  // Seed bundled skills to ~/.myagents/skills/ on first launch
  seedBundledSkills();

  await initializeAgent(currentAgentDir, initialPrompt, initialSessionId);

  Bun.serve({
    port,
    hostname: '127.0.0.1', // Explicitly bind to IPv4 for Rust proxy compatibility
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      console.log(`[http] ${request.method} ${pathname}`);

      // Handle CORS preflight requests (for browser dev mode via Vite proxy)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        });
      }

      // 🩺 Health check endpoint - used by Rust sidecar manager
      // Must be as simple as possible to verify HTTP handler is responsive
      if (pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }

      // Session state endpoint - used by Rust background completion polling
      if (pathname === '/api/session-state' && request.method === 'GET') {
        const { sessionState } = getAgentState();
        return jsonResponse({ sessionState });
      }

      // 🔍 Debug endpoint: Expose logger diagnostics via HTTP
      if (pathname === '/debug/logger' && request.method === 'GET') {
        const diagnostics = getLoggerDiagnostics();
        const clientsCount = getClients().length;
        return jsonResponse({
          ...diagnostics,
          currentClientsCount: clientsCount,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      if (pathname === '/chat/stream' && request.method === 'GET') {
        const { client, response } = createSseClient(() => { });
        const state = getAgentState();
        client.send('chat:init', state);
        getMessages().forEach((message) => {
          client.send('chat:message-replay', { message });
        });
        client.send('chat:logs', { lines: getLogLines() });
        const systemInitInfo = getSystemInitInfo();
        if (systemInitInfo) {
          client.send('chat:system-init', { info: systemInitInfo });
        }
        // Replay pending interactive requests (permission, ask-user-question)
        // so that a Tab joining mid-session can display and respond to them.
        for (const pending of getPendingInteractiveRequests()) {
          client.send(pending.type, pending.data);
        }
        return response;
      }

      if (pathname === '/chat/send' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        const images = payload?.images ?? [];
        const permissionMode = payload?.permissionMode ?? 'auto';
        const model = payload?.model;
        const providerEnv = payload?.providerEnv;

        // Allow sending with just images or just text
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }

        try {
          console.log(`[chat] send text="${text.slice(0, 200)}" images=${images.length} mode=${permissionMode} model=${model ?? 'default'} baseUrl=${providerEnv?.baseUrl ?? 'anthropic'}`);
          const result = await enqueueUserMessage(text, images, permissionMode, model, providerEnv);
          if (result.error) {
            return jsonResponse({ success: false, error: result.error }, 429);
          }
          return jsonResponse({ success: true, queued: result.queued, queueId: result.queueId });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/chat/stop' && request.method === 'POST') {
        try {
          console.log('[chat] stop');
          const stopped = await interruptCurrentResponse();
          if (!stopped) {
            return jsonResponse({ success: false, error: 'No active response to stop.' }, 400);
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Rewind session to a specific user message (time travel)
      if (pathname === '/chat/rewind' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
        if (!userMessageId) {
          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
        }
        const result = await rewindSession(userMessageId);
        return jsonResponse(result);
      }

      // Cancel a queued message
      if (pathname === '/chat/queue/cancel' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        const cancelledText = cancelQueueItem(queueId);
        if (cancelledText === null) {
          return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
        }
        return jsonResponse({ success: true, cancelledText });
      }

      // Force-execute a queued message (interrupt current + run queued)
      if (pathname === '/chat/queue/force' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        try {
          const result = await forceExecuteQueueItem(queueId);
          if (!result) {
            return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Get queue status
      if (pathname === '/chat/queue/status' && request.method === 'GET') {
        return jsonResponse({ success: true, queue: getQueueStatus() });
      }

      // Poll background task output file for live stats
      if (pathname === '/api/task/poll-background' && request.method === 'POST') {
        try {
          const body = await request.json() as { outputFile?: string; offset?: number };
          const { outputFile, offset = 0 } = body;

          // Validate outputFile path: resolve to canonical path then verify it falls
          // under the user's home directory and matches expected suffix.
          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").
          if (!outputFile || typeof outputFile !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
          const resolvedOutputFile = resolve(outputFile);
          const homeDir = getHomeDirOrNull() || '';
          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + '/');
          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }

          // Check file existence
          if (!existsSync(resolvedOutputFile)) {
            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });
          }

          const fileStat = statSync(resolvedOutputFile);
          const fileSize = fileStat.size;

          // No new data
          if (offset >= fileSize) {
            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });
          }

          // Read incremental data (cap at 1MB)
          const MAX_READ = 1024 * 1024;
          const readEnd = Math.min(offset + MAX_READ, fileSize);
          const file = Bun.file(resolvedOutputFile);
          const slice = file.slice(offset, readEnd);
          const text = await slice.text();

          // Parse JSONL lines
          let toolCount = 0;
          let assistantCount = 0;
          let userCount = 0;
          let progressCount = 0;
          let firstTimestamp = 0;
          let lastTimestamp = 0;
          let lastLineType = '';
          let lastLineHasToolUse = false;

          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              if (ts && !firstTimestamp) firstTimestamp = ts;
              if (ts) lastTimestamp = ts;

              if (parsed.type === 'assistant') {
                assistantCount++;
                lastLineType = 'assistant';
                lastLineHasToolUse = false;
                // Count tool_use blocks in content
                if (Array.isArray(parsed.message?.content)) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      toolCount++;
                      lastLineHasToolUse = true;
                    }
                  }
                }
              } else if (parsed.type === 'user') {
                userCount++;
                lastLineType = 'user';
                lastLineHasToolUse = false;
              } else if (parsed.type === 'progress') {
                progressCount++;
              }
            } catch {
              // Skip truncated/invalid lines
            }
          }

          const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

          // Detect completion: last line is assistant with only text (no tool_use)
          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;

          return jsonResponse({
            success: true,
            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },
            newOffset: readEnd,
            isComplete
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Reset session for "new conversation" - clears all messages and state
      if (pathname === '/chat/reset' && request.method === 'POST') {
        try {
          console.log('[chat] reset (new conversation)');
          await resetSession();
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ============= CRON TASK API =============

      // GET /cron/check-completion - Check if the last response indicates task completion
      if (pathname === '/cron/check-completion' && request.method === 'GET') {
        try {
          const messages = getMessages();
          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');

          if (!lastAssistantMessage) {
            return jsonResponse({ success: true, completed: false, reason: null });
          }

          // Extract text content from the message
          let textContent = '';
          if (typeof lastAssistantMessage.content === 'string') {
            textContent = lastAssistantMessage.content;
          } else if (Array.isArray(lastAssistantMessage.content)) {
            textContent = lastAssistantMessage.content
              .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
              .map(block => block.text)
              .join('\n');
          }

          // Check for completion marker
          const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
          if (completionMatch) {
            return jsonResponse({
              success: true,
              completed: true,
              reason: completionMatch[1].trim()
            });
          }

          return jsonResponse({ success: true, completed: false, reason: null });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute - Execute a scheduled task
      // This endpoint wraps the user's prompt with cron-specific instructions
      // and enables the exit_cron_task custom tool
      if (pathname === '/cron/execute' && request.method === 'POST') {
        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, aiCanExit, permissionMode, model, providerEnv, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Get current session ID for context isolation
        const currentSessionId = getSessionId();

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, currentSessionId);

        // Set System Prompt append for cron task context
        // This injects task instructions at the system prompt level (semantically correct)
        // instead of wrapping the user's prompt
        setSystemPromptConfig({
          mode: 'append',
          content: buildCronSystemPromptAppend(
            taskId,
            intervalMinutes ?? 15,
            executionNumber ?? 1,
            aiCanExit ?? false
          )
        });

        try {
          console.log(`[cron] execute taskId=${taskId} sessionId=${currentSessionId} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);
          // Send the user's original prompt (clean, without wrapper templates)
          await enqueueUserMessage(prompt, [], permissionMode ?? 'auto', model, providerEnv);
          return jsonResponse({ success: true });
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(currentSessionId);
          clearSystemPromptConfig();
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute-sync - Execute a scheduled task synchronously
      // This endpoint is used by Rust for direct Sidecar invocation without frontend
      // It waits for the execution to complete and returns the result
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        console.log('[cron] execute-sync: endpoint matched');

        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
          console.log('[cron] execute-sync: payload parsed', { taskId: payload.taskId, hasPrompt: !!payload.prompt, runMode: payload.runMode });
        } catch (e) {
          console.error('[cron] execute-sync: JSON parse error', e);
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, sessionId, aiCanExit, permissionMode, model, providerEnv, runMode, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Handle session setup based on runMode
        const effectiveRunMode = runMode ?? 'single_session';
        const { agentDir } = getAgentState();

        // Clear any existing cron context before switching sessions
        // This prevents context pollution when sessions change
        clearCronTaskContext();

        let effectiveSessionId = sessionId;

        if (effectiveRunMode === 'new_session') {
          // Create a fresh session for each execution (no memory of previous runs)
          const newSession = createSession(agentDir);
          const switched = await switchToSession(newSession.id);
          if (!switched) {
            console.error(`[cron] execute-sync taskId=${taskId} failed to switch to new session ${newSession.id}`);
            return jsonResponse({ success: false, error: 'Failed to create new session for execution.' }, 500);
          }
          effectiveSessionId = newSession.id;
          console.log(`[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id}`);
        } else if (sessionId) {
          // single_session mode: switch to the task's stored session (keeps context)
          // If already in the target session, skip switchToSession to avoid aborting
          // an active AI response and clearing the message queue.
          const currentSessionId = getSessionId();
          if (currentSessionId === sessionId) {
            console.log(`[cron] execute-sync taskId=${taskId} single_session mode: already in session ${sessionId}, skipping switch`);
          } else {
            console.log(`[cron] execute-sync taskId=${taskId} attempting to switch to session ${sessionId}`);
            const switched = await switchToSession(sessionId);
            if (!switched) {
              console.warn(`[cron] execute-sync taskId=${taskId} failed to switch to session ${sessionId}, will use current session instead`);
              // Log current session state for debugging
              const currentState = getAgentState();
              console.log(`[cron] execute-sync taskId=${taskId} current session state: agentDir=${currentState.agentDir}, sessionState=${currentState.sessionState}, hasInitialPrompt=${currentState.hasInitialPrompt}`);
            } else {
              console.log(`[cron] execute-sync taskId=${taskId} single_session mode: switched to session ${sessionId}`);
            }
          }
        } else {
          console.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, using current session`);
        }

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);
        console.log(`[cron] execute-sync: cron context set for taskId=${taskId}`);

        // Set System Prompt append for cron task context
        // This injects task instructions at the system prompt level (semantically correct)
        // instead of wrapping the user's prompt
        try {
          const systemPromptAppend = buildCronSystemPromptAppend(
            taskId,
            intervalMinutes ?? 15,
            executionNumber ?? 1,
            aiCanExit ?? false
          );
          console.log(`[cron] execute-sync: system prompt built, length=${systemPromptAppend.length}`);

          setSystemPromptConfig({
            mode: 'append',
            content: systemPromptAppend
          });
          console.log('[cron] execute-sync: system prompt config set');
        } catch (e) {
          console.error('[cron] execute-sync: error building/setting system prompt', e);
          clearCronTaskContext(effectiveSessionId);
          return jsonResponse({ success: false, error: `System prompt error: ${e}` }, 500);
        }

        try {
          console.log(`[cron] execute-sync taskId=${taskId} runMode=${effectiveRunMode} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);

          // Enqueue the message (this starts the async execution)
          // Send the user's original prompt (clean, without wrapper templates)
          console.log('[cron] execute-sync: about to enqueue user message');
          const enqueueResult = await enqueueUserMessage(prompt, [], permissionMode ?? 'auto', model, providerEnv);
          console.log('[cron] execute-sync: user message enqueued, queued:', enqueueResult.queued, 'queueId:', enqueueResult.queueId);

          // Wait for session to become idle (execution complete)
          // Timeout: 60 minutes max execution time (matches Rust cron_task timeout)
          const completed = await waitForSessionIdle(3600000, 1000);

          if (!completed) {
            console.warn(`[cron] execute-sync taskId=${taskId} timed out`);
            // Clean up the cron message from the queue to prevent ghost execution
            // after the original streaming task finishes.
            // Use cancelQueueItem (not clearMessageQueue) to avoid removing unrelated
            // user-queued messages that should still execute after the current task.
            if (enqueueResult.queued && enqueueResult.queueId) {
              cancelQueueItem(enqueueResult.queueId);
            }
            clearCronTaskContext(effectiveSessionId);
            clearSystemPromptConfig();
            return jsonResponse({
              success: false,
              error: 'Execution timed out after 10 minutes'
            }, 408); // Request Timeout
          }

          // Check if AI requested exit
          let aiRequestedExit = false;
          let exitReason: string | undefined;

          // Check messages for completion marker or exit_cron_task tool call
          const messages = getMessages();
          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');

          if (lastAssistantMessage) {
            let textContent = '';
            if (typeof lastAssistantMessage.content === 'string') {
              textContent = lastAssistantMessage.content;
            } else if (Array.isArray(lastAssistantMessage.content)) {
              textContent = lastAssistantMessage.content
                .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                .map(block => block.text)
                .join('\n');
            }

            // Check for completion marker
            const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
            if (completionMatch) {
              aiRequestedExit = true;
              exitReason = completionMatch[1].trim();
            }

            // Also check for exit tool result in text
            if (textContent.includes(CRON_TASK_EXIT_TEXT)) {
              aiRequestedExit = true;
              const reasonMatch = textContent.match(CRON_TASK_EXIT_REASON_PATTERN);
              if (reasonMatch) {
                exitReason = reasonMatch[1].trim();
              }
            }
          }

          // Clear cron task context after execution
          clearCronTaskContext(effectiveSessionId);
          // Note: System Prompt config is NOT cleared here intentionally.
          // System Prompt only takes effect when query() is called (session creation).
          // For single_session mode, subsequent executions reuse the existing session,
          // so the config won't be used again anyway. Keeping it set is harmless.

          console.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);

          const response = {
            success: true,
            aiRequestedExit,
            exitReason
          };
          console.log(`[cron] execute-sync taskId=${taskId} returning response:`, JSON.stringify(response));
          return jsonResponse(response);
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(effectiveSessionId);
          clearSystemPromptConfig();
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[cron] execute-sync taskId=${taskId} error:`, error);
          const errorResponse = { success: false, error: errorMessage };
          console.log(`[cron] execute-sync taskId=${taskId} returning error response:`, JSON.stringify(errorResponse));
          return jsonResponse(errorResponse, 500);
        }
      }

      // ============= SESSION API =============

      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        try {
          console.log('[sessions] GET /sessions called');
          const agentDirParam = url.searchParams.get('agentDir');
          console.log('[sessions] agentDirParam:', agentDirParam);
          const sessions = agentDirParam
            ? getSessionsByAgentDir(agentDirParam)
            : getAllSessionMetadata();
          console.log('[sessions] found sessions:', sessions.length);
          return jsonResponse({ success: true, sessions });
        } catch (error) {
          console.error('[sessions] Error in GET /sessions:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'
          }, 500);
        }
      }

      // POST /sessions - Create a new session
      if (pathname === '/sessions' && request.method === 'POST') {
        let payload: { agentDir: string };
        try {
          payload = (await request.json()) as { agentDir: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const agentDirValue = payload?.agentDir?.trim();
        if (!agentDirValue) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        const session = createSession(agentDirValue);
        return jsonResponse({ success: true, session });
      }

      // GET /sessions/:id/stats - Get detailed session statistics
      // NOTE: This route must be BEFORE /sessions/:id to avoid being caught by the generic route
      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Group stats by model
        const byModel: Record<string, {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          count: number;
        }> = {};

        // Build message details
        const messageDetails: Array<{
          userQuery: string;
          model?: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
          toolCount?: number;
          durationMs?: number;
        }> = [];

        let currentUserQuery = '';
        for (const msg of session.messages) {
          if (msg.role === 'user') {
            currentUserQuery = typeof msg.content === 'string'
              ? msg.content.slice(0, 100)
              : JSON.stringify(msg.content).slice(0, 100);
          } else if (msg.role === 'assistant' && msg.usage) {
            // Use modelUsage for per-model breakdown if available, fallback to single model
            if (msg.usage.modelUsage) {
              for (const [model, stats] of Object.entries(msg.usage.modelUsage)) {
                if (!byModel[model]) {
                  byModel[model] = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    count: 0,
                  };
                }
                byModel[model].inputTokens += stats.inputTokens ?? 0;
                byModel[model].outputTokens += stats.outputTokens ?? 0;
                byModel[model].cacheReadTokens += stats.cacheReadTokens ?? 0;
                byModel[model].cacheCreationTokens += stats.cacheCreationTokens ?? 0;
                byModel[model].count++;
              }
            } else {
              // Fallback for older messages without modelUsage
              const model = msg.usage.model || 'unknown';
              if (!byModel[model]) {
                byModel[model] = {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  count: 0,
                };
              }
              byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
              byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
              byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
              byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
              byModel[model].count++;
            }

            // Message details always use aggregate values
            messageDetails.push({
              userQuery: currentUserQuery,
              model: msg.usage.model,
              inputTokens: msg.usage.inputTokens ?? 0,
              outputTokens: msg.usage.outputTokens ?? 0,
              cacheReadTokens: msg.usage.cacheReadTokens,
              cacheCreationTokens: msg.usage.cacheCreationTokens,
              toolCount: msg.toolCount,
              durationMs: msg.durationMs,
            });
          }
        }

        const metadata = getSessionMetadata(sessionId);
        return jsonResponse({
          success: true,
          stats: {
            summary: metadata?.stats ?? {
              messageCount: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
            },
            byModel,
            messageDetails,
          },
        });
      }

      // GET /sessions/:id - Get session details
      if (pathname.startsWith('/sessions/') && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // If this is the currently active session, merge in-memory messages.
        // In-memory messages include the current turn's in-progress content
        // (thinking, text, tool_use) that hasn't been persisted to disk yet.
        // This is critical for shared Sidecar: when a Tab opens an IM session
        // mid-turn, it needs to see the partial assistant response.
        let mergedMessages = session.messages;
        if (sessionId === getSessionId()) {
          const inMemory = getMessages();
          if (inMemory.length > 0) {
            const diskIds = new Set(session.messages.map(m => m.id));
            const newMessages = inMemory
              .filter(m => !diskIds.has(m.id))
              .map(m => ({
                id: m.id,
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                timestamp: m.timestamp,
                sdkUuid: m.sdkUuid,
                attachments: m.attachments?.map(a => ({
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  path: a.savedPath ?? a.relativePath ?? '',
                })),
                metadata: m.metadata,
              }));
            if (newMessages.length > 0) {
              mergedMessages = [...session.messages, ...newMessages];
            }
          }
        }

        // Add previewUrl for image attachments
        const sessionWithPreview = {
          ...session,
          messages: mergedMessages.map((msg) => ({
            ...msg,
            attachments: msg.attachments?.map((att) => ({
              ...att,
              previewUrl: att.mimeType.startsWith('image/')
                ? getAttachmentDataUrl(att.path, att.mimeType)
                : undefined,
            })),
          })),
        };

        return jsonResponse({ success: true, session: sessionWithPreview });
      }

      // DELETE /sessions/:id - Delete a session
      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const deleted = deleteSession(sessionId);
        if (!deleted) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true });
      }

      // PATCH /sessions/:id - Update session metadata
      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        let payload: { title?: string };
        try {
          payload = (await request.json()) as { title?: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const updated = updateSessionMetadata(sessionId, {
          title: payload.title,
          lastActiveAt: new Date().toISOString(),
        });

        if (!updated) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true, session: updated });
      }

      // POST /sessions/switch - Switch to existing session for resume
      if (pathname === '/sessions/switch' && request.method === 'POST') {
        let payload: { sessionId?: string };
        try {
          payload = (await request.json()) as { sessionId?: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        const success = await switchToSession(payload.sessionId);
        if (!success) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        console.log(`[sessions] Switched to session: ${payload.sessionId}`);
        return jsonResponse({ success: true, sessionId: payload.sessionId });
      }

      // ============= END SESSION API =============

      // Switch agent directory at runtime (for browser development mode)
      if (pathname === '/agent/switch' && request.method === 'POST') {
        let payload: SwitchPayload;
        try {
          payload = (await request.json()) as SwitchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const newDir = payload?.agentDir?.trim();
        if (!newDir) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Security: validate the path before allowing access
        const validation = isValidAgentDir(newDir);
        if (!validation.valid) {
          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);
          return jsonResponse({
            success: false,
            error: validation.reason || 'Invalid directory path'
          }, 403);
        }

        try {
          console.log(`[agent] switch to dir="${newDir}"`);
          currentAgentDir = await ensureAgentDir(newDir);
          await initializeAgent(currentAgentDir, payload.initialPrompt);
          return jsonResponse({
            success: true,
            agentDir: currentAgentDir
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/agent/dir' && request.method === 'GET') {
        try {
          console.log('[agent] dir');
          const info = await buildDirectoryTree(currentAgentDir);
          return jsonResponse(info);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Expand a specific directory (lazy loading for directories marked as loaded: false)
      if (pathname === '/agent/dir/expand' && request.method === 'GET') {
        try {
          const targetPath = url.searchParams.get('path');
          if (!targetPath) {
            return jsonResponse({ error: 'Missing path parameter' }, 400);
          }
          // Security: Validate that targetPath doesn't escape currentAgentDir (prevent path traversal)
          const resolvedTarget = resolve(currentAgentDir, targetPath);
          if (!resolvedTarget.startsWith(currentAgentDir + '/') && resolvedTarget !== currentAgentDir) {
            return jsonResponse({ error: 'Invalid path: access denied' }, 403);
          }
          console.log('[agent] dir/expand:', targetPath);
          const result = await expandDirectory(currentAgentDir, targetPath);
          return jsonResponse(result);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Search files in workspace for @mention feature
      if (pathname === '/agent/search-files' && request.method === 'GET') {
        try {
          const query = url.searchParams.get('q') ?? '';
          if (!query) {
            return jsonResponse([]);
          }

          // Use glob to search files
          const glob = new Bun.Glob(`**/*${query}*`);
          const results: { path: string; name: string; type: 'file' | 'dir' }[] = [];

          for await (const file of glob.scan({
            cwd: currentAgentDir,
            onlyFiles: false,
            dot: false, // Ignore hidden files
          })) {
            // Skip node_modules, .git, etc.
            if (file.includes('node_modules/') || file.includes('.git/')) {
              continue;
            }

            const fullPath = join(currentAgentDir, file);
            try {
              const stats = await stat(fullPath);
              results.push({
                path: file,
                name: basename(file),
                type: stats.isDirectory() ? 'dir' : 'file',
              });

              // Limit results
              if (results.length >= 20) break;
            } catch {
              // Skip files we can't stat
            }
          }

          return jsonResponse(results);
        } catch (error) {
          console.error('[agent] search-files error:', error);
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Search failed' },
            500
          );
        }
      }

      // Batch check whether paths exist (for inline code path detection in AI output)
      if (pathname === '/agent/check-paths' && request.method === 'POST') {
        try {
          const payload = await request.json() as { paths?: string[] };
          const paths = payload?.paths;
          if (!Array.isArray(paths)) {
            return jsonResponse({ error: 'paths must be an array.' }, 400);
          }
          if (paths.length > 200) {
            return jsonResponse({ error: 'Too many paths (max 200).' }, 400);
          }
          const results: Record<string, { exists: boolean; type: 'file' | 'dir' }> = {};
          for (const p of paths) {
            if (typeof p !== 'string' || !p) {
              results[p] = { exists: false, type: 'file' };
              continue;
            }
            const resolved = resolveAgentPath(currentAgentDir, p);
            if (!resolved) {
              results[p] = { exists: false, type: 'file' };
              continue;
            }
            try {
              const s = statSync(resolved);
              results[p] = { exists: true, type: s.isDirectory() ? 'dir' : 'file' };
            } catch {
              results[p] = { exists: false, type: 'file' };
            }
          }
          return jsonResponse({ results });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'check-paths failed' },
            500
          );
        }
      }

      if (pathname === '/agent/download' && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') ?? '';
        if (!relativePath) {
          return jsonResponse({ error: 'Missing path.' }, 400);
        }
        // Get agentDir from query param, fallback to currentAgentDir
        const queryAgentDir = url.searchParams.get('agentDir');
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          return jsonResponse({ error: 'Invalid agentDir.' }, 400);
        }
        const targetDir = queryAgentDir || currentAgentDir;
        const resolvedPath = resolveAgentPath(targetDir, relativePath);
        if (!resolvedPath) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
          return jsonResponse({ error: 'File not found.' }, 404);
        }
        const name = basename(resolvedPath);
        return new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${name}"`
          }
        });
      }

      if (pathname === '/agent/file' && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') ?? '';
        if (!relativePath) {
          return jsonResponse({ error: 'Missing path.' }, 400);
        }
        const resolvedPath = resolveAgentPath(currentAgentDir, relativePath);
        if (!resolvedPath) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
          return jsonResponse({ error: 'File not found.' }, 404);
        }
        const name = basename(resolvedPath);
        if (!isPreviewableText(name, file.type)) {
          return jsonResponse({ error: 'File type not supported.' }, 415);
        }
        const size = file.size;
        const maxSize = 512 * 1024;
        if (size > maxSize) {
          return jsonResponse({ error: 'File too large to preview.' }, 413);
        }
        try {
          const content = await file.text();
          return jsonResponse({ content, name, size });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Failed to read file.' },
            500
          );
        }
      }

      // Save file content
      if (pathname === '/agent/save-file' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string; content?: string };
          const relativePath = payload?.path?.trim();
          const content = payload?.content;

          if (!relativePath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          if (content === undefined || content === null) {
            return jsonResponse({ success: false, error: 'content is required.' }, 400);
          }

          const resolvedPath = resolveAgentPath(currentAgentDir, relativePath);
          if (!resolvedPath) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const file = Bun.file(resolvedPath);
          if (!(await file.exists())) {
            return jsonResponse({ success: false, error: 'File not found.' }, 404);
          }

          // Check file size limit (512KB)
          const maxSize = 512 * 1024;
          if (content.length > maxSize) {
            return jsonResponse({ success: false, error: 'Content too large.' }, 413);
          }

          await Bun.write(resolvedPath, content);
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Save failed' },
            500
          );
        }
      }

      if (pathname === '/agent/upload' && request.method === 'POST') {
        const targetParam = url.searchParams.get('path') ?? '';
        const resolvedTarget =
          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;
        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        try {
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];
          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }
          await mkdir(resolvedTarget, { recursive: true });
          const saved: string[] = [];
          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await Bun.write(destination, file);
            saved.push(relative(currentAgentDir, destination));
          }
          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Create new file
      if (pathname === '/agent/new-file' && request.method === 'POST') {
        try {
          const payload = await request.json() as { parentDir?: string; name?: string };
          const parentDir = payload?.parentDir?.trim() ?? '';
          const name = payload?.name?.trim();

          if (!name) {
            return jsonResponse({ success: false, error: 'name is required.' }, 400);
          }

          if (name.includes('/') || name.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid file name.' }, 400);
          }

          const resolvedParent = parentDir
            ? resolveAgentPath(currentAgentDir, parentDir)
            : currentAgentDir;
          if (!resolvedParent) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const filePath = join(resolvedParent, name);

          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists.' }, 409);
          }

          await Bun.write(filePath, '');
          return jsonResponse({ success: true, path: relative(currentAgentDir, filePath) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Create failed' },
            500
          );
        }
      }

      // Create new folder
      if (pathname === '/agent/new-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as { parentDir?: string; name?: string };
          const parentDir = payload?.parentDir?.trim() ?? '';
          const name = payload?.name?.trim();

          if (!name) {
            return jsonResponse({ success: false, error: 'name is required.' }, 400);
          }

          if (name.includes('/') || name.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid folder name.' }, 400);
          }

          const resolvedParent = parentDir
            ? resolveAgentPath(currentAgentDir, parentDir)
            : currentAgentDir;
          if (!resolvedParent) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const folderPath = join(resolvedParent, name);

          if (existsSync(folderPath)) {
            return jsonResponse({ success: false, error: 'Folder already exists.' }, 409);
          }

          await mkdir(folderPath, { recursive: true });
          return jsonResponse({ success: true, path: relative(currentAgentDir, folderPath) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Create failed' },
            500
          );
        }
      }

      // Rename file or folder
      if (pathname === '/agent/rename' && request.method === 'POST') {
        try {
          const payload = await request.json() as { oldPath?: string; newName?: string };
          const oldPath = payload?.oldPath?.trim();
          const newName = payload?.newName?.trim();

          if (!oldPath || !newName) {
            return jsonResponse({ success: false, error: 'oldPath and newName are required.' }, 400);
          }

          // Validate newName doesn't contain path separators
          if (newName.includes('/') || newName.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid file name.' }, 400);
          }

          const resolvedOld = resolveAgentPath(currentAgentDir, oldPath);
          if (!resolvedOld) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const parentDir = resolvedOld.substring(0, resolvedOld.lastIndexOf('/'));
          const resolvedNew = join(parentDir, newName);

          if (!existsSync(resolvedOld)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          await rename(resolvedOld, resolvedNew);
          return jsonResponse({ success: true, newPath: relative(currentAgentDir, resolvedNew) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Rename failed' },
            500
          );
        }
      }

      // Delete file or folder
      if (pathname === '/agent/delete' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string };
          const targetPath = payload?.path?.trim();

          if (!targetPath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          const resolved = resolveAgentPath(currentAgentDir, targetPath);
          if (!resolved) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          if (!existsSync(resolved)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          await rm(resolved, { recursive: true, force: true });
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Delete failed' },
            500
          );
        }
      }

      // Open in Finder/Explorer
      if (pathname === '/agent/open-in-finder' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string; agentDir?: string };
          const targetPath = payload?.path?.trim();

          if (!targetPath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          // Use provided agentDir or fall back to currentAgentDir
          const effectiveAgentDir = payload?.agentDir || currentAgentDir;
          const resolved = resolveAgentPath(effectiveAgentDir, targetPath);
          if (!resolved) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          if (!existsSync(resolved)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          // Use 'open -R' on macOS to reveal in Finder, 'explorer /select' on Windows
          const isMac = process.platform === 'darwin';
          const isWin = process.platform === 'win32';

          if (isMac) {
            Bun.spawn(['open', '-R', resolved]);
          } else if (isWin) {
            Bun.spawn(['explorer', '/select,', resolved]);
          } else {
            // Linux: open parent directory
            const parentDir = resolved.substring(0, resolved.lastIndexOf('/'));
            Bun.spawn(['xdg-open', parentDir]);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to open' },
            500
          );
        }
      }

      // Open absolute path in Finder/Explorer (for user-level skills/commands)
      if (pathname === '/agent/open-path' && request.method === 'POST') {
        try {
          const payload = await request.json() as { fullPath?: string };
          const fullPath = payload?.fullPath?.trim();

          if (!fullPath) {
            return jsonResponse({ success: false, error: 'fullPath is required.' }, 400);
          }

          // Security: Only allow paths under home directory or temp directories
          const homeDir = getHomeDirOrNull() || '';
          const resolvedPath = resolve(fullPath);
          // Normalize both paths for comparison (handles Windows paths)
          const normalizedResolved = resolvedPath.toLowerCase().replace(/\\/g, '/');
          const normalizedHome = homeDir.toLowerCase().replace(/\\/g, '/');
          const isUnderHome = normalizedHome && normalizedResolved.startsWith(normalizedHome);
          const isUnderTmp = normalizedResolved.startsWith('/tmp') || normalizedResolved.includes('/temp/');
          if (!isUnderHome && !isUnderTmp) {
            return jsonResponse({ success: false, error: 'Path not allowed.' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          const isMac = process.platform === 'darwin';
          const isWin = process.platform === 'win32';

          if (isMac) {
            Bun.spawn(['open', '-R', resolvedPath]);
          } else if (isWin) {
            Bun.spawn(['explorer', '/select,', resolvedPath]);
          } else {
            const parentDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
            Bun.spawn(['xdg-open', parentDir]);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to open' },
            500
          );
        }
      }

      // Import files to a specific directory
      if (pathname === '/agent/import' && request.method === 'POST') {
        const targetDir = url.searchParams.get('targetDir') ?? '';
        const resolvedTarget = targetDir ? resolveAgentPath(currentAgentDir, targetDir) : currentAgentDir;

        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid target directory.' }, 400);
        }

        try {
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];

          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }

          await mkdir(resolvedTarget, { recursive: true });
          const saved: string[] = [];

          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await Bun.write(destination, file);
            saved.push(relative(currentAgentDir, destination));
          }

          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Import failed' },
            500
          );
        }
      }

      // ============= FILE MANAGEMENT API =============

      // POST /api/files/import-base64 - Import files via base64 encoding (works in Tauri)
      if (pathname === '/api/files/import-base64' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            files: Array<{ name: string; content: string }>; // content is base64 encoded
            targetDir?: string;
          };

          const { files, targetDir = '' } = payload;

          if (!files || files.length === 0) {
            return jsonResponse({ success: false, error: 'No files provided' }, 400);
          }

          const resolvedTarget = targetDir
            ? resolveAgentPath(currentAgentDir, targetDir)
            : currentAgentDir;

          if (!resolvedTarget) {
            return jsonResponse({ success: false, error: 'Invalid target directory' }, 400);
          }

          // Ensure target directory exists
          await mkdir(resolvedTarget, { recursive: true });

          const saved: string[] = [];

          for (const file of files) {
            // Sanitize filename
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');

            // Generate unique name if file exists
            let finalName = safeName;
            let counter = 1;
            const ext = extname(safeName);
            const base = basename(safeName, ext);
            while (existsSync(join(resolvedTarget, finalName))) {
              finalName = `${base}_${counter}${ext}`;
              counter++;
            }

            const destination = join(resolvedTarget, finalName);

            // Decode base64 and write file
            const buffer = Buffer.from(file.content, 'base64');
            await Bun.write(destination, buffer);

            saved.push(relative(currentAgentDir, destination));
          }

          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          console.error('[api/files/import-base64] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Import failed' },
            500
          );
        }
      }

      // POST /api/files/copy - Copy external files to workspace
      if (pathname === '/api/files/copy' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            sourcePaths: string[];
            targetDir: string;
            autoRename?: boolean;
          };

          const { sourcePaths, targetDir, autoRename = true } = payload;

          if (!sourcePaths || sourcePaths.length === 0) {
            return jsonResponse({ success: false, error: 'sourcePaths is required' }, 400);
          }

          const resolvedTarget = targetDir
            ? resolveAgentPath(currentAgentDir, targetDir)
            : currentAgentDir;

          if (!resolvedTarget) {
            return jsonResponse({ success: false, error: 'Invalid target directory' }, 400);
          }

          // Ensure target directory exists
          await mkdir(resolvedTarget, { recursive: true });

          const copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }> = [];

          // Helper function to generate unique filename
          const getUniqueName = (dir: string, name: string): { name: string; renamed: boolean } => {
            const ext = extname(name);
            const base = basename(name, ext);
            let finalName = name;
            let counter = 1;
            let renamed = false;

            while (existsSync(join(dir, finalName))) {
              if (!autoRename) {
                throw new Error(`File ${name} already exists`);
              }
              finalName = `${base}_${counter}${ext}`;
              counter++;
              renamed = true;
            }

            return { name: finalName, renamed };
          };

          // Helper function to copy directory recursively
          const copyDirectory = async (src: string, dest: string) => {
            await mkdir(dest, { recursive: true });
            const entries = readdirSync(src, { withFileTypes: true });

            for (const entry of entries) {
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);

              if (entry.isDirectory()) {
                await copyDirectory(srcPath, destPath);
              } else {
                const file = Bun.file(srcPath);
                await Bun.write(destPath, file);
              }
            }
          };

          for (const sourcePath of sourcePaths) {
            // Validate source path exists
            if (!existsSync(sourcePath)) {
              console.warn(`[api/files/copy] Source not found: ${sourcePath}`);
              continue;
            }

            const sourceInfo = await stat(sourcePath);
            const sourceName = basename(sourcePath);

            if (sourceInfo.isDirectory()) {
              // Copy directory
              const { name: uniqueName, renamed } = getUniqueName(resolvedTarget, sourceName);
              const destPath = join(resolvedTarget, uniqueName);
              await copyDirectory(sourcePath, destPath);
              copiedFiles.push({
                sourcePath,
                targetPath: relative(currentAgentDir, destPath),
                renamed,
              });
            } else {
              // Copy file
              const { name: uniqueName, renamed } = getUniqueName(resolvedTarget, sourceName);
              const destPath = join(resolvedTarget, uniqueName);
              const file = Bun.file(sourcePath);
              await Bun.write(destPath, file);
              copiedFiles.push({
                sourcePath,
                targetPath: relative(currentAgentDir, destPath),
                renamed,
              });
            }
          }

          return jsonResponse({ success: true, copiedFiles });
        } catch (error) {
          console.error('[api/files/copy] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Copy failed' },
            500
          );
        }
      }

      // POST /api/files/add-gitignore - Add pattern to .gitignore
      if (pathname === '/api/files/add-gitignore' && request.method === 'POST') {
        try {
          const payload = await request.json() as { pattern: string };
          const { pattern } = payload;

          if (!pattern || typeof pattern !== 'string') {
            return jsonResponse({ success: false, error: 'pattern is required' }, 400);
          }

          const gitignorePath = join(currentAgentDir, '.gitignore');

          // Check if .gitignore exists
          if (!existsSync(gitignorePath)) {
            // Create new .gitignore with the pattern
            writeFileSync(gitignorePath, `${pattern}\n`);
            return jsonResponse({ success: true, added: true, reason: 'created new .gitignore' });
          }

          // Read existing content
          const content = readFileSync(gitignorePath, 'utf-8');
          const lines = content.split('\n');

          // Check if pattern already exists
          const trimmedPattern = pattern.trim();
          const patternExists = lines.some(line => line.trim() === trimmedPattern);

          if (patternExists) {
            return jsonResponse({ success: true, added: false, reason: 'pattern already exists' });
          }

          // Append pattern to .gitignore
          const newContent = content.endsWith('\n')
            ? `${content}${pattern}\n`
            : `${content}\n${pattern}\n`;

          writeFileSync(gitignorePath, newContent);
          return jsonResponse({ success: true, added: true });
        } catch (error) {
          console.error('[api/files/add-gitignore] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update .gitignore' },
            500
          );
        }
      }

      // POST /api/files/read-as-base64 - Read external files and return as base64 (for Tauri image drops)
      if (pathname === '/api/files/read-as-base64' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            paths: string[];
          };

          const { paths } = payload;

          if (!paths || paths.length === 0) {
            return jsonResponse({ success: false, error: 'paths is required' }, 400);
          }

          const results: Array<{
            path: string;
            name: string;
            mimeType: string;
            data: string; // base64
            error?: string;
          }> = [];

          for (const filePath of paths) {
            try {
              // Validate file exists
              if (!existsSync(filePath)) {
                results.push({
                  path: filePath,
                  name: basename(filePath),
                  mimeType: '',
                  data: '',
                  error: 'File not found',
                });
                continue;
              }

              // Check file size (limit to 10MB for images)
              const fileInfo = await stat(filePath);
              if (fileInfo.size > 10 * 1024 * 1024) {
                results.push({
                  path: filePath,
                  name: basename(filePath),
                  mimeType: '',
                  data: '',
                  error: 'File too large (max 10MB)',
                });
                continue;
              }

              // Read file
              const file = Bun.file(filePath);
              const arrayBuffer = await file.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString('base64');

              // Determine MIME type from extension
              const ext = extname(filePath).toLowerCase().slice(1);
              const mimeTypes: Record<string, string> = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                webp: 'image/webp',
                svg: 'image/svg+xml',
                bmp: 'image/bmp',
                ico: 'image/x-icon',
              };
              const mimeType = mimeTypes[ext] || file.type || 'application/octet-stream';

              results.push({
                path: filePath,
                name: basename(filePath),
                mimeType,
                data: base64,
              });
            } catch (err) {
              results.push({
                path: filePath,
                name: basename(filePath),
                mimeType: '',
                data: '',
                error: err instanceof Error ? err.message : 'Read failed',
              });
            }
          }

          return jsonResponse({ success: true, files: results });
        } catch (error) {
          console.error('[api/files/read-as-base64] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Read failed' },
            500
          );
        }
      }

      // ============= END FILE MANAGEMENT API =============

      // ============= UNIFIED LOGGING API =============

      // POST /api/unified-log - Receive frontend logs for persistence
      if (pathname === '/api/unified-log' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            entries?: Array<{
              source: 'react' | 'bun' | 'rust';
              level: 'info' | 'warn' | 'error' | 'debug';
              message: string;
              timestamp: string;
            }>;
          };

          if (payload.entries && Array.isArray(payload.entries)) {
            appendUnifiedLogBatch(payload.entries);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log'
          }, 500);
        }
      }

      // ============= PROVIDER VERIFICATION API =============

      // POST /api/provider/verify - Verify API key by sending a test request
      if (pathname === '/api/provider/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            baseUrl?: string;
            apiKey?: string;
            model?: string;
          };

          const { baseUrl, apiKey, model } = payload;

          if (!baseUrl || !apiKey) {
            return jsonResponse({ success: false, error: 'baseUrl and apiKey are required.' }, 400);
          }

          // Use provided model or default to a reasonable fallback
          const testModel = model || 'claude-sonnet-4-6';

          console.log(`[api/provider/verify] =========================`);
          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);
          console.log(`[api/provider/verify] apiKey: ${apiKey.slice(0, 10)}...`);
          console.log(`[api/provider/verify] model: ${testModel}`);

          const result = await verifyApiKey(baseUrl, apiKey, testModel);

          console.log(`[api/provider/verify] result:`, JSON.stringify(result));
          console.log(`[api/provider/verify] =========================`);

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/provider/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // GET /api/subscription/status - Check Anthropic local subscription status
      if (pathname === '/api/subscription/status' && request.method === 'GET') {
        try {
          const status = checkAnthropicSubscription();
          return jsonResponse(status);
        } catch (error) {
          console.error('[api/subscription/status] Error:', error);
          return jsonResponse(
            { available: false, error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/subscription/verify - Verify Anthropic subscription by sending test request via SDK
      if (pathname === '/api/subscription/verify' && request.method === 'POST') {
        try {
          console.log('[api/subscription/verify] Starting verification...');
          const result = await verifySubscription();
          console.log('[api/subscription/verify] Result:', JSON.stringify(result));
          return jsonResponse(result);
        } catch (error) {
          console.error('[api/subscription/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // GET /api/git/branch - Get current git branch for the workspace
      if (pathname === '/api/git/branch' && request.method === 'GET') {
        try {
          const branch = getGitBranch(currentAgentDir);
          return jsonResponse({ branch: branch || null });
        } catch (error) {
          console.error('[api/git/branch] Error:', error);
          return jsonResponse({ branch: null }, 200); // Non-fatal, just return null
        }
      }

      // GET /api/assets/qr-code - Fetch QR code image with local caching
      // Downloads from CDN on first launch and caches locally for subsequent requests
      // Cache refreshes every hour to get updated QR codes from cloud
      if (pathname === '/api/assets/qr-code' && request.method === 'GET') {
        try {
          const QR_CODE_URL = 'https://download.myagents.io/assets/feedback_qr_code.png';

          // Use tmpdir for cache (simple and safe approach)
          const CACHE_DIR = join(tmpdir(), 'myagents-cache');
          const CACHE_FILE = join(CACHE_DIR, 'feedback_qr_code.png');
          const LOCK_FILE = `${CACHE_FILE}.lock`;
          const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour (faster updates)

          const startTime = Date.now();
          let needsDownload = true;

          // Check if cached file exists and is fresh
          if (existsSync(CACHE_FILE)) {
            const stats = statSync(CACHE_FILE);
            const age = Date.now() - stats.mtimeMs;
            if (age < CACHE_MAX_AGE_MS) {
              needsDownload = false;
              console.log(`[api/assets/qr-code] Cache hit (age: ${Math.round(age / 1000 / 60)}min)`);
            } else {
              console.log(`[api/assets/qr-code] Cache expired (age: ${Math.round(age / 1000 / 60)}min), re-downloading`);
            }
          } else {
            console.log('[api/assets/qr-code] Cache miss, downloading');
          }

          // Download if needed (with file lock to prevent concurrent writes)
          if (needsDownload) {
            // Check if another process is already downloading
            if (existsSync(LOCK_FILE)) {
              const lockStats = statSync(LOCK_FILE);
              const lockAge = Date.now() - lockStats.mtimeMs;
              if (lockAge < 30000) { // Lock valid for 30s
                console.log('[api/assets/qr-code] Download in progress, waiting...');
                // Wait and use existing cache if available
                if (existsSync(CACHE_FILE)) {
                  const imageBuffer = readFileSync(CACHE_FILE);
                  const base64 = imageBuffer.toString('base64');
                  return jsonResponse({
                    success: true,
                    dataUrl: `data:image/png;base64,${base64}`
                  });
                }
              } else {
                // Stale lock, remove it
                rmSync(LOCK_FILE, { force: true });
              }
            }

            // Acquire lock
            if (!existsSync(CACHE_DIR)) {
              mkdirSync(CACHE_DIR, { recursive: true });
            }
            writeFileSync(LOCK_FILE, String(Date.now()));

            try {
              const downloadStartTime = Date.now();
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

              const response = await fetch(QR_CODE_URL, { signal: controller.signal });
              clearTimeout(timeoutId);

              if (!response.ok) {
                // If download fails but cache exists, use stale cache
                if (existsSync(CACHE_FILE)) {
                  console.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using stale cache`);
                } else {
                  throw new Error(`下载失败: HTTP ${response.status}`);
                }
              } else {
                // Save to cache using atomic write pattern
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const downloadTime = Date.now() - downloadStartTime;

                // Write to temp file first
                const tmpFile = `${CACHE_FILE}.${Date.now()}.tmp`;
                writeFileSync(tmpFile, buffer);

                // Atomic rename (POSIX guarantee)
                renameSync(tmpFile, CACHE_FILE);
                console.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${downloadTime}ms)`);
              }
            } finally {
              // Release lock
              rmSync(LOCK_FILE, { force: true });
            }
          }

          // Read from cache and return as base64
          if (!existsSync(CACHE_FILE)) {
            return jsonResponse({ success: false, error: 'QR code not available' }, 503);
          }

          const imageBuffer = readFileSync(CACHE_FILE);
          const base64 = imageBuffer.toString('base64');
          const mimeType = 'image/png';
          const totalTime = Date.now() - startTime;

          console.log(`[api/assets/qr-code] Request completed in ${totalTime}ms`);

          return jsonResponse({
            success: true,
            dataUrl: `data:${mimeType};base64,${base64}`
          });
        } catch (error) {
          console.error('[api/assets/qr-code] Error:', error);
          const isTimeout = error instanceof Error && error.name === 'AbortError';
          return jsonResponse(
            { success: false, error: isTimeout ? '网络请求超时' : (error instanceof Error ? error.message : '加载失败') },
            isTimeout ? 504 : 503
          );
        }
      }

      // ============= END PROVIDER VERIFICATION API =============

      // ============= MCP API =============

      // POST /api/mcp/set - Set MCP servers for current workspace
      if (pathname === '/api/mcp/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { servers?: McpServerDefinition[] };
          const servers = payload?.servers ?? [];
          setMcpServers(servers);
          return jsonResponse({ success: true, servers: servers.map(s => s.id) });
        } catch (error) {
          console.error('[api/mcp/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },
            500
          );
        }
      }

      // GET /api/mcp - Get current MCP servers
      if (pathname === '/api/mcp' && request.method === 'GET') {
        try {
          const servers = getMcpServers();
          return jsonResponse({ success: true, servers });
        } catch (error) {
          console.error('[api/mcp] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },
            500
          );
        }
      }

      // POST /api/mcp/enable - Validate and enable MCP server
      // For preset MCP (npx): warmup bun cache
      // For custom MCP: check if command exists
      if (pathname === '/api/mcp/enable' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            server: McpServerDefinition;
          };

          const server = payload.server;
          if (!server) {
            return jsonResponse({ success: false, error: 'Missing server' }, 400);
          }

          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${server.command}`);

          // SSE/HTTP types: directly enable, no validation needed
          if (server.type === 'sse' || server.type === 'http') {
            return jsonResponse({ success: true });
          }

          // stdio type: validate command
          if (server.type === 'stdio' && server.command) {
            const command = server.command;

            // Preset MCP (isBuiltin: true) with npx → warmup with bundled bun
            if (server.isBuiltin && command === 'npx') {
              const { getBundledRuntimePath, isBunRuntime } = await import('./utils/runtime');
              const runtime = getBundledRuntimePath();

              if (!isBunRuntime(runtime)) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'runtime_error',
                    message: '内置运行时不可用',
                  }
                });
              }

              // Warmup: run bun x <package> --help to download and cache
              const args = server.args || [];
              console.log(`[api/mcp/enable] Warming up cache: ${runtime} x ${args.join(' ')}`);

              const { spawn } = await import('child_process');
              const { getShellEnv } = await import('./utils/shell');

              return new Promise<Response>((resolve) => {
                const proc = spawn(runtime, ['x', ...args, '--help'], {
                  env: getShellEnv(),
                  timeout: 120000, // 2 min timeout
                  stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stderr = '';
                proc.stderr?.on('data', (data) => { stderr += data; });

                proc.on('error', (err) => {
                  console.error('[api/mcp/enable] Warmup error:', err);
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'warmup_failed',
                      message: `预热失败: ${err.message}`,
                    }
                  }));
                });

                proc.on('close', (code) => {
                  console.log(`[api/mcp/enable] Warmup exited with code ${code}`);
                  // Code 0 or 1 is acceptable (--help may return 1 for some packages)
                  // Check stderr for real errors (package not found, network issues, etc.)
                  const stderrLower = stderr.toLowerCase();
                  const errorKeywords = [
                    '404',           // HTTP 404 not found
                    'not found',     // Package not found
                    'enotfound',     // DNS resolution failed
                    'etimedout',     // Connection timeout
                    'econnrefused',  // Connection refused
                    'econnreset',    // Connection reset
                    'err!',          // npm error indicator
                    'error:',        // General error prefix
                  ];
                  const hasError = errorKeywords.some(kw => stderrLower.includes(kw));

                  if (hasError) {
                    // Determine error type based on stderr content
                    const isNetworkError = ['enotfound', 'etimedout', 'econnrefused', 'econnreset'].some(
                      kw => stderrLower.includes(kw)
                    );
                    resolve(jsonResponse({
                      success: false,
                      error: {
                        type: isNetworkError ? 'warmup_failed' : 'package_not_found',
                        message: isNetworkError
                          ? '网络连接失败，请检查网络设置'
                          : '包不存在或无法下载，请检查包名',
                      }
                    }));
                  } else {
                    resolve(jsonResponse({ success: true }));
                  }
                });
              });
            }

            // Custom MCP or non-npx command → check if command exists in user's shell PATH
            const { spawn } = await import('child_process');
            const { getShellEnv } = await import('./utils/shell');
            const checkCmd = process.platform === 'win32' ? 'where' : 'which';

            return new Promise<Response>((resolve) => {
              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });

              proc.on('error', () => {
                resolve(jsonResponse({
                  success: false,
                  error: {
                    type: 'command_not_found',
                    command,
                    message: `命令 "${command}" 未找到`,
                    ...getCommandDownloadInfo(command),
                  }
                }));
              });

              proc.on('close', (code) => {
                if (code === 0) {
                  resolve(jsonResponse({ success: true }));
                } else {
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'command_not_found',
                      command,
                      message: `命令 "${command}" 未找到`,
                      ...getCommandDownloadInfo(command),
                    }
                  }));
                }
              });
            });
          }

          // Default: allow
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/enable] Error:', error);
          return jsonResponse({
            success: false,
            error: {
              type: 'unknown',
              message: error instanceof Error ? error.message : '启用失败',
            }
          }, 500);
        }
      }

      // POST /api/permission/respond - Handle user permission decision
      if (pathname === '/api/permission/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          const { handlePermissionResponse } = await import('./agent-session');
          const success = handlePermissionResponse(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/permission] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/ask-user-question/respond - Handle user's answers to AskUserQuestion
      if (pathname === '/api/ask-user-question/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            answers: Record<string, string> | null;  // null means user cancelled
          };

          const { handleAskUserQuestionResponse } = await import('./agent-session');
          const success = handleAskUserQuestionResponse(payload.requestId, payload.answers);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/ask-user-question] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }
      // ============= END MCP API =============

      // ============= SLASH COMMANDS API =============
      // GET /api/commands - Get all available slash commands and skills
      if (pathname === '/api/commands' && request.method === 'GET') {
        try {
          // Start with empty array, builtin commands added at the end
          // Order: project commands -> user commands -> skills -> builtin (so custom can override builtin)
          const commands: SlashCommand[] = [];
          const homeDir = getHomeDirOrNull() || '';

          // ===== COMMANDS SCANNING =====
          // Helper function to scan commands from a directory
          const scanCommandsDir = (commandsDir: string, scope: 'user' | 'project') => {
            if (!existsSync(commandsDir)) return;
            try {
              const files = readdirSync(commandsDir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(commandsDir, file);
                try {
                  const content = readFileSync(filePath, 'utf-8');
                  const { frontmatter } = parseFullCommandContent(content);
                  const fileName = extractCommandName(file);
                  commands.push({
                    name: frontmatter.name || fileName,  // Prefer frontmatter name
                    description: frontmatter.description || '',
                    source: 'custom',
                    scope,
                    path: filePath,
                  });
                } catch (err) {
                  console.warn(`[api/commands] Error reading command ${file}:`, err);
                }
              }
            } catch (err) {
              console.warn(`[api/commands] Error scanning commands dir ${commandsDir}:`, err);
            }
          };

          // 1. Scan project-level commands (.claude/commands/) - highest priority
          const claudeCommandsDir = join(currentAgentDir, '.claude', 'commands');
          scanCommandsDir(claudeCommandsDir, 'project');

          // 2. Scan user-level commands (~/.myagents/commands/)
          const userCommandsDir = join(homeDir, '.myagents', 'commands');
          scanCommandsDir(userCommandsDir, 'user');
          // ===== END COMMANDS SCANNING =====

          // ===== SKILLS SCANNING =====
          // Helper function to scan skills from a directory
          const skillsConfig = readSkillsConfig();
          const scanSkillsDir = (skillsDir: string, scope: 'user' | 'project') => {
            if (!existsSync(skillsDir)) return;
            try {
              const skillFolders = readdirSync(skillsDir, { withFileTypes: true });
              for (const folder of skillFolders) {
                if (!folder.isDirectory()) continue;
                // Skip disabled user-level skills in slash commands
                if (scope === 'user' && skillsConfig.disabled.includes(folder.name)) continue;
                const skillMdPath = join(skillsDir, folder.name, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                try {
                  const content = readFileSync(skillMdPath, 'utf-8');
                  const { name, description } = parseSkillFrontmatter(content);
                  // Use parsed name or fall back to folder name
                  const skillName = name || folder.name;
                  commands.push({
                    name: skillName,
                    description: description || '',
                    source: 'skill',
                    scope,
                    path: skillMdPath,
                    folderName: folder.name, // Actual folder name for copy operations
                  });
                } catch (err) {
                  console.warn(`[api/commands] Error reading skill ${folder.name}:`, err);
                }
              }
            } catch (err) {
              console.warn(`[api/commands] Error scanning skills dir ${skillsDir}:`, err);
            }
          };

          // 1. Scan project-level skills (.claude/skills/) - higher priority
          const projectSkillsDir = join(currentAgentDir, '.claude', 'skills');
          scanSkillsDir(projectSkillsDir, 'project');

          // 2. Scan user-level skills (~/.myagents/skills/) - lower priority
          const userSkillsDir = join(homeDir, '.myagents', 'skills');
          scanSkillsDir(userSkillsDir, 'user');
          // ===== END SKILLS SCANNING =====

          // 3. Add builtin commands at the end (so custom/skills can override them)
          commands.push(...BUILTIN_SLASH_COMMANDS);

          // Deduplicate commands by name (keep first occurrence - custom/skills take precedence over builtin)
          const seenNames = new Set<string>();
          const uniqueCommands = commands.filter(cmd => {
            if (seenNames.has(cmd.name)) {
              return false;
            }
            seenNames.add(cmd.name);
            return true;
          });

          return jsonResponse({ success: true, commands: uniqueCommands });
        } catch (error) {
          console.error('[api/commands] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get commands' },
            500
          );
        }
      }

      // ============= CLAUDE.md API =============
      // GET /api/claude-md - Read CLAUDE.md from workspace
      if (pathname === '/api/claude-md' && request.method === 'GET') {
        try {
          // Get agentDir from query param, fallback to currentAgentDir
          // Get agentDir from query param, fallback to currentAgentDir
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const claudeMdPath = join(targetDir, 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) {
            return jsonResponse({
              success: true,
              exists: false,
              path: claudeMdPath,
              content: ''
            });
          }
          const content = readFileSync(claudeMdPath, 'utf-8');
          return jsonResponse({
            success: true,
            exists: true,
            path: claudeMdPath,
            content
          });
        } catch (error) {
          console.error('[api/claude-md] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read CLAUDE.md' },
            500
          );
        }
      }

      // POST /api/claude-md - Write CLAUDE.md to workspace
      if (pathname === '/api/claude-md' && request.method === 'POST') {
        try {
          const payload = await request.json() as { content: string };
          // Get agentDir from query param, fallback to currentAgentDir
          // Get agentDir from query param, fallback to currentAgentDir
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const claudeMdPath = join(targetDir, 'CLAUDE.md');
          writeFileSync(claudeMdPath, payload.content, 'utf-8');
          return jsonResponse({ success: true, path: claudeMdPath });
        } catch (error) {
          console.error('[api/claude-md] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to write CLAUDE.md' },
            500
          );
        }
      }

      // ============= SKILLS MANAGEMENT API =============
      // Security: Validate item names to prevent path traversal attacks
      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security
      const isValidItemName = (name: string): boolean => {
        // Reject empty names
        if (!name || name.trim().length === 0) {
          return false;
        }
        // Reject path separators and parent directory references (security)
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          return false;
        }
        // Reject Windows reserved characters: < > : " | ? *
        // These cause issues on Windows file systems
        if (/[<>:"|?*]/.test(name)) {
          return false;
        }
        // Reject control characters (0x00-0x1F, 0x7F)
        // eslint-disable-next-line no-control-regex -- Intentional control character detection for filename validation
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return false;
        }
        // Reject names that are only dots (., ..) or start/end with spaces
        if (/^\.+$/.test(name) || name !== name.trim()) {
          return false;
        }
        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (isWindowsReservedName(name)) {
          return false;
        }
        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation
        return true;
      };

      // Cross-platform home directory for user skills/commands
      const homeDir = getHomeDirOrNull() || '';
      const userSkillsBaseDir = join(homeDir, '.myagents', 'skills');
      const userCommandsBaseDir = join(homeDir, '.myagents', 'commands');

      // Helper: Get project base directories (supports explicit agentDir parameter)
      // Security: validates agentDir to prevent path traversal attacks
      const getProjectBaseDirs = (queryAgentDir: string | null) => {
        // If explicit agentDir provided, validate it first
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          // Invalid agentDir, fall back to currentAgentDir
          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);
          queryAgentDir = null;
        }
        // Use validated agentDir if provided, otherwise fall back to currentAgentDir
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return {
          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',
          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',
        };
      };

      // Default project paths (using currentAgentDir)
      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);
      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';
      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';

      // GET /api/skills - List all skills (with scope filter)
      if (pathname === '/api/skills' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const skillsConfigForList = readSkillsConfig();
          const skills: Array<{
            name: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            folderName: string;
            author?: string;
            enabled?: boolean;
          }> = [];

          const scanSkills = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const folders = readdirSync(dir, { withFileTypes: true });
              for (const folder of folders) {
                if (!folder.isDirectory()) continue;
                const skillMdPath = join(dir, folder.name, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                const content = readFileSync(skillMdPath, 'utf-8');
                const { name, description, author } = parseSkillFrontmatter(content);
                skills.push({
                  name: name || folder.name,
                  description: description || '',
                  scope: scopeType,
                  path: skillMdPath,
                  folderName: folder.name,
                  author,
                  enabled: scopeType === 'project' ? true : !skillsConfigForList.disabled.includes(folder.name),
                });
              }
            } catch (scanError) {
              console.warn(`[api/skills] Error scanning ${scopeType} skills:`, scanError);
            }
          };

          if ((scope === 'all' || scope === 'project') && projectSkillsBaseDir) {
            scanSkills(projectSkillsBaseDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanSkills(userSkillsBaseDir, 'user');
          }

          return jsonResponse({ success: true, skills });
        } catch (error) {
          console.error('[api/skills] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' },
            500
          );
        }
      }

      // POST /api/skill/toggle-enable - Enable/disable a user-level skill
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {
        try {
          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };
          if (!folderName || typeof folderName !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
          const config = readSkillsConfig();
          if (enabled) {
            config.disabled = config.disabled.filter(n => n !== folderName);
          } else {
            if (!config.disabled.includes(folderName)) config.disabled.push(folderName);
          }
          writeSkillsConfig(config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill/toggle-enable] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },
            500
          );
        }
      }

      // GET /api/skill/sync-check - Check if there are skills to sync from Claude Code
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-check' && request.method === 'GET') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get folders in Claude Code skills directory
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get existing folders in MyAgents skills directory
          const myagentsFolders = new Set<string>();
          if (existsSync(userSkillsBaseDir)) {
            const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                myagentsFolders.add(entry.name);
              }
            }
          }

          // Find folders that can be synced (exist in Claude but not in MyAgents)
          const syncableFolders = claudeFolders.filter(folder => !myagentsFolders.has(folder));

          return jsonResponse({
            canSync: syncableFolders.length > 0,
            count: syncableFolders.length,
            folders: syncableFolders
          });
        } catch (error) {
          console.error('[api/skill/sync-check] Error:', error);
          return jsonResponse(
            { canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/skill/sync-from-claude - Sync skills from Claude Code to MyAgents
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-from-claude' && request.method === 'POST') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, error: 'Claude Code skills directory not found' }, 404);
          }

          // Get folders in Claude Code skills directory
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'No skills to sync' });
          }

          // Ensure MyAgents skills directory exists
          if (!existsSync(userSkillsBaseDir)) {
            mkdirSync(userSkillsBaseDir, { recursive: true });
          }

          // Get existing folders in MyAgents skills directory
          const myagentsFolders = new Set<string>();
          const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              myagentsFolders.add(entry.name);
            }
          }

          // Find folders that can be synced (filter out invalid folder names for security)
          const syncableFolders = claudeFolders.filter(folder =>
            !myagentsFolders.has(folder) && isValidFolderName(folder)
          );

          if (syncableFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'All skills already exist' });
          }

          // Copy each syncable folder
          let synced = 0;
          let failed = 0;
          const errors: string[] = [];

          for (const folder of syncableFolders) {
            const srcDir = join(claudeSkillsDir, folder);
            const destDir = join(userSkillsBaseDir, folder);

            try {
              copyDirRecursiveSync(srcDir, destDir, '[api/skill/sync-from-claude]');
              synced++;
              if (process.env.DEBUG === '1') {
                console.log(`[api/skill/sync-from-claude] Synced skill "${folder}"`);
              }
            } catch (copyError) {
              failed++;
              const errorMsg = copyError instanceof Error ? copyError.message : 'Unknown error';
              errors.push(`${folder}: ${errorMsg}`);
              console.error(`[api/skill/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          return jsonResponse({
            success: true,
            synced,
            failed,
            errors: errors.length > 0 ? errors : undefined
          });
        } catch (error) {
          console.error('[api/skill/sync-from-claude] Error:', error);
          return jsonResponse(
            { success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' },
            500
          );
        }
      }

      // GET /api/skill/:name - Get skill detail
      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillPath = join(baseDir, skillName, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          const content = readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFullSkillContent(content);

          return jsonResponse({
            success: true,
            skill: {
              name: frontmatter.name || skillName,
              folderName: skillName,
              path: skillPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },
            500
          );
        }
      }

      // PUT /api/skill/:name - Update skill (with optional folder rename)
      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<SkillFrontmatter>;
            body: string;
            newFolderName?: string; // Optional: rename folder if provided
            agentDir?: string; // Optional: explicit project directory
          };

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          let currentFolderName = skillName;
          let skillDir = join(baseDir, currentFolderName);
          let skillPath = join(skillDir, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;

            // Validate new folder name
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }

            const newSkillDir = join(baseDir, newFolderName);

            // Check for conflict
            if (existsSync(newSkillDir)) {
              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.
            const content = serializeSkillContent(payload.frontmatter, payload.body);

            // Rename the folder
            renameSync(skillDir, newSkillDir);
            skillDir = newSkillDir;
            skillPath = join(skillDir, 'SKILL.md');
            currentFolderName = newFolderName;

            // Write content to new location
            writeFileSync(skillPath, content, 'utf-8');

            return jsonResponse({
              success: true,
              path: skillPath,
              folderName: currentFolderName,
              fullPath: skillDir
            });
          }

          // No rename, just update content
          const content = serializeSkillContent(payload.frontmatter, payload.body);
          writeFileSync(skillPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: skillPath,
            folderName: currentFolderName,
            fullPath: skillDir
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            500
          );
        }
      }

      // DELETE /api/skill/:name - Delete skill
      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, skillName);

          if (!existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          rmSync(skillDir, { recursive: true, force: true });
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            500
          );
        }
      }

      // POST /api/skill/create - Create new skill
      if (pathname === '/api/skill/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string; // Optional: explicit project directory
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for folder (supports Unicode)
          const folderName = sanitizeFolderName(payload.name);
          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, folderName);

          if (existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill already exists' }, 409);
          }

          // Create directory structure
          mkdirSync(skillDir, { recursive: true });

          // Create SKILL.md with default content
          const frontmatter: Partial<SkillFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your skill instructions here.`;
          const content = serializeSkillContent(frontmatter, body);

          const skillPath = join(skillDir, 'SKILL.md');
          writeFileSync(skillPath, content, 'utf-8');

          return jsonResponse({ success: true, path: skillPath, folderName });
        } catch (error) {
          console.error('[api/skill/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create skill' },
            500
          );
        }
      }

      // POST /api/skill/copy - Copy user-level skill to project directory
      // This is needed because SDK only reads skills from <project>/.claude/skills/
      if (pathname === '/api/skill/copy' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            skillName: string;
            agentDir: string;
          };

          if (!payload.skillName || !payload.agentDir) {
            return jsonResponse({ success: false, error: 'skillName and agentDir are required' }, 400);
          }

          // Security: Validate skillName doesn't contain path traversal characters
          if (payload.skillName.includes('/') || payload.skillName.includes('\\') || payload.skillName.includes('..')) {
            return jsonResponse({ success: false, error: 'Invalid skill name: path traversal not allowed' }, 400);
          }

          // Security: Validate agentDir is a valid directory
          const resolvedAgentDir = resolve(payload.agentDir);
          if (!existsSync(resolvedAgentDir) || !statSync(resolvedAgentDir).isDirectory()) {
            return jsonResponse({ success: false, error: 'Invalid agent directory' }, 400);
          }

          const srcDir = join(userSkillsBaseDir, payload.skillName);
          const destBaseDir = join(resolvedAgentDir, '.claude', 'skills');
          const destDir = join(destBaseDir, payload.skillName);

          // Validate source exists and is a directory
          if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
            return jsonResponse({ success: false, error: `User skill "${payload.skillName}" not found` }, 404);
          }

          // Check if already exists in project
          if (existsSync(destDir)) {
            return jsonResponse({ success: true, alreadyExists: true, message: 'Skill already exists in project' });
          }

          // Create destination directory structure
          mkdirSync(destBaseDir, { recursive: true });

          // Copy the skill directory using shared utility
          copyDirRecursiveSync(srcDir, destDir, '[api/skill/copy]');

          if (process.env.DEBUG === '1') {
            console.log(`[api/skill/copy] Copied skill "${payload.skillName}" to ${destDir}`);
          }
          return jsonResponse({ success: true, path: destDir });
        } catch (error) {
          console.error('[api/skill/copy] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill' },
            500
          );
        }
      }

      // POST /api/skill/upload - Upload skill from file (.zip, .skill, .md)
      if (pathname === '/api/skill/upload' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            filename: string;
            content: string; // Base64 encoded file content
            scope: 'user' | 'project';
          };

          if (!payload.filename || !payload.content) {
            return jsonResponse({ success: false, error: 'Filename and content are required' }, 400);
          }

          const ext = extname(payload.filename).toLowerCase();
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Decode base64 content to buffer
          const fileBuffer = Buffer.from(payload.content, 'base64');

          // Helper: Try to extract name from SKILL.md content
          const extractNameFromContent = (content: string): string | null => {
            try {
              const parsed = parseFullSkillContent(content);
              if (parsed.frontmatter.name) {
                return parsed.frontmatter.name;
              }
            } catch {
              // Ignore parse errors
            }
            return null;
          };

          if (ext === '.zip' || ext === '.skill') {
            // Handle zip/skill files - extract to skills directory
            try {
              const zip = new AdmZip(fileBuffer);
              const entries = zip.getEntries();

              // Find the root folder name from zip (or use filename without extension)
              let rootFolderName = basename(payload.filename, ext);

              // Check if zip has a single root directory
              const topLevelDirs = new Set<string>();
              for (const entry of entries) {
                const parts = entry.entryName.split('/');
                if (parts[0] && parts[0] !== '__MACOSX') {
                  topLevelDirs.add(parts[0]);
                }
              }

              // If zip has a single root folder, use that as default folder name
              if (topLevelDirs.size === 1) {
                rootFolderName = Array.from(topLevelDirs)[0];
              }

              // Try to find and parse SKILL.md to get the name from frontmatter
              for (const entry of entries) {
                const entryName = entry.entryName.toLowerCase();
                if (entryName.endsWith('skill.md') && !entry.isDirectory) {
                  const mdContent = entry.getData().toString('utf-8');
                  const nameFromContent = extractNameFromContent(mdContent);
                  if (nameFromContent) {
                    rootFolderName = nameFromContent;
                    break;
                  }
                }
              }

              // Sanitize folder name (supports Unicode)
              const folderName = sanitizeFolderName(rootFolderName);
              const skillDir = join(baseDir, folderName);

              if (existsSync(skillDir)) {
                return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
              }

              // Create skill directory
              mkdirSync(skillDir, { recursive: true });

              // Extract files, handling nested structure
              for (const entry of entries) {
                // Skip __MACOSX folder and directory entries
                if (entry.entryName.startsWith('__MACOSX') || entry.isDirectory) continue;

                // Calculate target path - if zip has root folder, strip it
                let targetPath = entry.entryName;
                if (topLevelDirs.size === 1) {
                  const parts = targetPath.split('/');
                  parts.shift(); // Remove root folder
                  targetPath = parts.join('/');
                }

                if (!targetPath) continue;

                const fullPath = join(skillDir, targetPath);
                const dir = dirname(fullPath);

                // Create subdirectories if needed
                if (!existsSync(dir)) {
                  mkdirSync(dir, { recursive: true });
                }

                // Write file
                writeFileSync(fullPath, entry.getData());
              }

              return jsonResponse({
                success: true,
                folderName,
                path: skillDir,
                message: `已成功导入技能 "${folderName}"`
              });

            } catch (zipError) {
              console.error('[api/skill/upload] Zip extraction error:', zipError);
              return jsonResponse(
                { success: false, error: '无法解压文件，请确保是有效的 zip 文件' },
                400
              );
            }

          } else if (ext === '.md') {
            // Handle .md files - parse content and create folder
            const mdContent = fileBuffer.toString('utf-8');
            const mdFilename = basename(payload.filename, '.md');

            // Try to get name from frontmatter, fallback to filename
            const nameFromContent = extractNameFromContent(mdContent);
            const folderName = sanitizeFolderName(nameFromContent || mdFilename);
            const skillDir = join(baseDir, folderName);

            if (existsSync(skillDir)) {
              return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
            }

            // Create skill directory
            mkdirSync(skillDir, { recursive: true });

            // Write the md file as SKILL.md
            const skillPath = join(skillDir, 'SKILL.md');
            writeFileSync(skillPath, fileBuffer);

            return jsonResponse({
              success: true,
              folderName,
              path: skillPath,
              message: `已成功导入技能 "${folderName}"`
            });

          } else {
            return jsonResponse(
              { success: false, error: '不支持的文件类型，请上传 .zip、.skill 或 .md 文件' },
              400
            );
          }

        } catch (error) {
          console.error('[api/skill/upload] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to upload skill' },
            500
          );
        }
      }

      // POST /api/skill/import-folder - Import skill from a local folder path (Tauri only)
      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            folderPath: string;
            scope: 'user' | 'project';
          };

          if (!payload.folderPath) {
            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);
          }

          const sourcePath = payload.folderPath;
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Validate source folder exists
          if (!existsSync(sourcePath)) {
            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);
          }

          // Check if it's a directory
          try {
            const stats = statSync(sourcePath);
            if (!stats.isDirectory()) {
              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);
            }
          } catch {
            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);
          }

          // Check for SKILL.md at root
          const skillMdPath = join(sourcePath, 'SKILL.md');
          if (!existsSync(skillMdPath)) {
            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);
          }

          // Read SKILL.md to get the skill name
          const skillMdContent = readFileSync(skillMdPath, 'utf-8');
          let folderName = basename(sourcePath);

          // Try to extract name from SKILL.md frontmatter
          try {
            const parsed = parseFullSkillContent(skillMdContent);
            if (parsed.frontmatter.name) {
              folderName = parsed.frontmatter.name;
            }
          } catch {
            // Use folder name as fallback
          }

          // Sanitize folder name
          folderName = sanitizeFolderName(folderName);
          const targetDir = join(baseDir, folderName);

          // Check if skill already exists
          if (existsSync(targetDir)) {
            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
          }

          // Copy folder recursively
          const copyDir = (src: string, dest: string) => {
            mkdirSync(dest, { recursive: true });
            const entries = readdirSync(src);

            for (const entry of entries) {
              // Skip hidden files and __MACOSX
              if (entry.startsWith('.') || entry === '__MACOSX') continue;

              const srcPath = join(src, entry);
              const destPath = join(dest, entry);
              const stats = statSync(srcPath);

              if (stats.isDirectory()) {
                copyDir(srcPath, destPath);
              } else {
                // Copy file
                copyFileSync(srcPath, destPath);
              }
            }
          };

          copyDir(sourcePath, targetDir);

          return jsonResponse({
            success: true,
            folderName,
            path: targetDir,
            message: `已成功导入技能 "${folderName}"`
          });

        } catch (error) {
          console.error('[api/skill/import-folder] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },
            500
          );
        }
      }

      // ============= COMMANDS MANAGEMENT API =============
      // GET /api/command-items - List all commands
      if (pathname === '/api/command-items' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const commandItems: Array<{
            name: string;
            fileName: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            author?: string;
          }> = [];

          const scanCommands = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const files = readdirSync(dir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(dir, file);
                const content = readFileSync(filePath, 'utf-8');
                const { frontmatter } = parseFullCommandContent(content);
                const fileName = extractCommandName(file);
                commandItems.push({
                  name: frontmatter.name || fileName,  // Prefer frontmatter name
                  fileName,  // Always include actual file name for reference
                  description: frontmatter.description || '',
                  scope: scopeType,
                  path: filePath,
                  author: frontmatter.author,
                });
              }
            } catch (scanError) {
              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);
            }
          };

          if ((scope === 'all' || scope === 'project') && projectCommandsBaseDir) {
            scanCommands(projectCommandsBaseDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanCommands(userCommandsBaseDir, 'user');
          }

          return jsonResponse({ success: true, commands: commandItems });
        } catch (error) {
          console.error('[api/command-items] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },
            500
          );
        }
      }

      // GET /api/command-item/:name - Get command detail
      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          const content = readFileSync(cmdPath, 'utf-8');
          const { frontmatter, body } = parseFullCommandContent(content);

          return jsonResponse({
            success: true,
            command: {
              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name
              fileName: cmdName,  // Always return the actual file name for reference
              path: cmdPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },
            500
          );
        }
      }

      // PUT /api/command-item/:name - Update command
      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<CommandFrontmatter>;
            body: string;
            agentDir?: string; // Optional: explicit project directory
            newFileName?: string; // Optional: rename file if provided
          };

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;
          let currentFileName = cmdName;
          let cmdPath = join(baseDir, `${currentFileName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          // Handle file rename if newFileName is provided and different
          if (payload.newFileName && payload.newFileName !== currentFileName) {
            const newFileName = payload.newFileName;

            // Validate new file name
            if (!isValidItemName(newFileName)) {
              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
            }

            const newCmdPath = join(baseDir, `${newFileName}.md`);

            // Check for conflict
            if (existsSync(newCmdPath)) {
              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.
            const content = serializeCommandContent(payload.frontmatter, payload.body);

            // Rename the file
            renameSync(cmdPath, newCmdPath);
            cmdPath = newCmdPath;
            currentFileName = newFileName;

            // Write content to new location
            writeFileSync(cmdPath, content, 'utf-8');

            return jsonResponse({
              success: true,
              path: cmdPath,
              fileName: currentFileName
            });
          }

          // No rename, just update content
          const content = serializeCommandContent(payload.frontmatter, payload.body);
          writeFileSync(cmdPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: cmdPath,
            fileName: currentFileName
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },
            500
          );
        }
      }

      // DELETE /api/command-item/:name - Delete command
      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          rmSync(cmdPath);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },
            500
          );
        }
      }

      // POST /api/command-item/create - Create new command
      if (pathname === '/api/command-item/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for filename (supports Unicode characters like Chinese)
          const fileName = sanitizeFolderName(payload.name);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;

          // Ensure directory exists
          if (!existsSync(baseDir)) {
            mkdirSync(baseDir, { recursive: true });
          }

          const cmdPath = join(baseDir, `${fileName}.md`);

          if (existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command already exists' }, 409);
          }

          // Create command file with default content
          const frontmatter: Partial<CommandFrontmatter> = {
            name: payload.name,
            description: payload.description || '',
          };
          const body = `在这里编写指令的详细内容...`;
          const content = serializeCommandContent(frontmatter, body);

          writeFileSync(cmdPath, content, 'utf-8');

          return jsonResponse({ success: true, path: cmdPath, name: fileName });
        } catch (error) {
          console.error('[api/command-item/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },
            500
          );
        }
      }

      // ============= SUB-AGENTS API =============

      const userAgentsBaseDir = join(homeDir, '.myagents', 'agents');

      // Helper: Get project agents directory (supports explicit agentDir parameter)
      const getProjectAgentsDir = (queryAgentDir: string | null) => {
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          queryAgentDir = null;
        }
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';
      };

      // GET /api/agents - List all agents (with scope filter)
      if (pathname === '/api/agents' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const projAgentsDir = getProjectAgentsDir(queryAgentDir);

          let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];

          if ((scope === 'all' || scope === 'project') && projAgentsDir) {
            agents = agents.concat(scanAgents(projAgentsDir, 'project'));
          }
          if (scope === 'all' || scope === 'user') {
            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));
          }

          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },
            500
          );
        }
      }

      // GET /api/agent/sync-check - Check if there are agents to sync from Claude Code
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {
        try {
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const claudeFolders = readdirSync(claudeAgentsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const myagentsFolders = new Set<string>();
          if (existsSync(userAgentsBaseDir)) {
            const entries = readdirSync(userAgentsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) myagentsFolders.add(entry.name);
            }
          }

          const newFolders = claudeFolders.filter(f => !myagentsFolders.has(f) && isValidFolderName(f));
          const conflictFolders = claudeFolders.filter(f => myagentsFolders.has(f) && isValidFolderName(f));
          const allValidFolders = claudeFolders.filter(f => isValidFolderName(f));
          return jsonResponse({
            canSync: allValidFolders.length > 0,
            count: allValidFolders.length,
            folders: allValidFolders,
            newFolders,
            conflictFolders,
          });
        } catch (error) {
          console.error('[api/agent/sync-check] Error:', error);
          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);
        }
      }

      // POST /api/agent/sync-from-claude - Sync agents from Claude Code to MyAgents
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'
      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };
          const conflictMode = payload.mode || 'skip';
          const selectedFolders = payload.folders; // Optional: sync only these specific folders

          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);
          }

          const claudeFolders = readdirSync(claudeAgentsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.') && isValidFolderName(entry.name))
            .map(entry => entry.name);

          // Filter to selected folders if specified
          const foldersToSync = selectedFolders
            ? claudeFolders.filter(f => selectedFolders.includes(f))
            : claudeFolders;

          if (foldersToSync.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });
          }

          if (!existsSync(userAgentsBaseDir)) {
            mkdirSync(userAgentsBaseDir, { recursive: true });
          }

          let synced = 0;
          let failed = 0;
          let skipped = 0;
          let overwritten = 0;
          const errors: string[] = [];
          const conflicts: string[] = [];

          for (const folder of foldersToSync) {
            const srcDir = join(claudeAgentsDir, folder);
            const destDir = join(userAgentsBaseDir, folder);
            const alreadyExists = existsSync(destDir);

            if (alreadyExists) {
              if (conflictMode === 'skip') {
                skipped++;
                conflicts.push(folder);
                continue;
              }
              // overwrite: remove existing first
              rmSync(destDir, { recursive: true, force: true });
              overwritten++;
            }

            try {
              copyDirRecursiveSync(srcDir, destDir, '[api/agent/sync-from-claude]');
              synced++;

              // Auto-generate _meta.json from frontmatter
              const mdPath = join(destDir, `${folder}.md`);
              const metaPath = join(destDir, '_meta.json');
              if (existsSync(mdPath) && !existsSync(metaPath)) {
                try {
                  const content = readFileSync(mdPath, 'utf-8');
                  const { name: agentName } = parseAgentFrontmatter(content);
                  const meta = {
                    displayName: agentName || folder,
                    author: 'claude-code-sync',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  };
                  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                } catch { /* _meta.json generation is optional */ }
              }
            } catch (copyError) {
              failed++;
              errors.push(`${folder}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);
              console.error(`[api/agent/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          return jsonResponse({
            success: true,
            synced,
            failed,
            skipped,
            overwritten,
            conflicts,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (error) {
          console.error('[api/agent/sync-from-claude] Error:', error);
          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);
        }
      }

      // POST /api/agent/create - Create new agent
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          const folderName = sanitizeFolderName(payload.name);
          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          const agentFolderDir = join(baseDir, folderName);
          if (existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent already exists' }, 409);
          }

          mkdirSync(agentFolderDir, { recursive: true });

          const frontmatter: Partial<AgentFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;
          const content = serializeAgentContent(frontmatter, body);

          const agentPath = join(agentFolderDir, `${folderName}.md`);
          writeFileSync(agentPath, content, 'utf-8');

          // Create default _meta.json
          writeAgentMeta(agentFolderDir, {
            displayName: payload.name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          return jsonResponse({ success: true, path: agentPath, folderName });
        } catch (error) {
          console.error('[api/agent/create] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);
        }
      }

      // GET /api/agents/workspace-config - Read workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });
          }
          const config = readWorkspaceConfig(effectiveDir);
          return jsonResponse({ success: true, config });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);
        }
      }

      // PUT /api/agents/workspace-config - Update workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {
        try {
          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };
          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
          writeWorkspaceConfig(effectiveDir, payload.config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);
        }
      }

      // GET /api/agents/enabled - Get enabled agents as SDK definitions
      if (pathname === '/api/agents/enabled' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';
          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents/enabled] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);
        }
      }

      // POST /api/agents/set - Set agents and trigger session resume
      if (pathname === '/api/agents/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { agents: Record<string, unknown> };
          // The payload.agents is already in SDK AgentDefinition format
          setAgents(payload.agents as Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
        }
      }

      // POST /api/model/set - Set default model for this session
      if (pathname === '/api/model/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { model?: string };
          if (!payload?.model) {
            return jsonResponse({ success: false, error: 'model is required' }, 400);
          }
          setSessionModel(payload.model);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/model/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }

      // GET /api/agent/:name - Get agent detail
      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
          const agentPath = join(baseDir, agentName, `${agentName}.md`);

          if (!existsSync(agentPath)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          const content = readFileSync(agentPath, 'utf-8');
          const { frontmatter, body } = parseFullAgentContent(content);
          const meta = readAgentMeta(join(baseDir, agentName));

          return jsonResponse({
            success: true,
            agent: {
              name: frontmatter.name || agentName,
              folderName: agentName,
              path: agentPath,
              scope,
              frontmatter,
              body,
              ...(meta ? { meta } : {}),
            }
          });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);
        }
      }

      // PUT /api/agent/:name - Update agent (with optional folder rename)
      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<AgentFrontmatter>;
            body: string;
            newFolderName?: string;
            agentDir?: string;
            meta?: AgentMeta;
          };

          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;
          let currentFolderName = agentName;
          let agentFolderDir = join(baseDir, currentFolderName);
          let agentPath = join(agentFolderDir, `${currentFolderName}.md`);

          if (!existsSync(agentPath)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
            const newAgentDir = join(baseDir, newFolderName);
            if (existsSync(newAgentDir)) {
              return jsonResponse({ success: false, error: `Agent 文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            const content = serializeAgentContent(payload.frontmatter, payload.body);
            renameSync(agentFolderDir, newAgentDir);
            agentFolderDir = newAgentDir;
            currentFolderName = newFolderName;

            // Rename the .md file inside to match new folder name
            const oldMdPath = join(agentFolderDir, `${agentName}.md`);
            agentPath = join(agentFolderDir, `${newFolderName}.md`);
            if (existsSync(oldMdPath)) {
              renameSync(oldMdPath, agentPath);
            }

            writeFileSync(agentPath, content, 'utf-8');
            if (payload.meta) writeAgentMeta(agentFolderDir, { ...payload.meta, updatedAt: new Date().toISOString() });
            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
          }

          // No rename, just update content
          const content = serializeAgentContent(payload.frontmatter, payload.body);
          writeFileSync(agentPath, content, 'utf-8');
          if (payload.meta) writeAgentMeta(agentFolderDir, { ...payload.meta, updatedAt: new Date().toISOString() });
          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);
        }
      }

      // DELETE /api/agent/:name - Delete agent
      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
          const agentFolderDir = join(baseDir, agentName);

          if (!existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          rmSync(agentFolderDir, { recursive: true, force: true });
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);
        }
      }

      // ============= END SLASH COMMANDS API =============

      // ============= IM BOT API =============
      // These endpoints are called by the Rust IM layer (SessionRouter)

      // POST /api/im/chat — Process an IM message through the AI agent
      if (pathname === '/api/im/chat' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as {
            message: string;
            source: 'telegram_private' | 'telegram_group';
            sourceId: string;
            senderName?: string;
            permissionMode?: string;
          };

          if (!payload.message?.trim()) {
            return jsonResponse({ success: false, error: 'Message is required' }, 400);
          }

          const metadata = {
            source: payload.source,
            sourceId: payload.sourceId,
            senderName: payload.senderName,
          };

          // Use enqueueUserMessage — shares the same persistent generator as Desktop
          const result = await enqueueUserMessage(
            payload.message,
            undefined, // no images from IM
            (payload.permissionMode as PermissionMode) ?? 'plan',
            undefined, // use current model
            undefined, // use current provider
            metadata,
          );

          if (result.error) {
            return jsonResponse({ success: false, error: result.error }, 503);
          }

          // Mark session source (only on first IM message for this session)
          const currentSessionId = getSessionId();
          if (currentSessionId) {
            const sessionMeta = getSessionMetadata(currentSessionId);
            if (sessionMeta && !sessionMeta.source) {
              updateSessionMetadata(currentSessionId, { source: payload.source });
            }
          }

          // Notify Desktop: a new IM user message was enqueued
          broadcast('im:message_received', {
            sessionId: currentSessionId,
            source: payload.source,
            senderName: payload.senderName ?? payload.sourceId,
            content: payload.message,
          });

          // === SSE Stream: stream text deltas to Rust IM for Telegram draft editing ===
          const encoder = new TextEncoder();
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
          let safetyTimer: ReturnType<typeof setTimeout> | null = null;
          let closed = false;
          let imAccText = ''; // Current block's accumulated text

          const stream = new ReadableStream({
            start(controller) {
              // Immediately flush headers by sending an SSE comment
              // (Bun buffers the response until the first body chunk is written)
              controller.enqueue(encoder.encode(': connected\n\n'));

              // 15s heartbeat (keep-alive during tool calls; Rust read_timeout=60s)
              heartbeatTimer = setInterval(() => {
                try { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')); }
                catch { /* stream closed */ }
              }, 15000);

              const sendEvent = (data: object) => {
                if (closed) return;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              const closeStream = () => {
                if (closed) return;
                closed = true;
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                if (safetyTimer) clearTimeout(safetyTimer);
                setImStreamCallback(null);
                try { controller.close(); } catch { /* already closed */ }
              };

              // 600s safety timeout
              safetyTimer = setTimeout(() => {
                if (!closed) {
                  // Flush any remaining text as final block
                  if (imAccText) {
                    sendEvent({ type: 'block-end', text: imAccText });
                    imAccText = '';
                  }
                  sendEvent({ type: 'complete', sessionId: getSessionId() });
                  closeStream();
                }
              }, 600000);

              setImStreamCallback((event, data) => {
                if (event === 'delta') {
                  imAccText += data;
                  sendEvent({ type: 'partial', text: imAccText });
                } else if (event === 'block-end') {
                  sendEvent({ type: 'block-end', text: imAccText });
                  imAccText = ''; // Reset for next block
                } else if (event === 'complete') {
                  // Flush any un-ended text
                  if (imAccText) {
                    sendEvent({ type: 'block-end', text: imAccText });
                    imAccText = '';
                  }
                  sendEvent({ type: 'complete', sessionId: getSessionId() });
                  // Notify Desktop: IM turn completed
                  broadcast('im:response_sent', {
                    sessionId: getSessionId(),
                  });
                  closeStream();
                } else if (event === 'error') {
                  sendEvent({ type: 'error', error: data });
                  closeStream();
                }
              });
            },
            cancel() {
              closed = true;
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              if (safetyTimer) clearTimeout(safetyTimer);
              setImStreamCallback(null);
            }
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          });
        } catch (error) {
          console.error('[im/chat] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM chat error' },
            500,
          );
        }
      }

      // POST /api/im/session/new — Start a new session (preserving workspace)
      if (pathname === '/api/im/session/new' && request.method === 'POST') {
        try {
          await resetSession();
          return jsonResponse({
            sessionId: getSessionId(),
          });
        } catch (error) {
          console.error('[im/session/new] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Reset error' },
            500,
          );
        }
      }

      // POST /api/im/session/switch-workspace — Switch workspace and start new session
      if (pathname === '/api/im/session/switch-workspace' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { workspacePath: string };
          if (!payload.workspacePath) {
            return jsonResponse({ success: false, error: 'workspacePath is required' }, 400);
          }
          // Reset session (workspace change will be handled by Rust layer restarting the Sidecar)
          await resetSession();
          return jsonResponse({
            sessionId: getSessionId(),
            workspacePath: payload.workspacePath,
          });
        } catch (error) {
          console.error('[im/session/switch-workspace] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Switch error' },
            500,
          );
        }
      }

      // GET /api/im/session/:key/messages — Get messages for an IM session
      if (pathname.startsWith('/api/im/session/') && pathname.endsWith('/messages') && request.method === 'GET') {
        try {
          // Currently returns messages from the active session
          // In the future, could look up by session key
          const allMessages = getMessages();
          return jsonResponse({
            messages: allMessages.map(m => ({
              id: m.id,
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content
                .filter((b: { type: string; text?: string }) => b.type === 'text')
                .map((b: { text?: string }) => b.text ?? '')
                .join('\n'),
              timestamp: m.timestamp,
              metadata: m.metadata,
            })),
          });
        } catch (error) {
          console.error('[im/session/messages] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Messages error' },
            500,
          );
        }
      }

      // ============= END IM BOT API =============

      const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.log(`Web UI server listening on http://localhost:${port}`);
  console.log(`[server] Version: MCP-Install-Fix-v2`);

  // Verify PATH detection
  import('./utils/shell').then(({ getShellEnv }) => {
    const env = getShellEnv();
    console.log('[server] Startup PATH:', env.PATH);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
