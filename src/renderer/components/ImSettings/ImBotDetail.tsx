import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, FolderOpen, Loader2, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { getAllMcpServers, getEnabledMcpServerIds, loadAppConfig, removeImBotConfig, updateImBotConfig } from '@/config/configService';
import { getProviderModels, type McpServerDefinition } from '@/config/types';
import CustomSelect from '@/components/CustomSelect';
import BotTokenInput from './components/BotTokenInput';
import FeishuCredentialInput from './components/FeishuCredentialInput';
import WhitelistManager from './components/WhitelistManager';
import PermissionModeSelect from './components/PermissionModeSelect';
import BotStatusPanel from './components/BotStatusPanel';
import BindQrPanel from './components/BindQrPanel';
import BindCodePanel from './components/BindCodePanel';
import AiConfigCard from './components/AiConfigCard';
import McpToolsCard from './components/McpToolsCard';
import type { ImBotConfig, ImBotStatus } from '../../../shared/types/im';

export default function ImBotDetail({
    botId,
    onBack,
}: {
    botId: string;
    onBack: () => void;
}) {
    const { config, providers, apiKeys, projects, addProject, refreshConfig } = useConfig();
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    const nameSyncedRef = useRef(false);

    // Find bot config from app config
    const botConfig = useMemo(
        () => (config.imBotConfigs ?? []).find(c => c.id === botId),
        [config.imBotConfigs, botId],
    );

    // MCP state
    const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
    const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);

    // Bot runtime status
    const [botStatus, setBotStatus] = useState<ImBotStatus | null>(null);
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [toggling, setToggling] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [credentialsExpanded, setCredentialsExpanded] = useState<boolean | null>(null);
    const [bindingExpanded, setBindingExpanded] = useState<boolean | null>(null);

    // Whether credentials are filled
    const hasCredentials = botConfig
        ? botConfig.platform === 'feishu'
            ? !!(botConfig.feishuAppId && botConfig.feishuAppSecret)
            : !!botConfig.botToken
        : false;
    const hasUsers = (botConfig?.allowedUsers.length ?? 0) > 0;

    // Auto-collapse: default collapsed when filled, expanded when empty
    const isCredentialsExpanded = credentialsExpanded ?? !hasCredentials;
    const isBindingExpanded = bindingExpanded ?? !hasUsers;

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Save bot config to disk and sync React state
    const saveBotField = useCallback(async (updates: Partial<ImBotConfig>) => {
        await updateImBotConfig(botId, updates);
        await refreshConfig();
    }, [botId, refreshConfig]);

    // Ref for bot config (used in effects without re-triggering)
    const botConfigRef = useRef(botConfig);
    botConfigRef.current = botConfig;

    // Poll bot status (skip while toggling to avoid overwriting optimistic update)
    const togglingRef = useRef(toggling);
    togglingRef.current = toggling;

    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchStatus = async () => {
            if (togglingRef.current) return; // Skip poll during toggle
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ImBotStatus>('cmd_im_bot_status', { botId });
                if (isMountedRef.current && !togglingRef.current) {
                    setBotStatus(status);
                    if (status.botUsername) {
                        setBotUsername(status.botUsername);
                        setVerifyStatus('valid');
                        // Auto-sync bot name from platform username (once)
                        if (!nameSyncedRef.current) {
                            nameSyncedRef.current = true;
                            // Telegram uses @username, Feishu uses plain app name
                            const platform = botConfigRef.current?.platform;
                            const displayName = platform === 'telegram'
                                ? `@${status.botUsername}`
                                : status.botUsername;
                            if (botConfigRef.current?.name !== displayName) {
                                updateImBotConfig(botId, { name: displayName }).catch(err => {
                                    console.error('[ImBotDetail] Failed to sync bot name:', err);
                                });
                            }
                        }
                    }
                }
            } catch {
                if (isMountedRef.current && !togglingRef.current) setBotStatus(null);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [botId]);

    // Load MCP servers
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const servers = await getAllMcpServers();
                const enabledIds = await getEnabledMcpServerIds();
                if (!cancelled) {
                    setMcpServers(servers);
                    setGlobalMcpEnabled(enabledIds);
                }
            } catch (err) {
                console.error('[ImBotDetail] Failed to load MCP servers:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Listen for user-bound events — Rust already persists to config.json,
    // so we just refresh React state from disk and show a toast.
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current || event.payload.botId !== botId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;

                toastRef.current.success(`用户 ${displayName} 已通过二维码绑定`);
                // Refresh config from disk to pick up Rust-persisted bound user
                refreshConfig();
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [botId, refreshConfig]);

    // Build start params
    const buildStartParams = useCallback(async (cfg: ImBotConfig) => {
        const selectedProvider = providers.find(p => p.id === cfg.providerId);
        let providerEnvJson: string | undefined;
        if (selectedProvider && selectedProvider.type !== 'subscription') {
            providerEnvJson = JSON.stringify({
                baseUrl: selectedProvider.config.baseUrl,
                apiKey: apiKeys[selectedProvider.id],
                authType: selectedProvider.authType,
            });
        }

        const availableProviders = providers
            .filter(p => p.type === 'subscription' || (p.type === 'api' && apiKeys[p.id]))
            .map(p => ({
                id: p.id,
                name: p.name,
                primaryModel: p.primaryModel,
                baseUrl: p.config.baseUrl,
                authType: p.authType,
                apiKey: p.type !== 'subscription' ? apiKeys[p.id] : undefined,
            }));

        const allServers = await getAllMcpServers();
        const globalEnabled = await getEnabledMcpServerIds();
        const botMcpIds = cfg.mcpEnabledServers ?? [];
        const enabledMcpDefs = allServers.filter(
            s => globalEnabled.includes(s.id) && botMcpIds.includes(s.id)
        );

        return {
            botId: cfg.id,
            botToken: cfg.botToken,
            allowedUsers: cfg.allowedUsers,
            permissionMode: cfg.permissionMode,
            workspacePath: cfg.defaultWorkspacePath || '',
            model: cfg.model || null,
            providerEnvJson: providerEnvJson || null,
            mcpServersJson: enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null,
            availableProvidersJson: availableProviders.length > 0 ? JSON.stringify(availableProviders) : null,
            platform: cfg.platform,
            feishuAppId: cfg.feishuAppId || null,
            feishuAppSecret: cfg.feishuAppSecret || null,
        };
    }, [providers, apiKeys]);

    // Toggle bot
    const botStatusRef = useRef(botStatus);
    botStatusRef.current = botStatus;

    const toggleBot = useCallback(async () => {
        if (!isTauriEnvironment() || !botConfigRef.current) return;

        setToggling(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            // Read from refs to get latest state (avoids stale closure)
            const isRunning = botStatusRef.current?.status === 'online' || botStatusRef.current?.status === 'connecting';

            if (isRunning) {
                await invoke('cmd_stop_im_bot', { botId });
                if (isMountedRef.current) {
                    toastRef.current.success('Bot 已停止');
                    setBotStatus(null);
                    await saveBotField({ enabled: false });
                }
            } else {
                const cfg = botConfigRef.current;
                const hasCredentials = cfg.platform === 'feishu'
                    ? (cfg.feishuAppId && cfg.feishuAppSecret)
                    : cfg.botToken;
                if (!hasCredentials) {
                    toastRef.current.error(cfg.platform === 'feishu' ? '请先配置应用凭证' : '请先配置 Bot Token');
                    setToggling(false);
                    return;
                }
                const params = await buildStartParams(botConfigRef.current);
                await invoke('cmd_start_im_bot', params);
                if (isMountedRef.current) {
                    toastRef.current.success('Bot 已启动');
                    await saveBotField({ enabled: true });
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) setToggling(false);
        }
    }, [botId, buildStartParams, saveBotField]);

    // Delete bot (called after ConfirmDialog confirmation)
    const executeDelete = useCallback(async () => {
        setDeleting(true);
        try {
            // Stop if running
            if (isTauriEnvironment()) {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('cmd_stop_im_bot', { botId });
                } catch {
                    // May not be running
                }
            }

            // Remove from config — onBack (goToList) handles refreshConfig + view switch
            await removeImBotConfig(botId);
            toastRef.current.success('Bot 已删除');
            onBack();
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`删除失败: ${err}`);
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }
    }, [botId, onBack]);

    // Computed values
    const availableMcpServers = useMemo(
        () => mcpServers.filter(s => globalMcpEnabled.includes(s.id)),
        [mcpServers, globalMcpEnabled],
    );

    const providerOptions = useMemo(() => {
        const options = [{ value: '', label: '默认 (Anthropic 订阅)' }];
        for (const p of providers) {
            if (p.type === 'subscription') continue;
            if (p.type === 'api' && apiKeys[p.id]) {
                options.push({ value: p.id, label: p.name });
            }
        }
        return options;
    }, [providers, apiKeys]);

    const selectedProvider = useMemo(
        () => providers.find(p => p.id === (botConfig?.providerId || 'anthropic-sub')),
        [providers, botConfig?.providerId],
    );

    const modelOptions = useMemo(() => {
        if (!selectedProvider) return [];
        return getProviderModels(selectedProvider).map(m => ({
            value: m.model,
            label: m.modelName,
        }));
    }, [selectedProvider]);

    // Default to provider's primaryModel (or first model) when not explicitly set
    const effectiveModel = useMemo(() => {
        if (botConfig?.model) return botConfig.model;
        if (selectedProvider?.primaryModel) return selectedProvider.primaryModel;
        if (modelOptions.length > 0) return modelOptions[0].value;
        return '';
    }, [botConfig?.model, selectedProvider?.primaryModel, modelOptions]);

    // Stable refs for workspace handler
    const buildStartParamsRef = useRef(buildStartParams);
    buildStartParamsRef.current = buildStartParams;

    const handleWorkspaceChange = useCallback(async (path: string) => {
        if (!path) return;
        await saveBotField({ defaultWorkspacePath: path });

        const status = botStatusRef.current;
        if ((status?.status === 'online' || status?.status === 'connecting') && isTauriEnvironment()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                // Read latest config from disk since we just updated it
                const latest = await loadAppConfig();
                const cfg = (latest.imBotConfigs ?? []).find(c => c.id === botId);
                if (cfg) {
                    const params = await buildStartParamsRef.current(cfg);
                    await invoke('cmd_start_im_bot', params);
                    toastRef.current.success('已切换工作区，Bot 已重启');
                }
            } catch (err) {
                toastRef.current.error(`重启失败: ${err}`);
            }
        }
    }, [botId, saveBotField]);

    if (!botConfig) {
        return (
            <div className="text-center py-12">
                <p className="text-sm text-[var(--ink-muted)]">Bot 配置未找到</p>
                <button onClick={onBack} className="mt-4 text-sm text-[var(--button-primary-bg)] hover:underline">
                    返回列表
                </button>
            </div>
        );
    }

    const isRunning = botStatus?.status === 'online' || botStatus?.status === 'connecting';

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onBack}
                        className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{botUsername ? (botConfig.platform === 'telegram' ? `@${botUsername}` : botUsername) : botConfig.name}</h2>
                </div>
                <button
                    onClick={toggleBot}
                    disabled={toggling || (!(botConfig.platform === 'feishu' ? (botConfig.feishuAppId && botConfig.feishuAppSecret) : botConfig.botToken) && !isRunning)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        isRunning
                            ? 'bg-[var(--error-bg)] text-[var(--error)] hover:brightness-95'
                            : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                    } disabled:opacity-50`}
                >
                    {toggling ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isRunning ? (
                        <PowerOff className="h-4 w-4" />
                    ) : (
                        <Power className="h-4 w-4" />
                    )}
                    {isRunning ? '停止 Bot' : '启动 Bot'}
                </button>
            </div>

            {/* Bot Status */}
            <BotStatusPanel status={botStatus} />

            {/* Platform credentials */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setCredentialsExpanded(!isCredentialsExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">
                            {botConfig.platform === 'feishu' ? '飞书应用凭证' : 'Telegram Bot'}
                        </h3>
                        {!isCredentialsExpanded && hasCredentials && (
                            <span className="text-xs text-[var(--success)]">
                                {botUsername ? `已验证: ${botUsername}` : '已配置'}
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isCredentialsExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isCredentialsExpanded && (
                    <div className="px-5 pb-5">
                        {botConfig.platform === 'feishu' ? (
                            <FeishuCredentialInput
                                appId={botConfig.feishuAppId ?? ''}
                                appSecret={botConfig.feishuAppSecret ?? ''}
                                onAppIdChange={(appId) => {
                                    const others = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
                                    if (others.some(b => b.feishuAppId === appId)) {
                                        toastRef.current.error('该飞书应用凭证已被其他 Bot 使用');
                                        return;
                                    }
                                    saveBotField({ feishuAppId: appId });
                                }}
                                onAppSecretChange={(appSecret) => saveBotField({ feishuAppSecret: appSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : (
                            <BotTokenInput
                                value={botConfig.botToken}
                                onChange={(token) => {
                                    const others = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
                                    if (others.some(b => b.botToken === token)) {
                                        toastRef.current.error('该 Bot Token 已被其他 Bot 使用');
                                        return;
                                    }
                                    saveBotField({ botToken: token });
                                }}
                                verifyStatus={verifyStatus}
                                botUsername={botUsername}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* User binding */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setBindingExpanded(!isBindingExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">用户绑定</h3>
                        {!isBindingExpanded && hasUsers && (
                            <span className="text-xs text-[var(--ink-muted)]">
                                {botConfig.allowedUsers.length} 个用户
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isBindingExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isBindingExpanded && (
                    <div className="space-y-5 px-5 pb-5">
                        {isRunning && botConfig.platform === 'feishu' && botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={botConfig.allowedUsers.length > 0}
                            />
                        )}
                        {isRunning && botConfig.platform === 'telegram' && botStatus?.bindUrl && (
                            <BindQrPanel
                                bindUrl={botStatus.bindUrl}
                                hasWhitelistUsers={botConfig.allowedUsers.length > 0}
                            />
                        )}
                        <WhitelistManager
                            users={botConfig.allowedUsers}
                            onChange={(users) => saveBotField({ allowedUsers: users })}
                            platform={botConfig.platform}
                        />
                    </div>
                )}
            </div>

            {/* Default Workspace */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <div className="flex items-center justify-between">
                    <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">Bot 默认工作区</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            新对话默认关联的工作区，可通过 <code className="rounded bg-[var(--paper-contrast)] px-1 py-0.5 text-[10px]">/workspace</code> 命令切换
                        </p>
                    </div>
                    <CustomSelect
                        value={botConfig.defaultWorkspacePath ?? ''}
                        options={projects.map(p => ({
                            value: p.path,
                            label: shortenPathForDisplay(p.path),
                            icon: <FolderOpen className="h-3.5 w-3.5" />,
                        }))}
                        onChange={handleWorkspaceChange}
                        placeholder="选择工作区"
                        triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                        className="w-[240px]"
                        footerAction={{
                            label: '选择文件夹...',
                            icon: <Plus className="h-3.5 w-3.5" />,
                            onClick: async () => {
                                const { open } = await import('@tauri-apps/plugin-dialog');
                                const selected = await open({ directory: true, multiple: false, title: '选择 Bot 工作区' });
                                if (selected && typeof selected === 'string') {
                                    if (!projects.find(p => p.path === selected)) {
                                        await addProject(selected);
                                    }
                                    handleWorkspaceChange(selected);
                                }
                            },
                        }}
                    />
                </div>
            </div>

            {/* Permission mode */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">权限模式</h3>
                <PermissionModeSelect
                    value={botConfig.permissionMode}
                    onChange={(mode) => saveBotField({ permissionMode: mode })}
                />
            </div>

            {/* AI Configuration */}
            <AiConfigCard
                providerId={botConfig.providerId ?? ''}
                model={effectiveModel}
                providerOptions={providerOptions}
                modelOptions={modelOptions}
                onProviderChange={(providerId) => {
                    const provider = providers.find(p => p.id === providerId);
                    const newModel = provider ? provider.primaryModel : undefined;
                    saveBotField({ providerId: providerId || undefined, model: newModel });
                }}
                onModelChange={(model) => saveBotField({ model: model || undefined })}
            />

            {/* MCP Tools */}
            <McpToolsCard
                availableMcpServers={availableMcpServers}
                enabledServerIds={botConfig.mcpEnabledServers ?? []}
                onToggle={(serverId) => {
                    const current = botConfig.mcpEnabledServers ?? [];
                    const updated = current.includes(serverId)
                        ? current.filter(id => id !== serverId)
                        : [...current, serverId];
                    saveBotField({ mcpEnabledServers: updated.length > 0 ? updated : undefined });
                }}
            />

            {/* Danger zone */}
            <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error-bg)]/50 p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--error)]">危险操作</h3>
                <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:brightness-95"
                >
                    <Trash2 className="h-4 w-4" />
                    删除 Bot
                </button>
            </div>

            {/* Delete confirmation dialog */}
            {showDeleteConfirm && (
                <ConfirmDialog
                    title="删除 Bot"
                    message="确定要删除此 Bot 吗？此操作不可撤销。"
                    confirmText="删除"
                    cancelText="取消"
                    confirmVariant="danger"
                    loading={deleting}
                    onConfirm={executeDelete}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}
        </div>
    );
}
