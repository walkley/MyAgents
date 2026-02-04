// Types for scheduled (cron) tasks

/**
 * Run mode for cron tasks
 */
export type CronRunMode = 'single_session' | 'new_session';

/**
 * Task status (simplified: only Running and Stopped)
 * Stopped includes: manual stop, end conditions met, AI exit
 */
export type CronTaskStatus = 'running' | 'stopped';

/**
 * End conditions for a cron task
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronEndConditions {
  /** Task will stop after this time (ISO timestamp) */
  deadline?: string;
  /** Task will stop after this many executions */
  maxExecutions?: number;
  /** Allow AI to exit the task via ExitCronTask tool */
  aiCanExit: boolean;
}

/**
 * A scheduled cron task (returned from Rust)
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronTask {
  id: string;
  workspacePath: string;
  sessionId: string;
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  status: CronTaskStatus;
  executionCount: number;
  createdAt: string;
  lastExecutedAt?: string;
  notifyEnabled: boolean;
  tabId?: string;
  exitReason?: string;
  permissionMode?: string;
  model?: string;
  providerEnv?: { baseUrl?: string; apiKey?: string };
  lastError?: string;
}

/**
 * Provider environment for third-party API access
 */
export interface CronTaskProviderEnv {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Configuration for creating a new cron task
 * Note: Uses camelCase to match Rust's serde(rename_all = "camelCase")
 */
export interface CronTaskConfig {
  workspacePath: string;
  sessionId: string;
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  notifyEnabled: boolean;
  tabId?: string;
  permissionMode?: string;
  model?: string;
  providerEnv?: CronTaskProviderEnv;
}

/**
 * Payload sent from Rust scheduler to trigger task execution
 */
export interface CronTaskTriggerPayload {
  taskId: string;
  prompt: string;
  isFirstExecution: boolean;
  aiCanExit: boolean;
  workspacePath: string;
  sessionId: string;
  runMode: CronRunMode;
  notifyEnabled: boolean;
  tabId?: string;
}

/**
 * Preset interval options (in minutes)
 */
export const CRON_INTERVAL_PRESETS = [
  { label: '15 分钟', value: 15 },
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '8 小时', value: 480 },
  { label: '24 小时', value: 1440 },
] as const;

/**
 * Minimum interval in minutes
 */
export const MIN_CRON_INTERVAL = 5;

/**
 * Format interval for display
 */
export function formatCronInterval(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} 分钟`;
  } else if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  } else {
    const days = Math.floor(minutes / 1440);
    const remainingMins = minutes % 1440;
    const hours = Math.floor(remainingMins / 60);
    if (hours > 0) {
      return `${days} 天 ${hours} 小时`;
    }
    return `${days} 天`;
  }
}

/**
 * Get human-readable status text
 */
export function getCronStatusText(status: CronTaskStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    default:
      return status;
  }
}

/**
 * Get status color class
 */
export function getCronStatusColor(status: CronTaskStatus): string {
  switch (status) {
    case 'running':
      return 'text-green-600';
    case 'stopped':
      return 'text-gray-600';
    default:
      return 'text-[var(--ink-muted)]';
  }
}
