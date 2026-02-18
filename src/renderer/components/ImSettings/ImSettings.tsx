import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Eye, EyeOff, FolderOpen, Loader2, Plus, Power, PowerOff, QrCode, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import { isTauriEnvironment } from '@/utils/browserMock';
import { PERMISSION_MODES, type McpServerDefinition, getProviderModels } from '@/config/types';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import CustomSelect from '@/components/CustomSelect';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import type { ImBotConfig, ImBotStatus } from '../../../shared/types/im';
import { DEFAULT_IM_BOT_CONFIG } from '../../../shared/types/im';

// ─── Bot Token Input ───────────────────────────────────────────────

function BotTokenInput({
    value,
    onChange,
    verifyStatus,
    botUsername,
}: {
    value: string;
    onChange: (token: string) => void;
    verifyStatus: 'idle' | 'verifying' | 'valid' | 'invalid';
    botUsername?: string;
}) {
    const [visible, setVisible] = useState(false);
    const [localValue, setLocalValue] = useState(value);

    // Sync from parent when value prop changes
    useEffect(() => {
        setLocalValue(value);
    }, [value]);

    const handleBlur = useCallback(() => {
        const trimmed = localValue.trim();
        if (trimmed !== value) {
            onChange(trimmed);
        }
    }, [localValue, value, onChange]);

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--ink)]">Bot Token</label>
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <input
                        type={visible ? 'text' : 'password'}
                        value={localValue}
                        onChange={(e) => setLocalValue(e.target.value)}
                        onBlur={handleBlur}
                        onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
                        placeholder="从 @BotFather 获取 Bot Token"
                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 pr-10 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none"
                    />
                    <button
                        type="button"
                        onClick={() => setVisible(!visible)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--ink-muted)] hover:text-[var(--ink)]"
                    >
                        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                </div>
                {/* Verify status indicator */}
                {verifyStatus === 'verifying' && (
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]" />
                )}
                {verifyStatus === 'valid' && (
                    <Check className="h-4 w-4 text-green-500" />
                )}
                {verifyStatus === 'invalid' && (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                )}
            </div>
            {verifyStatus === 'valid' && botUsername && (
                <p className="text-xs text-green-600">
                    已验证: @{botUsername}
                </p>
            )}
            {verifyStatus === 'invalid' && (
                <p className="text-xs text-red-500">
                    Token 无效，请检查后重试
                </p>
            )}
            <p className="text-xs text-[var(--ink-muted)]">
                通过 Telegram @BotFather 创建 Bot 并获取 Token
            </p>
        </div>
    );
}

// ─── Whitelist Manager ─────────────────────────────────────────────

