import { Clock, Play, X } from 'lucide-react';

import type { QueuedMessageInfo } from '@/types/queue';

interface QueuedMessageBubbleProps {
  info: QueuedMessageInfo;
  onCancel: () => void;
  onForceExecute: () => void;
}

export default function QueuedMessageBubble({ info, onCancel, onForceExecute }: QueuedMessageBubbleProps) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-[var(--ink-muted)]/30 p-3 opacity-70">
      {/* Left: status + content */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
          <Clock size={12} />
          <span>排队中</span>
        </div>
        <div className="break-words text-sm text-[var(--ink)]">
          {info.text.length > 200 ? info.text.slice(0, 200) + '...' : info.text}
        </div>
        {info.images && info.images.length > 0 && (
          <div className="mt-1 flex gap-1">
            {info.images.map((img) => (
              <div key={img.id} className="h-8 w-8 overflow-hidden rounded border border-[var(--ink-muted)]/20">
                <img src={img.preview} alt={img.name} className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: action buttons */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onForceExecute}
          title="立即发送"
          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
        >
          <Play size={14} />
        </button>
        <button
          onClick={onCancel}
          title="取消排队"
          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
