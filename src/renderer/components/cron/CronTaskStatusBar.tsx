// Cron Task Status Bar - Shows above input when heartbeat loop mode is enabled
import { HeartPulse, Settings2, X } from 'lucide-react';
import { formatCronInterval } from '@/types/cronTask';

interface CronTaskStatusBarProps {
  intervalMinutes: number;
  onSettings: () => void;
  onCancel: () => void;
}

export default function CronTaskStatusBar({
  intervalMinutes,
  onSettings,
  onCancel
}: CronTaskStatusBarProps) {
  return (
    <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-[var(--accent-warm)]/20 bg-[var(--accent-warm)]/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <HeartPulse className="h-4 w-4 text-[var(--accent-warm)]" />
        <span className="text-sm font-medium text-[var(--accent-warm)]">
          心跳循环模式
        </span>
        <span className="text-sm text-[var(--ink-muted)]">
          每 {formatCronInterval(intervalMinutes)} 执行一次
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSettings}
          className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--accent-warm)]/10 hover:text-[var(--accent-warm)]"
          title="修改设置"
        >
          <Settings2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--accent-warm)]/10 hover:text-[var(--accent-warm)]"
          title="取消心跳循环"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
