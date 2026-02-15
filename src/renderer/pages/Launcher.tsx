/**
 * Launcher - Main entry page for MyAgents
 * Two-column layout: Brand section (left 60%) + Workspaces (right 40%)
 * Responsive: stacks vertically below 768px
 */

import { FolderOpen, Loader2, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { type ImageAttachment } from '@/components/SimpleChatInput';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import PathInputDialog from '@/components/PathInputDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import { BrandSection, RecentTasks, WorkspaceCard } from '@/components/launcher';
import { useConfig } from '@/hooks/useConfig';
import { type Project, type Provider, type PermissionMode, type McpServerDefinition } from '@/config/types';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
} from '@/config/configService';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import type { SessionMetadata } from '@/api/sessionClient';
import type { InitialMessage } from '@/types/tab';

interface LauncherProps {
    onLaunchProject: (project: Project, provider: Provider, sessionId?: string, initialMessage?: InitialMessage) => void;
    isStarting?: boolean;
    startError?: string | null;
}

export default function Launcher({ onLaunchProject, isStarting, startError: _startError }: LauncherProps) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const {
        config,
        projects,
        providers,
        isLoading,
        error: _error,
        addProject,
        removeProject,
        touchProject,
        apiKeys,
        providerVerifyStatus,
        refreshProviderData,
        updateConfig,
    } = useConfig();
    const [_addError, setAddError] = useState<string | null>(null);
    const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);

    // ===== Launcher-specific state for BrandSection =====

    // Fallback chain: defaultWorkspacePath → mino project → first project → null
    const resolveDefaultWorkspace = useCallback((projs: Project[]): Project | null => {
        if (config.defaultWorkspacePath) {
            const def = projs.find(p => p.path === config.defaultWorkspacePath);
            if (def) return def;
        }
        // Fallback: find mino project by path suffix
        const mino = projs.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
        if (mino) return mino;
        return projs[0] ?? null;
    }, [config.defaultWorkspacePath]);

    const [selectedWorkspace, setSelectedWorkspace] = useState<Project | null>(() =>
        resolveDefaultWorkspace(projects)
    );

    // Sync selectedWorkspace when projects change (e.g., after first project is added)
    useEffect(() => {
        setSelectedWorkspace(prev => {
            // If current selection is still valid, keep it
            if (prev && projects.find(p => p.id === prev.id)) return prev;
            // Otherwise re-derive from fallback chain
            return resolveDefaultWorkspace(projects);
        });
    }, [projects, resolveDefaultWorkspace]);

    const [launcherPermissionMode, setLauncherPermissionMode] = useState<PermissionMode>(config.defaultPermissionMode);
    const [launcherProviderId, setLauncherProviderId] = useState<string | undefined>();
    const [launcherSelectedModel, setLauncherSelectedModel] = useState<string | undefined>();

    // MCP state
    const [launcherMcpServers, setLauncherMcpServers] = useState<McpServerDefinition[]>([]);
    const [launcherGlobalMcpEnabled, setLauncherGlobalMcpEnabled] = useState<string[]>([]);
    const [launcherWorkspaceMcpEnabled, setLauncherWorkspaceMcpEnabled] = useState<string[]>([]);

    // Derive provider for launcher
    const launcherProvider = useMemo(() => {
        const id = launcherProviderId ?? selectedWorkspace?.providerId ?? config.defaultProviderId;
        return providers.find(p => p.id === id) ?? providers[0];
    }, [launcherProviderId, selectedWorkspace, config.defaultProviderId, providers]);

    // Load MCP servers when workspace changes
    useEffect(() => {
        const load = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
                setLauncherWorkspaceMcpEnabled(selectedWorkspace?.mcpEnabledServers ?? []);
            } catch (err) {
                console.warn('[Launcher] Failed to load MCP servers:', err);
            }
        };
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWorkspace?.id]);

    // Handle workspace MCP toggle
    const handleWorkspaceMcpToggle = useCallback((serverId: string, enabled: boolean) => {
        setLauncherWorkspaceMcpEnabled(prev =>
            enabled ? [...prev, serverId] : prev.filter(id => id !== serverId)
        );
    }, []);

    // Restore launcherLastUsed settings once config finishes loading from disk.
    // useState initializers run before async config load completes (config = DEFAULT_CONFIG
    // at that point), so we must sync saved values via effect after isLoading becomes false.
    const lastUsedAppliedRef = useRef(false);
    useEffect(() => {
        if (isLoading || lastUsedAppliedRef.current) return;
        lastUsedAppliedRef.current = true;
        const lastUsed = config.launcherLastUsed;
        if (!lastUsed) return;
        if (lastUsed.permissionMode) setLauncherPermissionMode(lastUsed.permissionMode);
        if (lastUsed.providerId) setLauncherProviderId(lastUsed.providerId);
        if (lastUsed.model) setLauncherSelectedModel(lastUsed.model);
        if (lastUsed.mcpEnabledServers) setLauncherWorkspaceMcpEnabled(lastUsed.mcpEnabledServers);
    }, [isLoading, config.launcherLastUsed]);

    // Handle send from BrandSection
    const handleBrandSend = useCallback(async (text: string, images?: ImageAttachment[]) => {
        if (!selectedWorkspace) {
            toastRef.current.error('请先选择工作区');
            return;
        }

        const initialMessage: InitialMessage = {
            text,
            images,
            permissionMode: launcherPermissionMode,
            model: launcherSelectedModel,
            providerId: launcherProvider?.id,
            mcpEnabledServers: launcherWorkspaceMcpEnabled.filter(id => launcherGlobalMcpEnabled.includes(id)),
        };

        // Persist launcher settings for next app launch
        updateConfig({
            launcherLastUsed: {
                providerId: launcherProvider?.id,
                model: launcherSelectedModel,
                permissionMode: launcherPermissionMode,
                mcpEnabledServers: launcherWorkspaceMcpEnabled,
            },
        }).catch(err => console.warn('[Launcher] Failed to save launcherLastUsed:', err));

        setLaunchingProjectId(selectedWorkspace.id);
        touchProject(selectedWorkspace.id).catch(() => {});
        onLaunchProject(selectedWorkspace, launcherProvider, undefined, initialMessage);
    }, [selectedWorkspace, launcherProvider, launcherPermissionMode,
        launcherSelectedModel, launcherWorkspaceMcpEnabled, launcherGlobalMcpEnabled,
        touchProject, onLaunchProject, updateConfig]);

    // Path input dialog state (for browser dev mode)
    const [pathDialogOpen, setPathDialogOpen] = useState(false);
    const [pendingFolderName, setPendingFolderName] = useState('');
    const [pendingDefaultPath, setPendingDefaultPath] = useState('');

    const handleLaunch = useCallback((project: Project, sessionId?: string) => {
        setLaunchingProjectId(project.id);
        const providerId = project.providerId ?? config.defaultProviderId;
        const provider = providers.find((p) => p.id === providerId) ?? providers[0];
        // Update lastOpened timestamp (async, don't block launch)
        touchProject(project.id).catch((err) => {
            console.warn('[Launcher] Failed to update lastOpened:', err);
        });
        onLaunchProject(project, provider, sessionId);
    }, [config.defaultProviderId, providers, touchProject, onLaunchProject]);

    const handleOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleLaunch(project, session.id);
    }, [handleLaunch]);

    const handleAddProject = async () => {
        setAddError(null);
        console.log('[Launcher] handleAddProject called');

        try {
            if (isBrowserDevMode()) {
                const folderInfo = await pickFolderForDialog();
                if (folderInfo) {
                    setPendingFolderName(folderInfo.folderName);
                    setPendingDefaultPath(folderInfo.defaultPath);
                    setPathDialogOpen(true);
                } else {
                    console.log('[Launcher] Folder picker cancelled');
                }
            } else {
                const selected = await open({
                    directory: true,
                    multiple: false,
                    title: '选择项目文件夹',
                });
                console.log('[Launcher] Dialog result:', selected);

                if (selected && typeof selected === 'string') {
                    console.log('[Launcher] Adding project:', selected);
                    const project = await addProject(selected);
                    console.log('[Launcher] Project added:', project);
                } else {
                    console.log('[Launcher] No folder selected or dialog cancelled');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathConfirm = async (path: string) => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path confirmed:', path);

        try {
            const project = await addProject(path);
            console.log('[Launcher] Project added:', project);
            // Normalize path separators for cross-platform support
            const normalizedPath = path.replace(/\\/g, '/');
            const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
            if (parentDir) {
                localStorage.setItem('myagents:lastProjectDir', parentDir);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathCancel = () => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path dialog cancelled');
    };

    const handleRemoveProject = (project: Project) => {
        setProjectToRemove(project);
    };

    const confirmRemoveProject = async () => {
        if (projectToRemove) {
            await removeProject(projectToRemove.id);
            setProjectToRemove(null);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
            {/* Path Input Dialog (browser dev mode) */}
            <PathInputDialog
                isOpen={pathDialogOpen}
                folderName={pendingFolderName}
                defaultPath={pendingDefaultPath}
                onConfirm={handlePathConfirm}
                onCancel={handlePathCancel}
            />

            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={[]}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
            />

            {/* Remove Workspace Confirm Dialog */}
            {projectToRemove && (
                <ConfirmDialog
                    title="移除工作区"
                    message={`确定要从列表中移除「${projectToRemove.name}」吗？此操作不会删除项目文件。`}
                    confirmText="移除"
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={confirmRemoveProject}
                    onCancel={() => setProjectToRemove(null)}
                />
            )}

            {/* Main Content: Two-column layout */}
            <main className="launcher-layout flex-1 overflow-hidden">
                {/* Left: Brand Section */}
                <section className="launcher-brand relative flex items-center justify-center overflow-hidden">
                    <BrandSection
                        projects={projects}
                        selectedProject={selectedWorkspace}
                        defaultWorkspacePath={config.defaultWorkspacePath}
                        onSelectWorkspace={setSelectedWorkspace}
                        onAddFolder={handleAddProject}
                        onSend={handleBrandSend}
                        isStarting={launchingProjectId === selectedWorkspace?.id && isStarting}
                        provider={launcherProvider}
                        providers={providers}
                        selectedModel={launcherSelectedModel}
                        onProviderChange={setLauncherProviderId}
                        onModelChange={setLauncherSelectedModel}
                        permissionMode={launcherPermissionMode}
                        onPermissionModeChange={setLauncherPermissionMode}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={launcherWorkspaceMcpEnabled}
                        globalMcpEnabled={launcherGlobalMcpEnabled}
                        mcpServers={launcherMcpServers}
                        onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
                        onRefreshProviders={refreshProviderData}
                    />
                </section>

                {/* Right: Workspaces Section */}
                <section className="launcher-workspaces flex flex-col overflow-hidden">
                    {/* Recent Tasks */}
                    <div className="flex-shrink-0 px-6 pt-6">
                        <RecentTasks projects={projects} onOpenTask={handleOpenTask} />
                    </div>

                    {/* Workspaces Header */}
                    <div className="flex flex-shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-4">
                        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/60">
                            工作区
                        </h2>
                        <div className="flex items-center gap-3">
                            {config.showDevTools && (
                                <button
                                    onClick={() => setShowLogs(true)}
                                    className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                    title="查看 Rust 日志"
                                >
                                    Logs
                                </button>
                            )}
                            {projects.length > 0 && (
                                <button
                                    onClick={handleAddProject}
                                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Workspaces List */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]/50" />
                                <p className="mt-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</p>
                            </div>
                        ) : projects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--paper-inset)]">
                                    <FolderOpen className="h-6 w-6 text-[var(--ink-muted)]/50" />
                                </div>
                                <h3 className="mb-1.5 text-[14px] font-medium text-[var(--ink)]">
                                    还没有工作区
                                </h3>
                                <p className="mb-5 max-w-[200px] text-[13px] leading-relaxed text-[var(--ink-muted)]/60">
                                    添加一个工作目录开始使用 Agent
                                </p>
                                <button
                                    onClick={handleAddProject}
                                    className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加工作区
                                </button>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {projects.map((project) => (
                                    <WorkspaceCard
                                        key={project.id}
                                        project={project}
                                        onLaunch={handleLaunch}
                                        onRemove={handleRemoveProject}
                                        isLoading={launchingProjectId === project.id && isStarting}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
