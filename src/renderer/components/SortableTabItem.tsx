/**
 * SortableTabItem - Individual sortable tab component
 * Uses @dnd-kit for high-performance drag-and-drop
 *
 * Drag listeners are bound to the title span only (not the entire tab div)
 * to prevent dnd-kit's document-level click capture from swallowing
 * clicks on the close button.
 */

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';

import { type Tab, getFolderName } from '@/types/tab';

interface SortableTabItemProps {
    tab: Tab;
    isActive: boolean;
    onSelect: () => void;
    onClose: () => void;
}

export default function SortableTabItem({
    tab,
    isActive,
    onSelect,
    onClose,
}: SortableTabItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: tab.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 100 : undefined,
        opacity: isDragging ? 0.8 : 1,
    };

    const displayTitle = tab.agentDir
        ? getFolderName(tab.agentDir)
        : tab.title;

    return (
        <div
            ref={setNodeRef}
            style={style}
            data-tab-id={tab.id}
            className={`
                group relative flex h-8 min-w-[100px] max-w-[160px] cursor-default items-center
                rounded-lg px-3 transition-colors duration-150 flex-shrink-0
                ${isDragging ? 'shadow-lg ring-2 ring-[var(--accent)]/30' : ''}
                ${isActive
                    ? 'bg-[var(--paper-contrast)] text-[var(--ink)] shadow-sm'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]/60 hover:text-[var(--ink)]'
                }
            `}
            onClick={onSelect}
            {...attributes}
        >
            {/* Tab title — drag handle is bound here, not on the entire tab */}
            <span
                className="flex-1 truncate text-[12px] font-medium select-none cursor-grab active:cursor-grabbing"
                {...listeners}
            >
                {displayTitle}
            </span>

            {/* Close button — enlarged hit area (24×24) with visual icon (12×12) */}
            <button
                className={`
                    -mr-1.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full
                    transition-all duration-150
                    ${isActive
                        ? 'opacity-60 hover:bg-[var(--ink)]/10 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-60 hover:!bg-[var(--ink)]/10 hover:!opacity-100'
                    }
                `}
                onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                }}
                title="关闭标签页"
            >
                <X className="h-3 w-3" />
            </button>

            {/* Active indicator */}
            {isActive && (
                <div className="absolute bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-[var(--accent)]" />
            )}
        </div>
    );
}
