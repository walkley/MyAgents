// Hook for managing cron task state within a Tab
import { useState, useCallback, useRef, useEffect } from 'react';
import type { CronTask, CronTaskConfig, CronEndConditions, CronRunMode, CronTaskTriggerPayload } from '@/types/cronTask';
import {
  createCronTask,
  startCronTask,
  stopCronTask,
  getCronTask,
  recordCronExecution,
  startCronScheduler,
  markTaskExecuting,
  markTaskComplete,
} from '@/api/cronTaskClient';
import { isTauriEnvironment } from '@/utils/browserMock';

export interface CronTaskState {
  /** Whether cron mode is enabled (before task is created) */
  isEnabled: boolean;
  /** Cron task configuration (set before task creation) */
  config: {
    prompt: string;
    intervalMinutes: number;
    endConditions: CronEndConditions;
    runMode: CronRunMode;
    notifyEnabled: boolean;
  } | null;
  /** Active cron task (after creation) */
  task: CronTask | null;
  /** Whether task is currently being created/started */
  isStarting: boolean;
  /** Error message if any */
  error: string | null;
}

const initialState: CronTaskState = {
  isEnabled: false,
  config: null,
  task: null,
  isStarting: false,
  error: null,
};

export interface UseCronTaskOptions {
  workspacePath: string;
  sessionId: string;
  tabId: string;
  /** Callback to execute cron task (send message via sidecar /cron/execute endpoint) */
  onExecute?: (taskId: string, prompt: string, isFirstExecution: boolean, aiCanExit: boolean) => Promise<void>;
  /** Callback when task completes */
  onComplete?: (task: CronTask, reason?: string) => void;
  /** SSE event source for listening to cron events */
  sseEventSource?: EventSource | null;
}

