// Cron Task Settings Modal - Configure scheduled task parameters
import { X, Clock, Calendar, Bot, AlertCircle, Bell } from 'lucide-react';
import { useState, useCallback, useMemo } from 'react';
import type { CronEndConditions, CronRunMode, CronTaskConfig } from '@/types/cronTask';
import { CRON_INTERVAL_PRESETS, MIN_CRON_INTERVAL, formatCronInterval } from '@/types/cronTask';

/** Custom Toggle Switch component - matches design system */
function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ${
        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/** Custom Checkbox component - consistent styling */
function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 transition-colors ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--line-strong)] bg-transparent hover:border-[var(--accent-muted)]'
      }`}
    >
      {checked && (
        <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** Custom Radio component - consistent styling */
function Radio({ checked, onChange, label }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--line-strong)] bg-transparent hover:border-[var(--accent-muted)]'
      }`}
    >
      {checked && (
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
      )}
    </button>
  );
}

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

  // Validation errors
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!prompt.trim()) errors.push('请输入任务内容');
    if (intervalMinutes < MIN_CRON_INTERVAL) errors.push(`执行间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
    if (useDeadline && !deadline) errors.push('请选择截止时间');
    if (useMaxExecutions && maxExecutions < 1) errors.push('执行次数至少为 1');
    if (isCustomInterval) {
      const parsed = parseInt(customIntervalInput, 10);
      if (isNaN(parsed)) errors.push('请输入有效的间隔时间');
    }
    return errors;
  }, [prompt, intervalMinutes, useDeadline, deadline, useMaxExecutions, maxExecutions, isCustomInterval, customIntervalInput]);

  const isValid = validationErrors.length === 0;

  // Calculate preview info
  const previewInfo = useMemo(() => {
    if (!isValid) return null;

    const now = new Date();
    const nextExecution = new Date(now.getTime() + intervalMinutes * 60000);

    let estimatedCompletion: Date | null = null;
    if (useDeadline && deadline) {
      estimatedCompletion = new Date(deadline);
    } else if (useMaxExecutions) {
      // Estimate completion based on execution count
      estimatedCompletion = new Date(now.getTime() + maxExecutions * intervalMinutes * 60000);
    }

    return {
      nextExecution,
      estimatedCompletion,
    };
  }, [isValid, intervalMinutes, useDeadline, deadline, useMaxExecutions, maxExecutions]);

  // Format time for preview - memoized to avoid recreation on every render
  const formatPreviewTime = useCallback((date: Date): string => {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = date.toDateString() === tomorrow.toDateString();

    const timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (isToday) return `今天 ${timeStr}`;
    if (isTomorrow) return `明天 ${timeStr}`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + timeStr;
  }, []);

  // Get minimum datetime for deadline input (now + 1 minute)
  const minDeadline = useMemo(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }, []);

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
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-[var(--ink)]">
                待发送的消息
              </label>
              <span className="text-xs text-[var(--ink-muted)]">
                {prompt.length} 字
              </span>
            </div>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-3">
              <p className="text-sm text-[var(--ink-secondary)] line-clamp-3">
                {prompt || '请在输入框中输入任务内容'}
              </p>
            </div>
            <p className="mt-1.5 text-xs text-[var(--ink-secondary)]">
              发送后，AI 将按设定的间隔重复执行此消息
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
            <div className="mb-2">
              <label className="flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
                <Calendar className="h-4 w-4" />
                结束条件
              </label>
              <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                可多选，满足任一条件时任务将自动停止
              </p>
            </div>
            <div className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-3">
              {/* Deadline */}
              <div
                className="flex items-start gap-2.5 cursor-pointer"
                onClick={() => setUseDeadline(!useDeadline)}
              >
                <Checkbox
                  checked={useDeadline}
                  onChange={setUseDeadline}
                  label="截止时间"
                />
                <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                  <span className="text-sm text-[var(--ink)]">截止时间</span>
                  {useDeadline && (
                    <input
                      type="datetime-local"
                      value={deadline}
                      onChange={(e) => setDeadline(e.target.value)}
                      min={minDeadline}
                      className="mt-1.5 block w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                  )}
                </div>
              </div>

              {/* Max Executions */}
              <div
                className="flex items-start gap-2.5 cursor-pointer"
                onClick={() => setUseMaxExecutions(!useMaxExecutions)}
              >
                <Checkbox
                  checked={useMaxExecutions}
                  onChange={setUseMaxExecutions}
                  label="执行次数"
                />
                <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                  <span className="text-sm text-[var(--ink)]">执行次数</span>
                  {useMaxExecutions && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        type="number"
                        value={maxExecutions}
                        onChange={(e) => setMaxExecutions(parseInt(e.target.value, 10) || 1)}
                        min={1}
                        max={999}
                        className="w-20 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                      />
                      <span className="text-sm text-[var(--ink-secondary)]">次</span>
                    </div>
                  )}
                </div>
              </div>

              {/* AI Can Exit */}
              <div
                className="flex items-center gap-2.5 cursor-pointer"
                onClick={() => setAiCanExit(!aiCanExit)}
              >
                <Checkbox
                  checked={aiCanExit}
                  onChange={setAiCanExit}
                  label="允许 AI 自主结束任务"
                />
                <span className="text-sm text-[var(--ink)]">
                  允许 AI 自主结束任务
                </span>
              </div>
            </div>
          </div>

          {/* Run Mode */}
          <div>
            <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <Bot className="h-4 w-4" />
              运行模式
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRunMode('single_session')}
                className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
                  runMode === 'single_session'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--line)] bg-[var(--paper-contrast)] hover:border-[var(--line-strong)]'
                }`}
              >
                <Radio
                  checked={runMode === 'single_session'}
                  onChange={() => setRunMode('single_session')}
                  label="保持上下文"
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-[var(--ink)]">保持上下文</span>
                  <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">AI 记住之前的执行历史</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setRunMode('new_session')}
                className={`flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
                  runMode === 'new_session'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--line)] bg-[var(--paper-contrast)] hover:border-[var(--line-strong)]'
                }`}
              >
                <Radio
                  checked={runMode === 'new_session'}
                  onChange={() => setRunMode('new_session')}
                  label="无记忆模式"
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-[var(--ink)]">无记忆模式</span>
                  <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">每次执行都是全新开始</p>
                </div>
              </button>
            </div>
          </div>

          {/* Notification Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-[var(--ink-secondary)]" />
              <label className="text-sm text-[var(--ink)]">
                执行完成时发送通知
              </label>
            </div>
            <ToggleSwitch enabled={notifyEnabled} onChange={setNotifyEnabled} />
          </div>

          {/* Preview Info */}
          {previewInfo && (
            <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/50 p-3">
              <div className="flex flex-col gap-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--ink-muted)]">首次执行</span>
                  <span className="font-medium text-[var(--ink-secondary)]">
                    {formatPreviewTime(previewInfo.nextExecution)}
                  </span>
                </div>
                {previewInfo.estimatedCompletion && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--ink-muted)]">预计完成</span>
                    <span className="font-medium text-[var(--ink-secondary)]">
                      {formatPreviewTime(previewInfo.estimatedCompletion)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Validation Errors */}
          {validationErrors.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />
              <div className="text-xs text-[var(--error)]">
                {validationErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            </div>
          )}
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
