// Cron Task Settings Modal - Configure scheduled task parameters
import { X, HeartPulse, Calendar, AlertCircle, Bell } from 'lucide-react';
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

/** End mode type */
type EndMode = 'conditional' | 'forever';

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

/** Format Date to datetime-local input value (YYYY-MM-DDTHH:mm) */
function formatDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/** Helper to get default deadline (current time + 24 hours) */
function getDefaultDeadline(): string {
  const date = new Date();
  date.setHours(date.getHours() + 24);
  return formatDateForInput(date);
}

/** Helper to compute initial form values from config or defaults */
function computeInitialValues(initialPrompt: string, initialConfig: InitialConfig | null) {
  if (initialConfig) {
    const isPreset = CRON_INTERVAL_PRESETS.some(p => p.value === initialConfig.intervalMinutes);
    const endCond = initialConfig.endConditions;

    const deadlineValue = endCond.deadline
      ? formatDateForInput(new Date(endCond.deadline))
      : '';

    // Determine end mode: forever if no conditions are set
    const hasAnyCondition = endCond.deadline || endCond.maxExecutions !== undefined || endCond.aiCanExit;
    const endMode: EndMode = hasAnyCondition ? 'conditional' : 'forever';

    return {
      prompt: initialConfig.prompt,
      intervalMinutes: initialConfig.intervalMinutes,
      isCustomInterval: !isPreset,
      customIntervalInput: !isPreset ? String(initialConfig.intervalMinutes) : '60',
      runMode: initialConfig.runMode,
      notifyEnabled: initialConfig.notifyEnabled,
      endMode,
      useDeadline: !!endCond.deadline,
      deadline: deadlineValue || getDefaultDeadline(),
      useMaxExecutions: endCond.maxExecutions !== undefined,
      maxExecutions: endCond.maxExecutions ?? 10,
      aiCanExit: endCond.aiCanExit,
    };
  }

  // Default values: 15 min interval, conditional end with deadline selected
  return {
    prompt: initialPrompt,
    intervalMinutes: 15,
    isCustomInterval: false,
    customIntervalInput: '60',
    runMode: 'single_session' as CronRunMode,
    notifyEnabled: true,
    endMode: 'conditional' as EndMode,
    useDeadline: true,
    deadline: getDefaultDeadline(),
    useMaxExecutions: false,
    maxExecutions: 10,
    aiCanExit: false,
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
  const [prompt] = useState(initial.prompt);
  const [intervalMinutes, setIntervalMinutes] = useState(initial.intervalMinutes);
  const [isCustomInterval, setIsCustomInterval] = useState(initial.isCustomInterval);
  const [customIntervalInput, setCustomIntervalInput] = useState(initial.customIntervalInput);
  const [runMode] = useState<CronRunMode>(initial.runMode);
  const [notifyEnabled, setNotifyEnabled] = useState(initial.notifyEnabled);

  // End mode: conditional or forever
  const [endMode, setEndMode] = useState<EndMode>(initial.endMode);

  // End conditions (only used when endMode is 'conditional')
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
    if (intervalMinutes < MIN_CRON_INTERVAL) errors.push(`循环间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
    if (endMode === 'conditional') {
      if (useDeadline && !deadline) errors.push('请选择截止时间');
      if (useMaxExecutions && maxExecutions < 1) errors.push('执行次数至少为 1');
      // At least one condition must be selected
      if (!useDeadline && !useMaxExecutions && !aiCanExit) {
        errors.push('请至少选择一个结束条件，或选择「永久循环」');
      }
    }
    if (isCustomInterval) {
      const parsed = parseInt(customIntervalInput, 10);
      if (isNaN(parsed)) errors.push('请输入有效的间隔时间');
    }
    return errors;
  }, [intervalMinutes, endMode, useDeadline, deadline, useMaxExecutions, maxExecutions, aiCanExit, isCustomInterval, customIntervalInput]);

  const isValid = validationErrors.length === 0;

  // Get minimum datetime for deadline input (now + 1 minute)
  // Note: Empty deps is intentional - recalculating on every render is unnecessary
  // for a short-lived modal, and the backend validates the deadline anyway
  const minDeadline = useMemo(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    return formatDateForInput(now);
  }, []);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    if (!isValid) return;

    const endConditions: CronEndConditions = {
      aiCanExit: endMode === 'conditional' ? aiCanExit : false,
    };

    if (endMode === 'conditional') {
      if (useDeadline && deadline) {
        endConditions.deadline = new Date(deadline).toISOString();
      }
      if (useMaxExecutions) {
        endConditions.maxExecutions = maxExecutions;
      }
    }
    // In 'forever' mode, no end conditions are set

    onConfirm({
      prompt: prompt.trim(),
      intervalMinutes,
      endConditions,
      runMode,
      notifyEnabled,
    });
  }, [isValid, prompt, intervalMinutes, runMode, notifyEnabled, endMode, aiCanExit, useDeadline, deadline, useMaxExecutions, maxExecutions, onConfirm]);

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
            <HeartPulse className="h-5 w-5 text-[var(--accent)]" />
            <h2 className="text-lg font-semibold text-[var(--ink)]">心跳循环</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {/* Feature Introduction */}
          <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-4">
            <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">
              心跳循环将赋予 AI 按照时间间隔，循环执行任务的能力。
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">
              一旦您在面板内设置开启循环，发送信息后，这段信息就会被按照间隔，不断发送给 AI。
            </p>
          </div>

          {/* Interval Selection */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <HeartPulse className="h-4 w-4" />
              循环间隔
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
                {/* Only show hour conversion when >= 60 minutes */}
                {intervalMinutes >= 60 && (
                  <span className="text-xs text-[var(--ink-secondary)]">
                    ({formatCronInterval(intervalMinutes)})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* End Conditions */}
          <div>
            <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
              <Calendar className="h-4 w-4" />
              结束条件
            </label>

            {/* End Mode Toggle Buttons */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setEndMode('conditional')}
                className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                  endMode === 'conditional'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--line)] bg-[var(--paper-contrast)] text-[var(--ink)] hover:border-[var(--line-strong)]'
                }`}
              >
                条件循环
              </button>
              <button
                type="button"
                onClick={() => setEndMode('forever')}
                className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                  endMode === 'forever'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--line)] bg-[var(--paper-contrast)] text-[var(--ink)] hover:border-[var(--line-strong)]'
                }`}
              >
                永久循环
              </button>
            </div>

            {/* Conditional End Options */}
            {endMode === 'conditional' && (
              <div className="space-y-0 rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)]">
                {/* Deadline */}
                <div
                  className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                  onClick={() => setUseDeadline(!useDeadline)}
                >
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      checked={useDeadline}
                      onChange={setUseDeadline}
                      label="截止时间"
                    />
                    <span className="text-sm text-[var(--ink)]">截止时间</span>
                  </div>
                  <input
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    min={minDeadline}
                    className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${
                      !useDeadline ? 'opacity-50' : ''
                    }`}
                  />
                </div>

                {/* Max Executions */}
                <div
                  className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                  onClick={() => setUseMaxExecutions(!useMaxExecutions)}
                >
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      checked={useMaxExecutions}
                      onChange={setUseMaxExecutions}
                      label="执行次数"
                    />
                    <span className="text-sm text-[var(--ink)]">执行次数</span>
                  </div>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      value={maxExecutions}
                      onChange={(e) => setMaxExecutions(parseInt(e.target.value, 10) || 1)}
                      min={1}
                      max={999}
                      className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${
                        !useMaxExecutions ? 'opacity-50' : ''
                      }`}
                    />
                    <span className={`text-sm text-[var(--ink-secondary)] ${!useMaxExecutions ? 'opacity-50' : ''}`}>次</span>
                  </div>
                </div>

                {/* AI Can Exit */}
                <div
                  className="flex cursor-pointer items-center justify-between px-3 py-2.5"
                  onClick={() => setAiCanExit(!aiCanExit)}
                >
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      checked={aiCanExit}
                      onChange={setAiCanExit}
                      label="允许 AI 自主结束任务"
                    />
                    <span className="text-sm text-[var(--ink)]">
                      允许 AI 自主结束任务
                    </span>
                  </div>
                  {/* Placeholder to maintain consistent row height */}
                  <div className="w-16 h-[26px]" />
                </div>
              </div>
            )}

            {endMode === 'conditional' && (
              <p className="mt-2 text-xs text-[var(--ink-secondary)]">
                可多选，满足任一条件时任务将自动停止
              </p>
            )}
          </div>

          {/* Notification Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper-contrast)] p-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-[var(--ink-secondary)]" />
              <label className="text-sm text-[var(--ink)]">
                每次执行完即发送通知
              </label>
            </div>
            <ToggleSwitch enabled={notifyEnabled} onChange={setNotifyEnabled} />
          </div>

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
