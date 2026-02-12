/**
 * ClaudeMdEditor - Component for viewing and editing CLAUDE.md
 * Supports preview/edit mode with ref for parent to check editing state
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context.
 */
import { Save, Edit2, X, FolderOpen, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useMemo, useRef } from 'react';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import { shortenPathForDisplay } from '@/utils/pathDetection';

interface ClaudeMdEditorProps {
    agentDir: string;
}

export interface ClaudeMdEditorRef {
    isEditing: () => boolean;
}

interface ClaudeMdResponse {
    success: boolean;
    exists: boolean;
    path: string;
    content: string;
    error?: string;
}

const ClaudeMdEditor = forwardRef<ClaudeMdEditorRef, ClaudeMdEditorProps>(
    function ClaudeMdEditor({ agentDir }, ref) {
        const toast = useToast();
        // Stabilize toast reference to avoid unnecessary effect re-runs
        const toastRef = useRef(toast);
        toastRef.current = toast;

        // Use Tab-scoped API when available (in project workspace context)
        const tabState = useTabApiOptional();

        // Create stable API functions - only depend on the specific functions, not the whole tabState
        // This prevents re-creating the api object when unrelated tabState properties change
        const apiGet = tabState?.apiGet;
        const apiPost = tabState?.apiPost;

        const api = useMemo(() => {
            if (apiGet && apiPost) {
                return { get: apiGet, post: apiPost };
            }
            return { get: globalApiGet, post: globalApiPost };
        }, [apiGet, apiPost]);

        // Track if we're in tab context (stable boolean that won't change)
        const isInTabContext = !!tabState;
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [content, setContent] = useState('');
        const [editContent, setEditContent] = useState('');
        const [isEditing, setIsEditing] = useState(false);
        const [exists, setExists] = useState(false);
        const [path, setPath] = useState('');
        const [error, setError] = useState<string | null>(null);

        // Expose isEditing to parent
        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load CLAUDE.md content
        useEffect(() => {
            const loadContent = async () => {
                setLoading(true);
                setError(null);
                try {
                    // When using Tab API, no need to pass agentDir (sidecar already has it)
                    const endpoint = isInTabContext
                        ? '/api/claude-md'
                        : `/api/claude-md?agentDir=${encodeURIComponent(agentDir)}`;
                    const response = await api.get<ClaudeMdResponse>(endpoint);
                    if (response.success) {
                        setContent(response.content);
                        setEditContent(response.content);
                        setExists(response.exists);
                        // 显示项目相对路径，而不是临时目录的绝对路径
                        setPath(`${agentDir}/CLAUDE.md`);
                    } else {
                        setError(response.error || 'Failed to load CLAUDE.md');
                    }
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to load CLAUDE.md');
                } finally {
                    setLoading(false);
                }
            };
            loadContent();
        }, [agentDir, api, isInTabContext]);

        const handleEdit = useCallback(() => {
            setEditContent(content);
            setIsEditing(true);
        }, [content]);

        const handleCancel = useCallback(() => {
            setEditContent(content);
            setIsEditing(false);
        }, [content]);

        const handleSave = useCallback(async () => {
            setSaving(true);
            try {
                // When using Tab API, no need to pass agentDir (sidecar already has it)
                const endpoint = isInTabContext
                    ? '/api/claude-md'
                    : `/api/claude-md?agentDir=${encodeURIComponent(agentDir)}`;
                const response = await api.post<{ success: boolean; error?: string }>(endpoint, {
                    content: editContent
                });
                if (response.success) {
                    setContent(editContent);
                    setExists(true);
                    setIsEditing(false);
                    toastRef.current.success('CLAUDE.md 保存成功');
                } else {
                    toastRef.current.error(response.error || '保存失败');
                }
            } catch (err) {
                toastRef.current.error(err instanceof Error ? err.message : '保存失败');
            } finally {
                setSaving(false);
            }
        }, [editContent, agentDir, api, isInTabContext]);

        const handleOpenInFinder = useCallback(async () => {
            try {
                // When using Tab API, no need to pass agentDir (sidecar already has it)
                const payload = isInTabContext
                    ? { path: 'CLAUDE.md' }
                    : { path: 'CLAUDE.md', agentDir };
                await api.post('/agent/open-in-finder', payload);
            } catch {
                toastRef.current.error('无法打开目录');
            }
        }, [agentDir, api, isInTabContext]);

        if (loading) {
            return (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
                    <AlertCircle className="h-12 w-12 text-[var(--error)]" />
                    <p className="text-sm text-[var(--ink-muted)]">{error}</p>
                </div>
            );
        }

        return (
            <div className="flex h-full flex-col">
                {/* Header - 仅在文件存在或编辑模式下显示 */}
                {(exists || isEditing) && (
                    <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-contrast)]/50 px-6 py-3">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent-warm)]/10">
                                <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
                            </div>
                            <div>
                                <h3 className="text-sm font-semibold text-[var(--ink)]">CLAUDE.md</h3>
                                <div className="flex items-center gap-2">
                                    <span className="max-w-[350px] truncate font-mono text-xs text-[var(--ink-muted)]" title={path}>{shortenPathForDisplay(path)}</span>
                                    <button
                                        type="button"
                                        onClick={handleOpenInFinder}
                                        className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                        title="在 Finder 中打开"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {isEditing ? (
                                <div key="editing" className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleCancel}
                                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                                    >
                                        <X className="h-4 w-4" />
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={saving}
                                        className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                    >
                                        {saving ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Save className="h-4 w-4" />
                                        )}
                                        保存
                                    </button>
                                </div>
                            ) : (
                                <button
                                    key="view"
                                    type="button"
                                    onClick={handleEdit}
                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)]"
                                >
                                    <Edit2 className="h-4 w-4" />
                                    编辑
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Content Area */}
                <div className="flex-1 overflow-hidden">
                    {!exists && !isEditing ? (
                        <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
                            <FileText className="h-16 w-16 text-[var(--ink-muted)]/30" />
                            <div className="text-center">
                                <p className="text-sm font-medium text-[var(--ink-muted)]">
                                    CLAUDE.md 文件不存在
                                </p>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                    点击「编辑」按钮创建新的 CLAUDE.md 文件
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleEdit}
                                className="mt-2 flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                            >
                                <Edit2 className="h-4 w-4" />
                                创建 CLAUDE.md
                            </button>
                        </div>
                    ) : isEditing ? (
                        <div className="h-full bg-[var(--paper)]">
                            <MonacoEditor
                                value={editContent}
                                onChange={setEditContent}
                                language="markdown"
                            />
                        </div>
                    ) : (
                        <div className="h-full overflow-auto bg-[var(--paper-reading)] p-6">
                            {content ? (
                                <div className="prose prose-stone max-w-none dark:prose-invert">
                                    <Markdown raw>{content}</Markdown>
                                </div>
                            ) : (
                                <span className="text-sm text-[var(--ink-muted)]/60">
                                    （无内容）
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    });

export default ClaudeMdEditor;
