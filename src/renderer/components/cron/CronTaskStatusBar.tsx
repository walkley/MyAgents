// Cron Task Status Bar - Shows above input when cron mode is enabled
import { Clock, Settings2, X } from 'lucide-react';
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
    <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-blue-300 bg-blue-50 px-3 py-2 dark:border-blue-700 dark:bg-blue-900/30">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
          定时任务模式
        </span>
        <span className="text-sm text-blue-600 dark:text-blue-400">
          每 {formatCronInterval(intervalMinutes)} 执行一次
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSettings}
          className="rounded-md p-1.5 text-blue-600 transition hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-800/50"
          title="修改设置"
        >
          <Settings2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1.5 text-blue-600 transition hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-800/50"
          title="取消定时任务"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
