/**
 * Provider verification utilities
 * Verifies API key validity by sending a test request
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv } from './agent-session';
// Subscription types (keep in sync with src/renderer/types/subscription.ts)
export interface SubscriptionInfo {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
}

export interface SubscriptionStatus {
  available: boolean;
  path?: string;
  info?: SubscriptionInfo;
}

// Error message parser for subscription verification
function parseSubscriptionError(errorText: string): string {
  if (errorText.includes('authentication') || errorText.includes('login') || errorText.includes('/login')) {
    return '登录已过期，请重新登录 (claude --login)';
  } else if (errorText.includes('forbidden') || errorText.includes('403')) {
    return '登录已过期，请重新登录 (claude --login)';
  } else if (errorText.includes('rate limit') || errorText.includes('429')) {
    return '请求频率限制，请稍后再试';
  } else if (errorText.includes('network') || errorText.includes('connect')) {
    return '网络连接失败';
  }
  return errorText.slice(0, 100) || '验证失败';
}

// Error message parser for provider API key verification
function parseProviderError(errorText: string): string {
  if (errorText.includes('authentication') || errorText.includes('unauthorized') || errorText.includes('401')) {
    return 'API Key 无效或已过期';
  } else if (errorText.includes('forbidden') || errorText.includes('403')) {
    return '访问被拒绝，请检查 API Key 权限';
  } else if (errorText.includes('rate limit') || errorText.includes('429')) {
    return '请求频率限制，请稍后再试';
  } else if (errorText.includes('network') || errorText.includes('connect') || errorText.includes('ECONNREFUSED')) {
    return '网络连接失败，请检查 Base URL';
  } else if (errorText.includes('not found') || errorText.includes('404')) {
    return '模型不存在或 API 地址错误';
  }
  return errorText.slice(0, 100) || '验证失败';
}

/**
 * Shared SDK verification core.
 * Spawns an SDK subprocess with a trivial test prompt and returns success/failure.
 */
