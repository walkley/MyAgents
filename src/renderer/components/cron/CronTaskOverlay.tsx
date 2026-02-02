// Cron Task Overlay - Covers input area when task is running
// Follows design_guide.md: warm paper tones, elegant and unobtrusive
import { useState, useEffect } from 'react';
import { Clock, Pause, Square, Settings2, Play } from 'lucide-react';
import type { CronTaskStatus } from '@/types/cronTask';
import { formatCronInterval } from '@/types/cronTask';

interface CronTaskOverlayProps {
  status: CronTaskStatus;
  intervalMinutes: number;
  executionCount: number;
  nextExecutionTime?: Date;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSettings: () => void;
}

export default function CronTaskOverlay({
  status,
  intervalMinutes,
  executionCount,
  nextExecutionTime,
  onPause,
  onResume,
  onStop,
  onSettings
}: CronTaskOverlayProps) {
  const isRunning = status === 'running';
  const isPaused = status === 'paused';

  // State to force re-render for countdown update
  const [, setTick] = useState(0);

  // Update countdown every second when running
  useEffect(() => {
    if (!isRunning || !nextExecutionTime) return;

    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, nextExecutionTime]);

  // Calculate time until next execution
  const getTimeUntilNext = (): string | null => {
    if (!nextExecutionTime || !isRunning) return null;
    const now = new Date();
    const diff = nextExecutionTime.getTime() - now.getTime();
    if (diff <= 0) return '即将执行';

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${seconds}s`;
  };

  const timeUntilNext = getTimeUntilNext();

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 px-5 py-4 backdrop-blur-sm">
      {/* Left: Status Info */}
      <div className="flex items-center gap-3">
        {/* Status Icon */}
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          isPaused
            ? 'bg-[var(--warning)]/10'
            : 'bg-[var(--accent-warm)]/10'
        }`}>
          <Clock className={`h-4 w-4 ${
            isPaused
              ? 'text-[var(--warning)]'
              : 'text-[var(--accent-warm)]'
          } ${isRunning ? 'animate-pulse' : ''}`} />
        </div>

        {/* Status Text */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-[var(--ink)]">
              定时任务{isRunning ? '运行中' : '已暂停'}
            </span>
            {isRunning && timeUntilNext && (
              <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink-muted)]">
                {timeUntilNext}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--ink-muted)]">
            <span>每 {formatCronInterval(intervalMinutes)}</span>
            <span className="text-[var(--line-strong)]">·</span>
            <span>已执行 {executionCount} 次</span>
            {isPaused && (
              <>
                <span className="text-[var(--line-strong)]">·</span>
                <span className="text-[var(--warning)]">暂停中可手动对话</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right: Control Buttons - PRD specifies "设置" and "停止" */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Pause/Resume Button */}
        {isRunning ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <Pause className="h-3.5 w-3.5" />
            暂停
          </button>
        ) : (
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Play className="h-3.5 w-3.5" />
            恢复
          </button>
        )}

        {/* Settings Button - Ghost style per design guide */}
        <button
          onClick={onSettings}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <Settings2 className="h-3.5 w-3.5" />
          设置
        </button>

        {/* Stop Button - Danger style per design guide */}
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--error)] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[var(--error)]/90"
        >
          <Square className="h-3.5 w-3.5" />
          停止
        </button>
      </div>
    </div>
  );
}