function WhitelistManager({
    users,
    onChange,
}: {
    users: string[];
    onChange: (users: string[]) => void;
}) {
    const [newUser, setNewUser] = useState('');

    const handleAdd = useCallback(() => {
        const trimmed = newUser.trim();
        if (!trimmed) return;
        if (users.includes(trimmed)) {
            setNewUser('');
            return;
        }
        onChange([...users, trimmed]);
        setNewUser('');
    }, [newUser, users, onChange]);

    const handleRemove = useCallback((user: string) => {
        onChange(users.filter(u => u !== user));
    }, [users, onChange]);

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--ink)]">用户白名单</label>
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={newUser}
                    onChange={(e) => setNewUser(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    placeholder="Telegram 用户名或 User ID"
                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none"
                />
                <button
                    onClick={handleAdd}
                    disabled={!newUser.trim()}
                    className="rounded-lg bg-[var(--button-primary-bg)] p-2 text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                >
                    <Plus className="h-4 w-4" />
                </button>
            </div>

            {users.length > 0 ? (
                <div className="flex flex-wrap gap-2 pt-1">
                    {users.map((user) => (
                        <span
                            key={user}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--paper-contrast)] px-2.5 py-1 text-xs text-[var(--ink)]"
                        >
                            {user}
                            <button
                                onClick={() => handleRemove(user)}
                                className="rounded-full p-0.5 text-[var(--ink-muted)] hover:text-red-500"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <p className="text-xs text-[var(--ink-muted)]">
                    未添加白名单用户。启动 Bot 后可通过二维码快速绑定，或手动添加用户名 / User ID。
                </p>
            )}
        </div>
    );
}

// ─── Permission Mode Select ────────────────────────────────────────

function PermissionModeSelect({
    value,
    onChange,
}: {
    value: string;
    onChange: (mode: string) => void;
}) {
    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--ink)]">权限模式</label>
            <div className="space-y-2">
                {PERMISSION_MODES.map((mode) => (
                    <label
                        key={mode.value}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                            value === mode.value
                                ? 'border-[var(--button-primary-bg)] bg-[var(--paper-contrast)]'
                                : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                        }`}
                    >
                        <input
                            type="radio"
                            name="im-permission-mode"
                            value={mode.value}
                            checked={value === mode.value}
                            onChange={() => onChange(mode.value)}
                            className="mt-0.5"
                        />
                        <div>
                            <div className="text-sm font-medium text-[var(--ink)]">
                                {mode.icon} {mode.label}
                            </div>
                            <p className="text-xs text-[var(--ink-muted)]">{mode.description}</p>
                        </div>
                    </label>
                ))}
            </div>
            <p className="text-xs text-[var(--ink-muted)]">
                IM Bot 通过远程消息触发操作，建议使用「规划」模式以确保安全。
            </p>
        </div>
    );
}

// ─── Bot Status Panel ──────────────────────────────────────────────

function BotStatusPanel({ status }: { status: ImBotStatus | null }) {
    if (!status) return null;

    const statusColor = {
        online: 'text-green-500',
        connecting: 'text-yellow-500',
        error: 'text-red-500',
        stopped: 'text-[var(--ink-muted)]',
    }[status.status];

    const statusLabel = {
        online: '运行中',
        connecting: '连接中',
        error: '错误',
        stopped: '已停止',
    }[status.status];

    const formatUptime = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    return (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
            <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-medium text-[var(--ink)]">Bot 状态</h4>
                <span className={`text-xs font-medium ${statusColor}`}>
                    {statusLabel}
                </span>
            </div>

            {status.botUsername && (
                <div className="mb-2 text-xs text-[var(--ink-muted)]">
                    @{status.botUsername}
                </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                    <span className="text-[var(--ink-muted)]">运行时长</span>
                    <span className="ml-2 text-[var(--ink)]">{formatUptime(status.uptimeSeconds)}</span>
                </div>
                <div>
                    <span className="text-[var(--ink-muted)]">活跃会话</span>
                    <span className="ml-2 text-[var(--ink)]">{status.activeSessions.length}</span>
                </div>
                <div>
                    <span className="text-[var(--ink-muted)]">重启次数</span>
                    <span className="ml-2 text-[var(--ink)]">{status.restartCount}</span>
                </div>
                <div>
                    <span className="text-[var(--ink-muted)]">缓冲消息</span>
                    <span className="ml-2 text-[var(--ink)]">{status.bufferedMessages}</span>
                </div>
            </div>

            {status.errorMessage && (
                <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {status.errorMessage}
                </div>
            )}

            {status.activeSessions.length > 0 && (
                <div className="mt-3 border-t border-[var(--line)] pt-3">
                    <h5 className="mb-2 text-xs font-medium text-[var(--ink-muted)]">活跃会话</h5>
                    <div className="space-y-1.5">
                        {status.activeSessions.map((session) => (
                            <div key={session.sessionKey} className="flex items-center justify-between text-xs">
                                <span className="text-[var(--ink)]">
                                    {session.sourceType === 'private' ? '📱' : '👥'} {session.sessionKey.split(':').pop()}
                                </span>
                                <span className="text-[var(--ink-muted)]">
                                    {session.messageCount} 条消息
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── QR Code Binding Panel ────────────────────────────────────────

function BindQrPanel({
    bindUrl,
    hasWhitelistUsers,
}: {
    bindUrl: string;
    hasWhitelistUsers: boolean;
}) {
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        let cancelled = false;
        QRCode.toDataURL(bindUrl, {
            width: 200,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        }).then((url) => {
            if (!cancelled) setQrDataUrl(url);
        }).catch(() => {
            // QR generation failed — fallback to link only
        });
        return () => { cancelled = true; };
    }, [bindUrl]);

    useEffect(() => {
        return () => { if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current); };
    }, []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(bindUrl);
            setCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, [bindUrl]);

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <div className="flex items-center gap-2 mb-3">
                <QrCode className="h-4 w-4 text-[var(--ink-muted)]" />
                <h3 className="text-sm font-semibold text-[var(--ink)]">快速绑定</h3>
                {!hasWhitelistUsers && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        推荐
                    </span>
                )}
            </div>

            <p className="mb-4 text-xs text-[var(--ink-muted)]">
                用 Telegram 扫描二维码，即可自动绑定你的账号到白名单。无需手动查找 User ID。
            </p>

            <div className="flex items-start gap-5">
                {/* QR Code */}
                <div className="flex-shrink-0 rounded-lg border border-[var(--line)] bg-white p-2">
                    {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Telegram bind QR" className="h-[160px] w-[160px]" />
                    ) : (
                        <div className="flex h-[160px] w-[160px] items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                        </div>
                    )}
                </div>

                {/* Instructions */}
                <div className="flex-1 space-y-3">
                    <div className="space-y-2 text-xs text-[var(--ink-muted)]">
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">1</span>
                            <span>打开 Telegram，扫描左侧二维码</span>
                        </div>
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">2</span>
                            <span>点击「Start」发送绑定指令</span>
                        </div>
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">3</span>
                            <span>绑定成功后即可开始对话</span>
                        </div>
                    </div>

                    {/* Deep link for desktop Telegram users */}
                    <div className="pt-1">
                        <p className="mb-1 text-[10px] text-[var(--ink-muted)]">或在桌面版 Telegram 中直接打开：</p>
                        <div className="flex items-center gap-1.5 overflow-hidden">
                            <code className="min-w-0 flex-1 truncate rounded bg-[var(--paper-contrast)] px-2 py-1 text-[11px] text-[var(--ink)]">
                                {bindUrl}
                            </code>
                            <button
                                onClick={handleCopy}
                                className="flex-shrink-0 rounded p-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                                title="复制链接"
                            >
                                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Main ImSettings Component ─────────────────────────────────────

export default function ImSettings() {
    const { config, updateConfig, projects, addProject, providers, apiKeys } = useConfig();
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Local config state (migration-compatible: old configs lack id/name/platform)
    const [botConfig, setBotConfig] = useState<ImBotConfig>(() => {
        const saved = config.imBotConfig;
        return {
            ...DEFAULT_IM_BOT_CONFIG,
            ...saved,
            id: saved?.id || crypto.randomUUID(),
            name: saved?.name || 'Telegram Bot',
            platform: saved?.platform || 'telegram',
        };
    });

    // MCP state
    const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
    const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);

    // Bot runtime status
    const [botStatus, setBotStatus] = useState<ImBotStatus | null>(null);
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [toggling, setToggling] = useState(false);

    // Polling interval ref
    const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
    const isMountedRef = useRef(true);

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Sync from parent config when it changes
    useEffect(() => {
        if (config.imBotConfig) {
            setBotConfig(prev => ({ ...prev, ...config.imBotConfig }));
        }
    }, [config.imBotConfig]);

    // Save config to disk
    const saveConfig = useCallback(async (newConfig: ImBotConfig) => {
        setBotConfig(newConfig);
        await updateConfig({ imBotConfig: newConfig });
    }, [updateConfig]);

    // Verify bot token via Tauri command
    const verifyToken = useCallback(async (token: string) => {
        if (!token || !isTauriEnvironment()) return;

        setVerifyStatus('verifying');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const status = await invoke<ImBotStatus>('cmd_im_bot_status');
            if (!isMountedRef.current) return;
            // If bot is already running with a verified username, the token is valid
            if (status.botUsername && (status.status === 'online' || status.status === 'connecting')) {
                setVerifyStatus('valid');
                setBotUsername(status.botUsername);
            } else {
                // Bot not running — token will be verified when the user starts the bot
                setVerifyStatus('idle');
            }
        } catch {
            if (isMountedRef.current) setVerifyStatus('idle');
        }
    }, []);

    // Handle token change
    const handleTokenChange = useCallback((token: string) => {
        const newConfig = { ...botConfig, botToken: token };
        saveConfig(newConfig);
        if (token) {
            verifyToken(token);
        } else {
            setVerifyStatus('idle');
            setBotUsername(undefined);
        }
    }, [botConfig, saveConfig, verifyToken]);

    // Handle whitelist change
    const handleWhitelistChange = useCallback((users: string[]) => {
        saveConfig({ ...botConfig, allowedUsers: users });
    }, [botConfig, saveConfig]);

    // Handle permission mode change
    const handlePermissionChange = useCallback((mode: string) => {
        saveConfig({ ...botConfig, permissionMode: mode });
    }, [botConfig, saveConfig]);

    // Handle provider change
    const handleProviderChange = useCallback((providerId: string) => {
        const provider = providers.find(p => p.id === providerId);
        const newModel = provider ? provider.primaryModel : undefined;
        saveConfig({
            ...botConfig,
            providerId: providerId || undefined,
            model: newModel,
        });
    }, [botConfig, saveConfig, providers]);

    // Handle model change
    const handleModelChange = useCallback((model: string) => {
        saveConfig({ ...botConfig, model: model || undefined });
    }, [botConfig, saveConfig]);

    // Handle MCP toggle
    const handleMcpToggle = useCallback((serverId: string) => {
        const current = botConfig.mcpEnabledServers ?? [];
        const updated = current.includes(serverId)
            ? current.filter(id => id !== serverId)
            : [...current, serverId];
        saveConfig({ ...botConfig, mcpEnabledServers: updated.length > 0 ? updated : undefined });
    }, [botConfig, saveConfig]);

    // Available global MCP servers (only show globally enabled ones)
    const availableMcpServers = useMemo(
        () => mcpServers.filter(s => globalMcpEnabled.includes(s.id)),
        [mcpServers, globalMcpEnabled],
    );

    // Provider options for select: subscription + API providers with keys
    const providerOptions = useMemo(() => {
        const options = [
            { value: '', label: '默认 (Anthropic 订阅)' },
        ];
        for (const p of providers) {
            if (p.type === 'subscription') {
                // Subscription is already the default option
                continue;
            }
            if (p.type === 'api' && apiKeys[p.id]) {
                options.push({ value: p.id, label: p.name });
            }
        }
        return options;
    }, [providers, apiKeys]);

    // Model options for selected provider
    const modelOptions = useMemo(() => {
        const selectedProvider = providers.find(p => p.id === (botConfig.providerId || 'anthropic-sub'));
        if (!selectedProvider) return [];
        return getProviderModels(selectedProvider).map(m => ({
            value: m.model,
            label: m.modelName,
        }));
    }, [providers, botConfig.providerId]);

    // Build params for cmd_start_im_bot (shared between toggleBot & handleWorkspaceChange)
    const buildStartBotParams = useCallback(async (cfg: ImBotConfig) => {
        // Resolve provider env (API Key not stored in bot config — read at runtime)
        const selectedProvider = providers.find(p => p.id === cfg.providerId);
        let providerEnvJson: string | undefined;
        if (selectedProvider && selectedProvider.type !== 'subscription') {
            providerEnvJson = JSON.stringify({
                baseUrl: selectedProvider.config.baseUrl,
                apiKey: apiKeys[selectedProvider.id],
                authType: selectedProvider.authType,
            });
        }

        // Build available providers list for /provider command
        // Include subscription + all API providers with configured API keys
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

        // Resolve MCP server definitions (filter bot-enabled from global list)
        const allServers = await getAllMcpServers();
        const globalEnabled = await getEnabledMcpServerIds();
        const botMcpIds = cfg.mcpEnabledServers ?? [];
        const enabledMcpDefs = allServers.filter(
            s => globalEnabled.includes(s.id) && botMcpIds.includes(s.id)
        );

        return {
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

    // Poll bot status
    const fetchStatus = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const status = await invoke<ImBotStatus>('cmd_im_bot_status');
            if (isMountedRef.current) {
                setBotStatus(status);
                if (status.botUsername) {
                    setBotUsername(status.botUsername);
                    setVerifyStatus('valid');
                }
            }
        } catch {
            // Bot not running or command not available
            if (isMountedRef.current) {
                setBotStatus(null);
            }
        }
    }, []);

    // Start polling when component mounts
    useEffect(() => {
        fetchStatus();
        pollRef.current = setInterval(fetchStatus, 5000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [fetchStatus]);

    // Load global MCP servers on mount
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
                console.error('[ImSettings] Failed to load MCP servers:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Stable refs for callbacks (avoid stale closures)
    const botConfigRef = useRef(botConfig);
    botConfigRef.current = botConfig;
    const saveConfigRef = useRef(saveConfig);
    saveConfigRef.current = saveConfig;
    const botStatusRef = useRef(botStatus);
    botStatusRef.current = botStatus;
    const buildStartBotParamsRef = useRef(buildStartBotParams);
    buildStartBotParamsRef.current = buildStartBotParams;

    // Auto-set default workspace to bundled mino on first load.
    // IMPORTANT: Must check config.imBotConfig (source of truth from disk), NOT
    // botConfigRef.current which lags behind by one render and would overwrite
    // persisted token/users/enabled with DEFAULT_IM_BOT_CONFIG.
    const autoInitDone = useRef(false);
    useEffect(() => {
        if (autoInitDone.current) return;
        if (config.imBotConfig?.defaultWorkspacePath) {
            autoInitDone.current = true;
            return;
        }
        const mino = projects.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
        if (mino) {
            autoInitDone.current = true;
            const baseConfig = config.imBotConfig ?? DEFAULT_IM_BOT_CONFIG;
            saveConfigRef.current({ ...baseConfig, defaultWorkspacePath: mino.path });
        }
    }, [projects, config.imBotConfig]);

    // Handle workspace change — saves config and restarts bot if running
    const handleWorkspaceChange = useCallback(async (path: string) => {
        if (!path) return;
        const newConfig = { ...botConfigRef.current, defaultWorkspacePath: path };
        saveConfigRef.current(newConfig);

        // If bot is running, restart with new workspace
        // cmd_start_im_bot gracefully stops existing instance before starting
        const status = botStatusRef.current;
        if ((status?.status === 'online' || status?.status === 'connecting') && isTauriEnvironment()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const params = await buildStartBotParamsRef.current(newConfig);
                await invoke('cmd_start_im_bot', params);
                toastRef.current.success('已切换工作区，Bot 已重启');
            } catch (err) {
                toastRef.current.error(`重启失败: ${err}`);
            }
        }
    }, []);

    // Listen for QR code bind events from Rust

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;
                const currentUsers = botConfigRef.current.allowedUsers;

                // Add user if not already in whitelist
                if (!currentUsers.includes(userId) && (!username || !currentUsers.includes(username))) {
                    const newUsers = [...currentUsers, userId];
                    saveConfigRef.current({ ...botConfigRef.current, allowedUsers: newUsers });
                    toastRef.current.success(`用户 ${displayName} 已通过二维码绑定`);
                }
            }).then((fn) => {
                if (cancelled) fn(); // Immediately clean up if component already unmounted
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    // Toggle bot on/off
    const toggleBot = useCallback(async () => {
        if (!isTauriEnvironment()) {
            toastRef.current.error('IM Bot 仅在桌面端可用');
            return;
        }

        setToggling(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');

            if (botStatus?.status === 'online' || botStatus?.status === 'connecting') {
                // Stop bot
                await invoke('cmd_stop_im_bot');
                if (isMountedRef.current) {
                    toastRef.current.success('IM Bot 已停止');
                    setBotStatus(null);
                    await saveConfig({ ...botConfig, enabled: false });
                }
            } else {
                // Validate before starting
                if (!botConfig.botToken) {
                    toastRef.current.error('请先配置 Bot Token');
                    setToggling(false);
                    return;
                }
                // No whitelist check — users can bind via QR code after starting

                // Start bot — params must match Rust fn signature (flat camelCase)
                const params = await buildStartBotParams(botConfig);
                await invoke('cmd_start_im_bot', params);
                if (isMountedRef.current) {
                    toastRef.current.success('IM Bot 已启动');
                    await saveConfig({ ...botConfig, enabled: true });
                    // Fetch status immediately
                    await fetchStatus();
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setToggling(false);
            }
        }
    }, [botConfig, botStatus, fetchStatus, saveConfig, buildStartBotParams]);

    const isRunning = botStatus?.status === 'online' || botStatus?.status === 'connecting';

    return (
        <div className="space-y-8">
            {/* Header with toggle */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">IM 集成</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                        通过 Telegram Bot 远程使用 AI Agent 能力
                    </p>
                </div>
                <button
                    onClick={toggleBot}
                    disabled={toggling || (!botConfig.botToken && !isRunning)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        isRunning
                            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
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

            {/* Bot Status (shown when running) */}
            <BotStatusPanel status={botStatus} />

            {/* QR Code Binding (shown when bot is running and has bind URL) */}
            {isRunning && botStatus?.bindUrl && (
                <BindQrPanel
                    bindUrl={botStatus.bindUrl}
                    hasWhitelistUsers={botConfig.allowedUsers.length > 0}
                />
            )}

            {/* Configuration sections */}
            <div className="space-y-6">
                {/* Telegram Bot section */}
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">Telegram Bot</h3>
                    <div className="space-y-5">
                        <BotTokenInput
                            value={botConfig.botToken}
                            onChange={handleTokenChange}
                            verifyStatus={verifyStatus}
                            botUsername={botUsername}
                        />
                        <WhitelistManager
                            users={botConfig.allowedUsers}
                            onChange={handleWhitelistChange}
                        />
                    </div>
                </div>

                {/* Permission mode section */}
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">安全设置</h3>
                    <PermissionModeSelect
                        value={botConfig.permissionMode}
                        onChange={handlePermissionChange}
                    />
                </div>

                {/* AI Configuration */}
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">AI 配置</h3>
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex-1 pr-4">
                                <p className="text-sm font-medium text-[var(--ink)]">供应商</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    Bot 使用的 AI 供应商（独立于客户端设置）
                                </p>
                            </div>
                            <CustomSelect
                                value={botConfig.providerId ?? ''}
                                options={providerOptions}
                                onChange={handleProviderChange}
                                placeholder="选择供应商"
                                className="w-[240px]"
                            />
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex-1 pr-4">
                                <p className="text-sm font-medium text-[var(--ink)]">模型</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    可在 Telegram 中使用 <code className="rounded bg-[var(--paper-contrast)] px-1 py-0.5 text-[10px]">/model</code> 命令切换
                                </p>
                            </div>
                            <CustomSelect
                                value={botConfig.model ?? ''}
                                options={modelOptions}
                                onChange={handleModelChange}
                                placeholder="选择模型"
                                className="w-[240px]"
                            />
                        </div>
                    </div>
                </div>

                {/* MCP Tools */}
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">MCP 工具</h3>
                    <p className="mb-3 text-xs text-[var(--ink-muted)]">
                        Bot 可使用的 MCP 工具（独立于客户端设置，仅显示全局已启用的 MCP 服务）
                    </p>
                    {availableMcpServers.length > 0 ? (
                        <div className="space-y-2">
                            {availableMcpServers.map((server) => {
                                const checked = (botConfig.mcpEnabledServers ?? []).includes(server.id);
                                return (
                                    <label
                                        key={server.id}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] p-3 transition-colors hover:border-[var(--ink-muted)]"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => handleMcpToggle(server.id)}
                                            className="h-4 w-4 rounded border-[var(--line)]"
                                        />
                                        <div>
                                            <p className="text-sm font-medium text-[var(--ink)]">{server.name}</p>
                                            {server.description && (
                                                <p className="text-xs text-[var(--ink-muted)]">{server.description}</p>
                                            )}
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-[var(--ink-muted)]">
                            暂无全局已启用的 MCP 服务。请先在「设置 → MCP 工具」中启用。
                        </p>
                    )}
                </div>

                {/* Default Workspace */}
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">默认工作区</h3>
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
            </div>
        </div>
    );
}
