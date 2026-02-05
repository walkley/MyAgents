import { useEffect, useRef, useState, useMemo } from 'react';
import { BarChart2, Clock, Trash2 } from 'lucide-react';

import { deleteSession, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { deactivateSession } from '@/api/tauriClient';
import { getWorkspaceCronTasks } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatTokens } from '@/utils/formatTokens';

import SessionStatsModal from './SessionStatsModal';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    /** Called when the current session is deleted - should reset to "new conversation" state */
    onDeleteCurrentSession: () => void;
    isOpen: boolean;
    onClose: () => void;
}

// Track fetch state: null = not fetched, empty array = fetched but empty
type FetchState = SessionMetadata[] | null;
type CronTaskFetchState = CronTask[] | null;

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    onDeleteCurrentSession,
    isOpen,
    onClose,
}: SessionHistoryDropdownProps) {
    const [sessions, setSessions] = useState<FetchState>(null);
    const [cronTasks, setCronTasks] = useState<CronTaskFetchState>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    // Track pending delete to show confirmation UI
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
    // Track delete error for user feedback
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const dropdownRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    // Map sessionId to active cron task (running only)
    const sessionCronTaskMap = useMemo(() => {
        if (!cronTasks) return new Map<string, CronTask>();
        return new Map(
            cronTasks
                .filter(t => t.status === 'running')
                .map(t => [t.sessionId, t])
        );
    }, [cronTasks]);

    // Keep onClose ref updated via effect
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    // Load sessions and cron tasks when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        let cancelled = false;

        (async () => {
            // Load sessions and cron tasks in parallel, with independent error handling
            const [sessionsResult, cronTasksResult] = await Promise.allSettled([
                getSessions(agentDir),
                getWorkspaceCronTasks(agentDir),
            ]);

            if (cancelled) return;

            // Always set sessions if available (primary data)
            if (sessionsResult.status === 'fulfilled') {
                setSessions(sessionsResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load sessions:', sessionsResult.reason);
                setSessions([]); // Show empty state rather than loading forever
            }

            // Cron tasks are optional enhancement - don't block on failure
            if (cronTasksResult.status === 'fulfilled') {
                setCronTasks(cronTasksResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load cron tasks:', cronTasksResult.reason);
                setCronTasks([]); // Fall back to no cron task indicators
            }
        })();

        return () => {
            cancelled = true;
            // Reset state when closing or agentDir changes
            setSessions(null);
            setCronTasks(null);
            setStatsSession(null);
            setPendingDeleteId(null);
            setDeleteError(null);
        };
    }, [isOpen, agentDir]);

    // Close on outside click (using stable ref to avoid re-attaching listener)
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onCloseRef.current();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        e.preventDefault();
        setDeleteError(null); // Clear any previous error
        setPendingDeleteId(sessionId);
    };

    const handleConfirmDelete = async () => {
        if (!pendingDeleteId) return;
        const sessionId = pendingDeleteId;
        const isDeletingCurrentSession = sessionId === currentSessionId;
        setPendingDeleteId(null);
        setDeleteError(null);

        try {
            const success = await deleteSession(sessionId);
            if (success) {
                // Clean up Rust layer session activation state
                // This prevents stale entries in session_activations HashMap
                await deactivateSession(sessionId);

                setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);

                // If we deleted the current session, trigger "new conversation" behavior
                // Don't close the dropdown - keep it open so user can continue browsing history
                if (isDeletingCurrentSession) {
                    onDeleteCurrentSession(); // Reset to new conversation state
                }
            } else {
                setDeleteError('删除失败，请重试');
                console.error(`[SessionHistoryDropdown] Failed to delete session ${sessionId}`);
            }
        } catch (error) {
            setDeleteError('删除失败，请重试');
            console.error(`[SessionHistoryDropdown] Error deleting session ${sessionId}:`, error);
        }
    };

    const handleCancelDelete = () => {
        setPendingDeleteId(null);
    };

    const handleShowStats = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: session.title });
    };

    const formatTime = (isoString: string) => {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            return '昨天';
        } else if (diffDays < 7) {
            return `${diffDays}天前`;
        } else {
            return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        }
    };

    if (!isOpen) return null;

    // Derive loading state: open but sessions not yet fetched
    const isLoading = sessions === null;

    return (
        <>
            <div
                ref={dropdownRef}
                className="absolute right-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg"
            >
                {/* Header */}
                <div className="border-b border-[var(--line)] px-4 py-2">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">历史记录</h3>
                </div>

                {/* Delete error toast */}
                {deleteError && (
                    <div className="border-b border-[var(--error)]/20 bg-[var(--error)]/10 px-4 py-2 text-xs text-[var(--error)]">
                        {deleteError}
                    </div>
                )}

                {/* Session list */}
                <div className="max-h-80 overflow-y-auto">
                    {isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            加载中...
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            暂无历史记录
                        </div>
                    ) : (
                        sessions.map((session) => {
                            const isCurrent = session.id === currentSessionId;
                            const stats = session.stats;
                            const hasStats = stats && (stats.messageCount > 0 || stats.totalInputTokens > 0);
                            const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);

                            return (
                                <div
                                    key={session.id}
                                    className={`group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors ${isCurrent
                                        ? 'bg-[var(--accent)]/10'
                                        : 'hover:bg-[var(--paper-contrast)]'
                                        }`}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            onSelectSession(session.id);
                                            onClose();
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            {isCurrent && (
                                                <span className="flex-shrink-0 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                                                    当前
                                                </span>
                                            )}
                                            {sessionCronTaskMap.has(session.id) && (
                                                <span className="flex-shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                                                    心跳
                                                </span>
                                            )}
                                            <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                {session.title}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                {formatTime(session.lastActiveAt)}
                                            </span>
                                            {hasStats && (
                                                <>
                                                    <span>·</span>
                                                    <span>{stats.messageCount} 条消息</span>
                                                    <span>·</span>
                                                    <span>{formatTokens(totalTokens)} tokens</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-shrink-0 items-center gap-1">
                                        {/* Show confirmation buttons when pending delete */}
                                        {pendingDeleteId === session.id ? (
                                            <>
                                                <button
                                                    className="flex h-6 items-center justify-center rounded bg-[var(--error)] px-2 text-xs font-medium text-white transition-colors hover:bg-[var(--error)]/80"
                                                    onClick={handleConfirmDelete}
                                                >
                                                    确认
                                                </button>
                                                <button
                                                    className="flex h-6 items-center justify-center rounded bg-[var(--paper-contrast)] px-2 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--line)]"
                                                    onClick={handleCancelDelete}
                                                >
                                                    取消
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] group-hover:opacity-100"
                                                    onClick={(e) => handleShowStats(e, session)}
                                                    title="查看统计"
                                                >
                                                    <BarChart2 className="h-3.5 w-3.5" />
                                                </button>
                                                {/* Disable delete for sessions with running cron tasks */}
                                                {sessionCronTaskMap.has(session.id) ? (
                                                    <button
                                                        className="flex h-6 w-6 cursor-not-allowed items-center justify-center rounded opacity-0 group-hover:opacity-50"
                                                        disabled
                                                        title="请先停止心跳循环后再删除"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                                                    </button>
                                                ) : (
                                                    <button
                                                        className="flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--error-bg)] group-hover:opacity-100"
                                                        onClick={(e) => handleDeleteClick(e, session.id)}
                                                        title="删除"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5 text-[var(--error)]" />
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Stats Modal */}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
        </>
    );
}