export function useCronTask(options: UseCronTaskOptions) {
  const { workspacePath, sessionId, tabId, onExecute, onComplete, sseEventSource } = options;

  const [state, setState] = useState<CronTaskState>(initialState);
  const isExecutingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  // Enable cron mode with initial config
  const enableCronMode = useCallback((config: Omit<CronTaskConfig, 'workspacePath' | 'sessionId' | 'tabId'>) => {
    setState({
      isEnabled: true,
      config: {
        prompt: config.prompt,
        intervalMinutes: config.intervalMinutes,
        endConditions: config.endConditions,
        runMode: config.runMode,
        notifyEnabled: config.notifyEnabled,
      },
      task: null,
      isStarting: false,
      error: null,
    });
  }, []);

  // Disable cron mode (cancel before starting)
  const disableCronMode = useCallback(() => {
    setState(initialState);
  }, []);

  // Update config while in cron mode
  const updateConfig = useCallback((config: Partial<CronTaskState['config']>) => {
    setState(prev => ({
      ...prev,
      config: prev.config ? { ...prev.config, ...config } : null,
    }));
  }, []);

  // Create and start the cron task
  const startTask = useCallback(async () => {
    // Use ref to get latest state to avoid stale closure
    const currentConfig = stateRef.current.config;
    if (!currentConfig) return;

    setState(prev => ({ ...prev, isStarting: true, error: null }));

    try {
      // Create the task
      const task = await createCronTask({
        workspacePath,
        sessionId,
        tabId,
        prompt: currentConfig.prompt,
        intervalMinutes: currentConfig.intervalMinutes,
        endConditions: currentConfig.endConditions,
        runMode: currentConfig.runMode,
        notifyEnabled: currentConfig.notifyEnabled,
      });

      // Start the task (updates status to 'running')
      const startedTask = await startCronTask(task.id);

      setState(prev => ({
        ...prev,
        task: startedTask,
        isStarting: false,
      }));

      // Start the Rust-layer scheduler
      // The scheduler will execute immediately for first time (execution_count == 0)
      // This ensures consistent execution path for both first and subsequent executions
      await startCronScheduler(task.id);

      console.log('[useCronTask] Task started with scheduler:', startedTask.id);
    } catch (error) {
      console.error('[useCronTask] Failed to start task:', error);
      setState(prev => ({
        ...prev,
        isStarting: false,
        error: error instanceof Error ? error.message : 'Failed to start task',
      }));
    }
  }, [workspacePath, sessionId, tabId]);

  // Stop the task
  // Returns the original prompt so it can be restored to the input field
  const stop = useCallback(async (): Promise<string | null> => {
    const currentTask = stateRef.current.task;
    const currentConfig = stateRef.current.config;
    if (!currentTask) return null;

    // Get the original prompt before resetting state
    const originalPrompt = currentTask.prompt || currentConfig?.prompt || null;

    try {
      const stoppedTask = await stopCronTask(currentTask.id);
      // Rust scheduler will detect status change and stop
      // Reset to initial state
      setState(initialState);
      console.log('[useCronTask] Task stopped:', stoppedTask.id);
      return originalPrompt;
    } catch (error) {
      console.error('[useCronTask] Failed to stop task:', error);
      return null;
    }
  }, []);

  // Refresh task state from server
  const refresh = useCallback(async () => {
    const currentTask = stateRef.current.task;
    if (!currentTask) return;

    try {
      const task = await getCronTask(currentTask.id);
      setState(prev => ({ ...prev, task }));

      // Check if task is stopped (end conditions met or AI exit)
      if (task.status === 'stopped' && task.exitReason) {
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        // Reset state
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task:', error);
    }
  }, []);

  // Handle AI-initiated task exit (via exit_cron_task tool)
  const handleTaskExitRequested = useCallback(async (taskId: string, reason: string) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== taskId) return;

    console.log('[useCronTask] AI requested task exit:', taskId, reason);
    try {
      const stoppedTask = await stopCronTask(taskId, reason);
      setState(prev => ({ ...prev, task: stoppedTask }));

      if (optionsRef.current.onComplete) {
        optionsRef.current.onComplete(stoppedTask, reason);
      }

      // Reset state
      setState(initialState);
    } catch (error) {
      console.error('[useCronTask] Failed to stop task:', error);
    }
  }, []);

  // Handle Rust scheduler trigger event
  const handleSchedulerTrigger = useCallback(async (payload: CronTaskTriggerPayload) => {
    const currentTask = stateRef.current.task;

    // Verify this trigger is for our task and tab
    if (!currentTask || currentTask.id !== payload.taskId || payload.tabId !== tabId) {
      return;
    }

    // Skip if already executing
    if (isExecutingRef.current) {
      console.log('[useCronTask] Skipping trigger - already executing');
      return;
    }

    console.log('[useCronTask] Scheduler triggered execution for task:', payload.taskId);

    isExecutingRef.current = true;
    await markTaskExecuting(payload.taskId);

    try {
      if (optionsRef.current.onExecute) {
        await optionsRef.current.onExecute(
          payload.taskId,
          payload.prompt,
          payload.isFirstExecution,
          payload.aiCanExit
        );
      }

      // Record execution
      const updatedTask = await recordCronExecution(payload.taskId);
      setState(prev => ({ ...prev, task: updatedTask }));

      // Check if task stopped (end conditions met)
      if (updatedTask.status === 'stopped') {
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(updatedTask, updatedTask.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } finally {
      await markTaskComplete(payload.taskId);
      isExecutingRef.current = false;
    }
  }, [tabId]);

  // Handle Rust scheduler execution complete event
  // This is emitted after Rust directly executes via Sidecar (not via frontend)
  const handleExecutionComplete = useCallback(async (payload: { taskId: string; success: boolean; executionCount: number }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;

    console.log('[useCronTask] Execution complete from Rust scheduler:', payload);

    // Refresh task state from server to get updated lastExecutedAt and executionCount
    try {
      const task = await getCronTask(payload.taskId);
      setState(prev => ({ ...prev, task }));

      // Check if task stopped (end conditions met or AI exit)
      if (task.status === 'stopped') {
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task after execution:', error);
    }
  }, []);

  // Handle Rust scheduler execution error event
  const handleExecutionError = useCallback((payload: { taskId: string; error: string }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;

    console.error('[useCronTask] Execution error from Rust scheduler:', payload);
    // Task will continue to next interval, just log the error
    // Optionally refresh to get updated lastError
    getCronTask(payload.taskId).then(task => {
      setState(prev => ({ ...prev, task }));
    }).catch(() => {
      // Ignore refresh errors
    });
  }, []);

  // Listen for Tauri events (cron:trigger-execution, cron:execution-complete, cron:execution-error)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenTrigger: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');

      // Legacy: trigger from Rust to frontend to execute
      unlistenTrigger = await listen<CronTaskTriggerPayload>('cron:trigger-execution', (event) => {
        handleSchedulerTrigger(event.payload);
      });

      // New: Rust executed directly, notify frontend to update UI
      unlistenComplete = await listen<{ taskId: string; success: boolean; executionCount: number }>(
        'cron:execution-complete',
        (event) => {
          handleExecutionComplete(event.payload);
        }
      );

      unlistenError = await listen<{ taskId: string; error: string }>(
        'cron:execution-error',
        (event) => {
          handleExecutionError(event.payload);
        }
      );
    };

    setupListeners();

    return () => {
      if (unlistenTrigger) unlistenTrigger();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
    };
  }, [handleSchedulerTrigger, handleExecutionComplete, handleExecutionError]);

  // Listen for SSE events (cron:task-exit-requested from AI tool)
  useEffect(() => {
    if (!sseEventSource) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.taskId && data.reason) {
          handleTaskExitRequested(data.taskId, data.reason);
        }
      } catch {
        // Ignore parse errors
      }
    };

    sseEventSource.addEventListener('cron:task-exit-requested', handleMessage);

    return () => {
      sseEventSource.removeEventListener('cron:task-exit-requested', handleMessage);
    };
  }, [sseEventSource, handleTaskExitRequested]);

  // Restore state from an existing cron task (for app restart recovery)
  const restoreFromTask = useCallback((task: CronTask) => {
    console.log('[useCronTask] Restoring from task:', task.id, task.status);
    setState({
      isEnabled: true,
      config: {
        prompt: task.prompt,
        intervalMinutes: task.intervalMinutes,
        endConditions: task.endConditions,
        runMode: task.runMode,
        notifyEnabled: task.notifyEnabled,
      },
      task,
      isStarting: false,
      error: null,
    });
  }, []);

  return {
    state,
    enableCronMode,
    disableCronMode,
    updateConfig,
    startTask,
    stop,
    refresh,
    restoreFromTask,
  };
}
