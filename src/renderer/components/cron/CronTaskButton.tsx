// Cron Task Button - Timer button to enable scheduled task mode
import { Clock } from 'lucide-react';

interface CronTaskButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
}

export default function CronTaskButton({ onClick, isActive = false, disabled = false }: CronTaskButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 items-center justify-center rounded-full border transition focus:ring-2 focus:outline-none ${
        isActive
          ? 'border-blue-400 bg-blue-100 text-blue-600 hover:bg-blue-200 focus:ring-blue-400 dark:border-blue-500 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 dark:focus:ring-blue-500'
          : 'border-neutral-200/80 bg-neutral-100 text-neutral-600 hover:bg-neutral-200 focus:ring-neutral-400 dark:border-neutral-700/70 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 dark:focus:ring-neutral-500'
      } disabled:cursor-not-allowed disabled:opacity-50`}
      title={isActive ? '定时任务模式已启用' : '启用定时任务'}
    >
      <Clock className="h-4 w-4" />
    </button>
  );
}
