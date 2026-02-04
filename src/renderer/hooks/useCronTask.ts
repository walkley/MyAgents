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
  updateCronTaskSession,
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
  /** Ref to register the cron task exit handler (provided by TabContext) */
  onCronTaskExitRequestedRef?: React.MutableRefObject<((taskId: string, reason: string) => void) | null>;
}

export function useCronTask(options: UseCronTaskOptions) {
  const { workspacePath, sessionId, tabId, onExecute, onComplete, onCronTaskExitRequestedRef } = options;

  const [state, setState] = useState<CronTaskState>(initialState);
  const isExecutingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  // Refs for Tauri event handlers to avoid recreating listeners on handler changes
  // These refs are updated when handlers change, but the listeners always call through refs
  const handleSchedulerStartedRef = useRef<((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => void) | null>(null);
  const handleExecutionStartingRef = useRef<((payload: { taskId: string; executionNumber: number; isFirstExecution: boolean }) => void) | null>(null);
  const handleDebugEventRef = useRef<((payload: { taskId: string; message: string; error?: boolean }) => void) | null>(null);
  const handleSchedulerTriggerRef = useRef<((payload: CronTaskTriggerPayload) => Promise<void>) | null>(null);
  const handleExecutionCompleteRef = useRef<((payload: { taskId: string; success: boolean; executionCount: number }) => Promise<void>) | null>(null);
  const handleExecutionErrorRef = useRef<((payload: { taskId: string; error: string }) => void) | null>(null);

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
  // Optional prompt parameter allows caller to pass the prompt directly,
  // avoiding React state update timing issues (stale closure problem)
  const startTask = useCallback(async (promptOverride?: string) => {
    // Use ref to get latest state to avoid stale closure
    const currentConfig = stateRef.current.config;
    if (!currentConfig) return;

    // Use promptOverride if provided, otherwise fall back to config.prompt
    // This fixes the timing issue where updateConfig() hasn't updated the ref yet
    const effectivePrompt = promptOverride ?? currentConfig.prompt;

    if (!effectivePrompt) {
      console.error('[useCronTask] Cannot start task: prompt is empty');
      setState(prev => ({
        ...prev,
        error: 'Prompt is required to start the task',
      }));
      return;
    }

    setState(prev => ({ ...prev, isStarting: true, error: null }));

    try {
      // Create the task
      const task = await createCronTask({
        workspacePath,
        sessionId,
        tabId,
        prompt: effectivePrompt,
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

  // Handle scheduler started event (for debugging visibility)
  const handleSchedulerStarted = useCallback((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Scheduler started:', payload);
  }, []);

  // Handle execution starting event (for debugging visibility)
  const handleExecutionStarting = useCallback((payload: { taskId: string; executionNumber: number; isFirstExecution: boolean }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Execution starting:', payload);
  }, []);

  // Handle debug events from Rust (for debugging visibility)
  const handleDebugEvent = useCallback((payload: { taskId: string; message: string; error?: boolean }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    if (payload.error) {
      console.error('[useCronTask] Debug:', payload.message);
    } else {
      console.log('[useCronTask] Debug:', payload.message);
    }
  }, []);

  // Update refs with latest handler functions
  // This ensures listeners always call the latest handlers without needing to re-subscribe
  handleSchedulerStartedRef.current = handleSchedulerStarted;
  handleExecutionStartingRef.current = handleExecutionStarting;
  handleDebugEventRef.current = handleDebugEvent;
  handleSchedulerTriggerRef.current = handleSchedulerTrigger;
  handleExecutionCompleteRef.current = handleExecutionComplete;
  handleExecutionErrorRef.current = handleExecutionError;

  // Listen for Tauri events (cron:trigger-execution, cron:execution-complete, cron:execution-error, cron:scheduler-started, cron:execution-starting, cron:debug)
  // Note: We use refs for handlers so this effect only runs once (on mount) and doesn't need
  // to re-subscribe when tabId or other dependencies change
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenTrigger: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let unlistenSchedulerStarted: (() => void) | null = null;
    let unlistenExecutionStarting: (() => void) | null = null;
    let unlistenDebug: (() => void) | null = null;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');

      // Scheduler started event (for debugging)
      unlistenSchedulerStarted = await listen<{ taskId: string; intervalMinutes: number; executionCount: number }>(
        'cron:scheduler-started',
        (event) => {
          handleSchedulerStartedRef.current?.(event.payload);
        }
      );

      // Execution starting event (for debugging)
      unlistenExecutionStarting = await listen<{ taskId: string; executionNumber: number; isFirstExecution: boolean }>(
        'cron:execution-starting',
        (event) => {
          handleExecutionStartingRef.current?.(event.payload);
        }
      );

      // Debug events from Rust
      unlistenDebug = await listen<{ taskId: string; message: string; error?: boolean }>(
        'cron:debug',
        (event) => {
          handleDebugEventRef.current?.(event.payload);
        }
      );

      // Legacy: trigger from Rust to frontend to execute
      unlistenTrigger = await listen<CronTaskTriggerPayload>('cron:trigger-execution', (event) => {
        handleSchedulerTriggerRef.current?.(event.payload);
      });

      // New: Rust executed directly, notify frontend to update UI
      unlistenComplete = await listen<{ taskId: string; success: boolean; executionCount: number }>(
        'cron:execution-complete',
        (event) => {
          handleExecutionCompleteRef.current?.(event.payload);
        }
      );

      unlistenError = await listen<{ taskId: string; error: string }>(
        'cron:execution-error',
        (event) => {
          handleExecutionErrorRef.current?.(event.payload);
        }
      );
    };

    setupListeners();

    return () => {
      if (unlistenSchedulerStarted) unlistenSchedulerStarted();
      if (unlistenExecutionStarting) unlistenExecutionStarting();
      if (unlistenDebug) unlistenDebug();
      if (unlistenTrigger) unlistenTrigger();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Handlers are accessed via refs to avoid listener churn
  }, []);

  // Register handler for SSE events (cron:task-exit-requested from AI tool)
  // The handler is registered via the ref provided by TabContext
  useEffect(() => {
    if (!onCronTaskExitRequestedRef) return;

    // Register our handler
    onCronTaskExitRequestedRef.current = handleTaskExitRequested;

    return () => {
      // Unregister on cleanup
      if (onCronTaskExitRequestedRef.current === handleTaskExitRequested) {
        onCronTaskExitRequestedRef.current = null;
      }
    };
  }, [onCronTaskExitRequestedRef, handleTaskExitRequested]);

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

  // Update task's sessionId (called when session is created after task creation)
  const updateSessionId = useCallback(async (newSessionId: string) => {
    const currentTask = stateRef.current.task;
    if (!currentTask) return;

    try {
      const updatedTask = await updateCronTaskSession(currentTask.id, newSessionId);
      setState(prev => ({ ...prev, task: updatedTask }));
      console.log('[useCronTask] Updated sessionId:', updatedTask.id, updatedTask.sessionId);
    } catch (error) {
      console.error('[useCronTask] Failed to update sessionId:', error);
    }
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
    updateSessionId,
  };
}
