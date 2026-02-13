/**
 * WorkspaceCard - Compact clickable project card for the launcher
 * Single-click to launch, right-click context menu for remove
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, Trash2 } from 'lucide-react';

import type { Project } from '@/config/types';
import { shortenPathForDisplay } from '@/utils/pathDetection';

/**
 * Extract folder name from path (cross-platform, handles both / and \)
 */
function getFolderName(path: string): string {
    if (!path) return 'Workspace';
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || 'Workspace';
}

interface WorkspaceCardProps {
    project: Project;
    onLaunch: (project: Project) => void;
    onRemove: (project: Project) => void;
    isLoading?: boolean;
}

export default function WorkspaceCard({
    project,
    onLaunch,
    onRemove,
    isLoading,
}: WorkspaceCardProps) {
    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        // Clamp position so the menu stays within the viewport
        const menuWidth = 120;
        const menuHeight = 36;
        const x = Math.min(e.clientX, window.innerWidth - menuWidth);
        const y = Math.min(e.clientY, window.innerHeight - menuHeight);
        setContextMenu({ x, y });
    }, []);

    // Close context menu on click-outside or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const handleClose = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setContextMenu(null);
        };
        document.addEventListener('mousedown', handleClose);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClose);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [contextMenu]);

    return (
        <>
            <button
                type="button"
                onClick={() => !isLoading && onLaunch(project)}
                onContextMenu={handleContextMenu}
                disabled={isLoading}
                className={`group flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5 text-left transition-all duration-150 ease-out hover:border-[var(--line-strong)] hover:shadow-[0_4px_12px_-4px_rgba(28,22,18,0.1)] active:scale-[0.97] ${
                    isLoading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
                }`}
            >
                {/* Folder icon */}
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm)]/8 transition-colors group-hover:bg-[var(--accent-warm)]/15">
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-warm)]/70" />
                    ) : (
                        <FolderOpen className="h-4 w-4 text-[var(--accent-warm)]/70 transition-colors group-hover:text-[var(--accent-warm)]" />
                    )}
                </div>

                {/* Text */}
                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[13px] font-medium text-[var(--ink)]">
                        {getFolderName(project.path)}
                    </h3>
                    <p className="mt-0.5 truncate text-[11px] font-light text-[var(--ink-muted)]/60">
                        {shortenPathForDisplay(project.path)}
                    </p>
                </div>
            </button>

            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={menuRef}
                    className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-lg"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    role="menu"
                    aria-label="工作区操作菜单"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setContextMenu(null);
                            onRemove(project);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--error)] transition-colors hover:bg-[var(--paper-contrast)]"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        移除
                    </button>
                </div>
            )}
        </>
    );
}