async function verifyViaSdk(
  env: NodeJS.ProcessEnv,
  opts: {
    model?: string;
    sessionId: string;
    logPrefix: string;
    parseError: (text: string) => string;
    settingSources: ('user' | 'project')[];
  },
): Promise<{ success: boolean; error?: string }> {
  const TIMEOUT_MS = 30000;
  const stderrMessages: string[] = [];
  const { logPrefix, parseError } = opts;

  try {
    const cliPath = resolveClaudeCodeCli();
    const cwd = homedir();

    async function* simplePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'It\'s a test, directly reply "1"' },
        parent_tool_use_id: null,
        session_id: opts.sessionId,
      };
    }

    const testQuery = query({
      prompt: simplePrompt(),
      options: {
        maxTurns: 1,
        cwd,
        settingSources: opts.settingSources,
        pathToClaudeCodeExecutable: cliPath,
        executable: 'bun',
        env,
        stderr: (message: string) => {
          console.error(`[${logPrefix}] stderr:`, message);
          stderrMessages.push(message);
        },
        ...(opts.model ? { model: opts.model } : {}),
      },
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
      timeoutId = setTimeout(() => {
        const stderrHint = stderrMessages.length > 0
          ? ` (stderr: ${stderrMessages.join('; ').slice(0, 200)})`
          : '';
        resolve({ success: false, error: `验证超时，请检查网络连接${stderrHint}` });
      }, TIMEOUT_MS);
    });

    const verifyPromise = (async (): Promise<{ success: boolean; error?: string }> => {
      for await (const message of testQuery) {
        console.log(`[${logPrefix}] SDK message type: ${message.type}`);

        if (message.type === 'system') {
          continue;
        }

        if (message.type === 'result') {
          // SDK types: SDKResultSuccess { subtype: 'success', result: string }
          //            SDKResultError   { subtype: 'error_...', errors: string[] }
          // Note: is_error can be true even on subtype 'success' (e.g. tool errors
          // that were handled), so use subtype to determine verification outcome.
          const resultMsg = message as {
            subtype?: string;
            errors?: string[];
          };

          if (resultMsg.subtype === 'success') {
            // API responded = credentials are valid
            console.log(`[${logPrefix}] SDK verification successful`);
            return { success: true };
          }

          // Error result (error_during_execution, error_max_turns, etc.)
          const errorsArray = resultMsg.errors;
          const errorText = (errorsArray && errorsArray.length > 0)
            ? errorsArray.join('; ')
            : resultMsg.subtype || '验证失败';
          console.log(`[${logPrefix}] SDK error result: ${errorText} (subtype: ${resultMsg.subtype})`);
          const stderrHint = stderrMessages.length > 0
            ? ` (详情: ${stderrMessages.join('; ').slice(0, 100)})`
            : '';
          return { success: false, error: parseError(errorText) + stderrHint };
        }
      }

      const stderrHint = stderrMessages.length > 0
        ? `: ${stderrMessages.join('; ').slice(0, 200)}`
        : '';
      return { success: false, error: `验证未返回结果${stderrHint}` };
    })();

    try {
      return await Promise.race([verifyPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (error) {
    // SDK can throw exceptions (e.g. subprocess crash, pipe errors).
    // Include all available context for diagnosis.
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${logPrefix}] SDK exception: ${errorMsg}`);
    if (error instanceof Error && error.stack) {
      console.error(`[${logPrefix}] Stack:`, error.stack);
    }
    const stderrHint = stderrMessages.length > 0
      ? ` (详情: ${stderrMessages.join('; ').slice(0, 200)})`
      : '';
    return { success: false, error: parseError(errorMsg) + stderrHint };
  }
}

/**
 * Verify a provider API key via SDK.
 * Uses the same SDK path as normal chat requests, ensuring verification = real usage.
 */
export async function verifyProviderViaSdk(
  baseUrl: string,
  apiKey: string,
  authType: string,
  model?: string
): Promise<{ success: boolean; error?: string }> {
  console.log(`[provider/verify] Starting SDK verification for ${baseUrl}, model=${model ?? 'default'}, authType=${authType}`);
  const env = buildClaudeSessionEnv({
    baseUrl,
    apiKey,
    authType: authType as 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key',
  });
  return verifyViaSdk(env, {
    model,
    sessionId: 'verify-provider-session',
    logPrefix: 'provider/verify',
    parseError: parseProviderError,
    // MUST NOT use 'user' — it reads ~/.claude/settings.json which may contain
    // enabledPlugins (e.g. rust-analyzer-lsp) that the SDK subprocess will try
    // to start, causing 30s+ initialization and triggering our timeout.
    // Chat sessions use ['project'] for the same reason (see buildSettingSources).
    settingSources: [],
  });
}

/**
 * Check if Anthropic subscription credentials exist locally
 * Claude CLI stores OAuth account info in ~/.claude.json file
 */
export function checkAnthropicSubscription(): SubscriptionStatus {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    return { available: false };
  }

  // Check if ~/.claude.json has oauthAccount field (indicates logged in)
  try {
    const content = readFileSync(claudeJsonPath, 'utf-8');
    const config = JSON.parse(content);

    if (config.oauthAccount && config.oauthAccount.accountUuid) {
      return {
        available: true,
        path: claudeJsonPath,
        info: {
          accountUuid: config.oauthAccount.accountUuid,
          email: config.oauthAccount.emailAddress,
          displayName: config.oauthAccount.displayName,
          organizationName: config.oauthAccount.organizationName,
        }
      };
    }
  } catch {
    // File exists but can't read/parse
  }

  return { available: false };
}

/**
 * Verify Anthropic subscription by sending a test request via SDK.
 * Uses the same SDK path as normal chat requests.
 */
export async function verifySubscription(): Promise<{ success: boolean; error?: string }> {
  console.log('[subscription/verify] Starting SDK verification...');
  const env = buildClaudeSessionEnv(); // No provider override = default Anthropic auth
  return verifyViaSdk(env, {
    sessionId: 'verify-subscription-session',
    logPrefix: 'subscription/verify',
    parseError: parseSubscriptionError,
    // Subscription needs 'user' to read ~/.claude/ OAuth credentials
    settingSources: ['user'],
  });
}

/**
 * Get the current git branch for a directory
 * Returns undefined if not a git repository
 */
export function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
    });
    return branch.trim() || undefined;
  } catch {
    // Not a git repository or git not available
    return undefined;
  }
}
