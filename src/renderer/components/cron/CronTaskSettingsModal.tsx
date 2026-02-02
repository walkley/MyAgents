// Cron Task Settings Modal - Configure scheduled task parameters
import { X, Clock, Calendar, Bot } from 'lucide-react';
import { useState, useCallback, useMemo } from 'react';
import type { CronEndConditions, CronRunMode, CronTaskConfig } from '@/types/cronTask';
import { CRON_INTERVAL_PRESETS, MIN_CRON_INTERVAL, formatCronInterval } from '@/types/cronTask';

/** Configuration that can be passed to restore previous settings */
type InitialConfig = {
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  notifyEnabled: boolean;
};

interface CronTaskSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: Omit<CronTaskConfig, 'workspacePath' | 'sessionId' | 'tabId'>) => void;
  /** Initial prompt from input field (used when no previous config exists) */
  initialPrompt?: string;
  /** Previous configuration to restore (takes precedence over initialPrompt) */
  initialConfig?: InitialConfig | null;
}

/** Helper to compute initial form values from config or defaults */
function computeInitialValues(initialPrompt: string, initialConfig: InitialConfig | null) {
  if (initialConfig) {
    const isPreset = CRON_INTERVAL_PRESETS.some(p => p.value === initialConfig.intervalMinutes);
    const endCond = initialConfig.endConditions;

    let deadlineValue = '';
    if (endCond.deadline) {
      const date = new Date(endCond.deadline);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      deadlineValue = `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    return {
      prompt: initialConfig.prompt,
      intervalMinutes: initialConfig.intervalMinutes,
      isCustomInterval: !isPreset,
      customIntervalInput: !isPreset ? String(initialConfig.intervalMinutes) : '60',
      runMode: initialConfig.runMode,
      notifyEnabled: initialConfig.notifyEnabled,
      useDeadline: !!endCond.deadline,
      deadline: deadlineValue,
      useMaxExecutions: endCond.maxExecutions !== undefined,
      maxExecutions: endCond.maxExecutions ?? 10,
      aiCanExit: endCond.aiCanExit,
    };
  }

  return {
    prompt: initialPrompt,
    intervalMinutes: 60,
    isCustomInterval: false,
    customIntervalInput: '60',
    runMode: 'single_session' as CronRunMode,
    notifyEnabled: true,
    useDeadline: false,
    deadline: '',
    useMaxExecutions: false,
    maxExecutions: 10,
    aiCanExit: true,
  };
}

/** Inner form component - remounts when modal opens to reset state */
function CronTaskSettingsForm({
  initialPrompt,
  initialConfig,
  onClose,
  onConfirm,
}: Omit<CronTaskSettingsModalProps, 'isOpen'>) {
  // Compute initial values once on mount
  const initial = computeInitialValues(initialPrompt ?? '', initialConfig ?? null);

  // Form state - initialized from computed values
  // Note: prompt is read-only (displayed as preview), so no setter needed
  const [prompt] = useState(initial.prompt);
  const [intervalMinutes, setIntervalMinutes] = useState(initial.intervalMinutes);
  const [isCustomInterval, setIsCustomInterval] = useState(initial.isCustomInterval);
  const [customIntervalInput, setCustomIntervalInput] = useState(initial.customIntervalInput);
  const [runMode, setRunMode] = useState<CronRunMode>(initial.runMode);
  const [notifyEnabled, setNotifyEnabled] = useState(initial.notifyEnabled);

  // End conditions
  const [useDeadline, setUseDeadline] = useState(initial.useDeadline);
  const [deadline, setDeadline] = useState(initial.deadline);
  const [useMaxExecutions, setUseMaxExecutions] = useState(initial.useMaxExecutions);
  const [maxExecutions, setMaxExecutions] = useState(initial.maxExecutions);
  const [aiCanExit, setAiCanExit] = useState(initial.aiCanExit);

  // Handle interval preset selection
  const handlePresetSelect = useCallback((minutes: number) => {
    setIntervalMinutes(minutes);
    setIsCustomInterval(false);
  }, []);

  // Handle custom interval change
  const handleCustomIntervalChange = useCallback((value: string) => {
    setCustomIntervalInput(value);
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= MIN_CRON_INTERVAL) {
      setIntervalMinutes(parsed);
    }
  }, []);

  // Enable custom interval mode
  const enableCustomInterval = useCallback(() => {
    setIsCustomInterval(true);
    setCustomIntervalInput(String(intervalMinutes));
  }, [intervalMinutes]);

  // Validate form
  const isValid = useMemo(() => {
    if (!prompt.trim()) return false;
    if (intervalMinutes < MIN_CRON_INTERVAL) return false;
    if (useDeadline && !deadline) return false;
    if (useMaxExecutions && maxExecutions < 1) return false;
    return true;
  }, [prompt, intervalMinutes, useDeadline, deadline, useMaxExecutions, maxExecutions]);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    if (!isValid) return;

    const endConditions: CronEndConditions = {
      aiCanExit,
    };

    if (useDeadline && deadline) {
      endConditions.deadline = new Date(deadline).toISOString();
    }

    if (useMaxExecutions) {
      endConditions.maxExecutions = maxExecutions;
    }

    onConfirm({
      prompt: prompt.trim(),
      intervalMinutes,
      endConditions,
      runMode,
      notifyEnabled,
    });
  }, [isValid, prompt, intervalMinutes, runMode, notifyEnabled, aiCanExit, useDeadline, deadline, useMaxExecutions, maxExecutions, onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg rounded-xl bg-[var(--paper)] p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[var(--accent)]" />
            <h2 className="text-lg font-semibold text-[var(--ink)]">定时任务设置</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {/* Prompt (read-only preview) */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
              任务内容
            </label>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-3">
              <p className="text-sm text-[var(--ink-secondary)] line-clamp-3">
                {prompt || '请在输入框中输入任务内容'}
              </p>
            </div>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              发送消息后，AI 将按设定的间隔重复执行此任务
            </p>
          </div>

          {/* Interval Selection */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <Clock className="h-4 w-4" />
              执行间隔
            </label>
            <div className="flex flex-wrap gap-2">
              {CRON_INTERVAL_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => handlePresetSelect(preset.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    !isCustomInterval && intervalMinutes === preset.value
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--paper-contrast)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={enableCustomInterval}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  isCustomInterval
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--paper-contrast)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                }`}
              >
                自定义
              </button>
            </div>
            {isCustomInterval && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  value={customIntervalInput}
                  onChange={(e) => handleCustomIntervalChange(e.target.value)}
                  min={MIN_CRON_INTERVAL}
                  className="w-24 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                />
                <span className="text-sm text-[var(--ink-muted)]">分钟</span>
                {intervalMinutes >= MIN_CRON_INTERVAL && (
                  <span className="text-xs text-[var(--ink-secondary)]">
                    ({formatCronInterval(intervalMinutes)})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* End Conditions */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <Calendar className="h-4 w-4" />
              结束条件 <span className="text-[var(--ink-muted)]">(可多选)</span>
            </label>
            <div className="space-y-2">
              {/* Deadline */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={useDeadline}
                  onChange={(e) => setUseDeadline(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <span className="text-sm text-[var(--ink)]">截止时间</span>
                {useDeadline && (
                  <input
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="ml-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                  />
                )}
              </label>

              {/* Max Executions */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={useMaxExecutions}
                  onChange={(e) => setUseMaxExecutions(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <span className="text-sm text-[var(--ink)]">执行次数</span>
                {useMaxExecutions && (
                  <>
                    <input
                      type="number"
                      value={maxExecutions}
                      onChange={(e) => setMaxExecutions(parseInt(e.target.value, 10) || 1)}
                      min={1}
                      className="ml-2 w-20 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                    />
                    <span className="text-sm text-[var(--ink-muted)]">次</span>
                  </>
                )}
              </label>

              {/* AI Can Exit */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={aiCanExit}
                  onChange={(e) => setAiCanExit(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <span className="text-sm text-[var(--ink)]">允许 AI 自主结束任务</span>
              </label>
            </div>
          </div>

          {/* Run Mode */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <Bot className="h-4 w-4" />
              运行模式
            </label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="runMode"
                  checked={runMode === 'single_session'}
                  onChange={() => setRunMode('single_session')}
                  className="h-4 w-4 border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <div>
                  <span className="text-sm text-[var(--ink)]">保持上下文</span>
                  <p className="text-xs text-[var(--ink-muted)]">AI 记住之前的执行历史</p>
                </div>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="runMode"
                  checked={runMode === 'new_session'}
                  onChange={() => setRunMode('new_session')}
                  className="h-4 w-4 border-[var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <div>
                  <span className="text-sm text-[var(--ink)]">无记忆模式</span>
                  <p className="text-xs text-[var(--ink-muted)]">每次执行都是全新开始</p>
                </div>
              </label>
            </div>
          </div>

          {/* Notification Toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-[var(--ink)]">
              执行完成时发送通知
            </label>
            <button
              type="button"
              onClick={() => setNotifyEnabled(!notifyEnabled)}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                notifyEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--paper-inset)]'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  notifyEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-contrast)]"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isValid}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Outer wrapper component that conditionally renders the form.
 * This ensures the form remounts when the modal opens, resetting all state.
 */
export default function CronTaskSettingsModal({
  isOpen,
  onClose,
  onConfirm,
  initialPrompt = '',
  initialConfig = null,
}: CronTaskSettingsModalProps) {
  // Only render the form when modal is open - this causes remount on open
  if (!isOpen) return null;

  return (
    <CronTaskSettingsForm
      initialPrompt={initialPrompt}
      initialConfig={initialConfig}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
