import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { getAllMcpServers, getEnabledMcpServerIds, updateImBotConfig } from '@/config/configService';
import type { ImBotConfig, ImBotStatus } from '../../../shared/types/im';
import telegramIcon from './assets/telegram.png';

export default function ImBotList({
    configs,
    onAdd,
    onSelect,
}: {
    configs: ImBotConfig[];
    onAdd: () => void;
    onSelect: (botId: string) => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { providers, apiKeys } = useConfig();
    const isMountedRef = useRef(true);

    // Bot statuses: botId → status
    const [statuses, setStatuses] = useState<Record<string, ImBotStatus>>({});
    const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Poll all bot statuses
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchAllStatuses = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<Record<string, ImBotStatus>>('cmd_im_all_bots_status');
                if (isMountedRef.current) {
                    setStatuses(result);
                }
            } catch {
                // Command not available
            }
        };

        fetchAllStatuses();
        const interval = setInterval(fetchAllStatuses, 5000);
        return () => clearInterval(interval);
    }, []);

    // Build start params for a bot config
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
        };
    }, [providers, apiKeys]);

    // Toggle bot start/stop
    const toggleBot = useCallback(async (cfg: ImBotConfig) => {
        if (!isTauriEnvironment()) return;

        const botId = cfg.id;
        setTogglingIds(prev => new Set(prev).add(botId));

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const status = statuses[botId];
            const isRunning = status?.status === 'online' || status?.status === 'connecting';

            if (isRunning) {
                await invoke('cmd_stop_im_bot', { botId });
                if (isMountedRef.current) {
                    // Optimistic status update so button reflects change immediately
                    setStatuses(prev => {
                        const next = { ...prev };
                        if (next[botId]) {
                            next[botId] = { ...next[botId], status: 'stopped' as const };
                        }
                        return next;
                    });
                    toastRef.current.success(`${cfg.name} 已停止`);
                    await updateImBotConfig(botId, { enabled: false });
                }
            } else {
                if (!cfg.botToken) {
                    toastRef.current.error('请先配置 Bot Token');
                    return;
                }
                const params = await buildStartParams(cfg);
                const newStatus = await invoke<ImBotStatus>('cmd_start_im_bot', params);
                if (isMountedRef.current) {
                    setStatuses(prev => ({ ...prev, [botId]: newStatus }));
                    toastRef.current.success(`${cfg.name} 已启动`);
                    await updateImBotConfig(botId, { enabled: true });
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setTogglingIds(prev => {
                    const next = new Set(prev);
                    next.delete(botId);
                    return next;
                });
            }
        }
    }, [statuses, buildStartParams]);

    // Platform icon
    const platformIcon = (platform: string) => {
        if (platform === 'telegram') return <img src={telegramIcon} alt="Telegram" className="h-5 w-5" />;
        if (platform === 'feishu') return <span className="text-base">🐦</span>;
        return <span className="text-base">💬</span>;
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">聊天机器人</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                        通过聊天机器人Bot远程使用 AI Agent
                    </p>
                </div>
                {configs.length > 0 && (
                    <button
                        onClick={onAdd}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        添加 Bot
                    </button>
                )}
            </div>

            {/* Bot cards */}
            {configs.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-[var(--line)] px-8 py-16">
                    <div className="text-4xl">🤖</div>
                    <p className="mt-4 text-base font-medium text-[var(--ink)]">
                        还没有聊天机器人
                    </p>
                    <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                        添加一个 Bot，通过 Telegram 等聊天机器人远程使用 AI Agent
                    </p>
                    <button
                        onClick={onAdd}
                        className="mt-6 flex items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-6 py-3 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-5 w-5" />
                        添加 Bot
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map((cfg) => {
                        const status = statuses[cfg.id];
                        // Use cfg.enabled as hint before first poll to avoid button color flash
                        const isRunning = status
                            ? (status.status === 'online' || status.status === 'connecting')
                            : cfg.enabled;
                        const isToggling = togglingIds.has(cfg.id);

                        const displayName = status?.botUsername ? `@${status.botUsername}` : cfg.name;

                        return (
                            <div
                                key={cfg.id}
                                onClick={() => onSelect(cfg.id)}
                                className="cursor-pointer rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-colors hover:border-[var(--line-strong)]"
                            >
                                {/* Top row: icon + name + status */}
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="flex-shrink-0">{platformIcon(cfg.platform)}</span>
                                        <span className="text-sm font-medium text-[var(--ink)] truncate">
                                            {displayName}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <div className={`h-1.5 w-1.5 rounded-full ${
                                            isRunning ? 'bg-[var(--success)]' : 'bg-[var(--ink-subtle)]'
                                        }`} />
                                        <span className={`text-xs ${
                                            isRunning ? 'text-[var(--success)]' : 'text-[var(--ink-muted)]'
                                        }`}>
                                            {isRunning ? '运行中' : '已停止'}
                                        </span>
                                    </div>
                                </div>

                                {/* Bottom row: workspace + toggle */}
                                <div className="mt-2.5 flex items-center justify-between text-xs text-[var(--ink-muted)]">
                                    <div className="flex items-center gap-1.5 min-w-0 truncate">
                                        {cfg.defaultWorkspacePath && (
                                            <span className="truncate">
                                                {shortenPathForDisplay(cfg.defaultWorkspacePath)}
                                            </span>
                                        )}
                                        {cfg.defaultWorkspacePath && <span>·</span>}
                                        <span className="flex-shrink-0 capitalize">{cfg.platform}</span>
                                    </div>
                                    {/* Capsule toggle button */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleBot(cfg);
                                        }}
                                        disabled={isToggling || (!cfg.botToken && !isRunning)}
                                        className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                                            isRunning
                                                ? 'bg-[var(--error)] text-white hover:bg-[#b91c1c]'
                                                : 'bg-[var(--button-primary-bg)] text-white hover:bg-[var(--button-primary-bg-hover)]'
                                        }`}
                                    >
                                        {isToggling ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : isRunning ? (
                                            '停止'
                                        ) : (
                                            '启动'
                                        )}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
