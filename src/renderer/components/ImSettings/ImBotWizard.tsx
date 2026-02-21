import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, FolderOpen, FolderPlus, Loader2, Plus } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { getAllMcpServers, getEnabledMcpServerIds, addOrUpdateImBotConfig, addProject, loadAppConfig, loadProjects, removeImBotConfig, removeProject, updateImBotConfig } from '@/config/configService';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import CustomSelect from '@/components/CustomSelect';
import BotTokenInput from './components/BotTokenInput';
import FeishuCredentialInput from './components/FeishuCredentialInput';
import BindQrPanel from './components/BindQrPanel';
import BindCodePanel from './components/BindCodePanel';
import WhitelistManager from './components/WhitelistManager';
import type { ImBotConfig, ImBotStatus, ImPlatform } from '../../../shared/types/im';
import { DEFAULT_IM_BOT_CONFIG, DEFAULT_FEISHU_BOT_CONFIG } from '../../../shared/types/im';
import telegramBotAddImg from './assets/telegram_bot_add.png';
import feishuStep1Img from './assets/feishu_step1.png';
import feishuStep2PermImg from './assets/feishu_step2_permissions.png';
import feishuStep2EventImg from './assets/feishu_step2_events.png';
import feishuStep2AddBotImg from './assets/feishu_step2_5_add_bot.png';
import feishuStep2PublishImg from './assets/feishu_setp2_6_publish.png';

const FEISHU_PERMISSIONS_JSON = `{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:document.content:read",
      "event:ip_list",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "sheets:spreadsheet",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}`;

export default function ImBotWizard({
    platform,
    onComplete,
    onCancel,
}: {
    platform: ImPlatform;
    onComplete: (botId: string) => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { config, providers, apiKeys, projects, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    const isFeishu = platform === 'feishu';
    // Telegram: credentials(1) → workspace(2) → binding(3)
    // Feishu:   credentials(1) → permissions(2) → workspace(3) → binding(4)
    const totalSteps = isFeishu ? 4 : 3;
    const workspaceStep = isFeishu ? 3 : 2;
    const bindingStep = isFeishu ? 4 : 3;

    const [step, setStep] = useState(1);
    // Telegram credentials
    const [botToken, setBotToken] = useState('');
    // Feishu credentials
    const [feishuAppId, setFeishuAppId] = useState('');
    const [feishuAppSecret, setFeishuAppSecret] = useState('');

    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [starting, setStarting] = useState(false);
    const [botId] = useState(() => crypto.randomUUID());
    const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
    const [botStatus, setBotStatus] = useState<ImBotStatus | null>(null);
    const [permJsonCopied, setPermJsonCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    // Workspace step state
    const [workspaceChoice, setWorkspaceChoice] = useState<'new' | 'existing'>('new');
    const [selectedExistingPath, setSelectedExistingPath] = useState('');
    const [creatingWorkspace, setCreatingWorkspace] = useState(false);
    // Track workspace created during this wizard session (for cleanup on cancel / dedup on back)
    const createdWorkspacePathRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    // Poll status when in binding step
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;

        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ImBotStatus>('cmd_im_bot_status', { botId });
                if (isMountedRef.current) {
                    setBotStatus(status);
                }
            } catch {
                // Not running
            }
        };

        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    }, [step, bindingStep, botId]);

    // Listen for user-bound events
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current || event.payload.botId !== botId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;

                setAllowedUsers(prev => {
                    if (prev.includes(userId) || (username && prev.includes(username))) return prev;
                    toastRef.current.success(`用户 ${displayName} 已绑定`);
                    return [...prev, userId];
                });
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [step, bindingStep, botId]);

    // Save bot config to disk and sync React state
    const saveBotConfig = useCallback(async (cfg: ImBotConfig) => {
        await addOrUpdateImBotConfig(cfg);
        await refreshConfig();
    }, [refreshConfig]);

    // Check if credentials are filled
    const hasCredentials = isFeishu
        ? feishuAppId.trim() && feishuAppSecret.trim()
        : botToken.trim();

    // Build start params for cmd_start_im_bot (reusable helper)
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
            heartbeatConfigJson: cfg.heartbeat ? JSON.stringify(cfg.heartbeat) : null,
        };
    }, [providers, apiKeys]);

    // Handle "Next" for all steps
    const handleNext = useCallback(async () => {
        // Feishu step 2 -> step 3 (permissions guide -> workspace)
        if (isFeishu && step === 2) {
            setStep(3);
            return;
        }

        // Workspace step -> binding step: create/select workspace, restart bot
        if (step === workspaceStep) {
            setCreatingWorkspace(true);
            try {
                let newWorkspacePath: string;

                if (workspaceChoice === 'new') {
                    // Reuse previously created workspace if user navigated back then forward
                    if (createdWorkspacePathRef.current) {
                        newWorkspacePath = createdWorkspacePathRef.current;
                    } else if (isTauriEnvironment()) {
                        // Create a new dedicated workspace for this bot
                        const wsName = botUsername || (isFeishu ? '飞书Bot' : 'TelegramBot');
                        const { invoke } = await import('@tauri-apps/api/core');
                        const result = await invoke<{ path: string; is_new: boolean }>('cmd_create_bot_workspace', {
                            workspaceName: wsName,
                        });
                        newWorkspacePath = result.path;
                        createdWorkspacePathRef.current = newWorkspacePath;
                        // Register in projects.json
                        await addProject(newWorkspacePath);
                        await refreshConfig();
                    } else {
                        // Browser dev mode fallback
                        const wsName = botUsername || (isFeishu ? '飞书Bot' : 'TelegramBot');
                        newWorkspacePath = `/mock/projects/${wsName}`;
                    }
                } else {
                    // Use selected existing workspace
                    if (!selectedExistingPath) {
                        toastRef.current.error('请选择一个工作区');
                        setCreatingWorkspace(false);
                        return;
                    }
                    newWorkspacePath = selectedExistingPath;
                }

                // Update bot config with the chosen workspace
                await updateImBotConfig(botId, { defaultWorkspacePath: newWorkspacePath });
                await refreshConfig();
                // Restart bot with the correct workspace so binding step uses it
                if (isTauriEnvironment()) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    try {
                        await invoke('cmd_stop_im_bot', { botId });
                    } catch {
                        // Bot might not be running
                    }

                    // Read latest config from disk for restart
                    const latestConfig = await loadAppConfig();
                    const latestBotConfig = (latestConfig.imBotConfigs ?? []).find(c => c.id === botId);
                    if (latestBotConfig) {
                        const params = await buildStartParams(latestBotConfig);
                        const status = await invoke<ImBotStatus>('cmd_start_im_bot', params);
                        if (isMountedRef.current) {
                            setBotStatus(status);
                        }
                    }
                }

                if (isMountedRef.current) {
                    setStep(bindingStep);
                }
            } catch (err) {
                if (isMountedRef.current) {
                    toastRef.current.error(`工作区设置失败: ${err}`);
                }
            } finally {
                if (isMountedRef.current) {
                    setCreatingWorkspace(false);
                }
            }
            return;
        }

        // Step 1 -> Step 2: validate credentials and start bot
        if (!hasCredentials) {
            toastRef.current.error(isFeishu ? '请输入 App ID 和 App Secret' : '请输入 Bot Token');
            return;
        }

        // Check for duplicate credentials — only against fully set-up bots
        const completedBots = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
        if (isFeishu) {
            if (completedBots.some(b => b.feishuAppId === feishuAppId.trim())) {
                toastRef.current.error('该飞书应用凭证已被其他 Bot 使用');
                return;
            }
        } else {
            if (completedBots.some(b => b.botToken === botToken.trim())) {
                toastRef.current.error('该 Bot Token 已被其他 Bot 使用');
                return;
            }
        }

        setStarting(true);
        setVerifyStatus('verifying');

        try {
            // Create the bot config — use mino temporarily for credential verification
            const defaultConfig = isFeishu ? DEFAULT_FEISHU_BOT_CONFIG : DEFAULT_IM_BOT_CONFIG;
            const mino = projects.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
            const newConfig: ImBotConfig = {
                ...defaultConfig,
                id: botId,
                name: isFeishu ? '飞书 Bot' : 'Telegram Bot',
                platform,
                botToken: isFeishu ? '' : botToken.trim(),
                feishuAppId: isFeishu ? feishuAppId.trim() : undefined,
                feishuAppSecret: isFeishu ? feishuAppSecret.trim() : undefined,
                allowedUsers: [],
                setupCompleted: false,
                enabled: true,
                defaultWorkspacePath: mino?.path,
            };

            // Save to disk first
            await saveBotConfig(newConfig);

            if (!isTauriEnvironment()) {
                setVerifyStatus('valid');
                setStep(2);
                return;
            }

            // Start the bot (this verifies the credentials)
            const { invoke } = await import('@tauri-apps/api/core');
            const params = await buildStartParams(newConfig);
            const status = await invoke<ImBotStatus>('cmd_start_im_bot', params);

            if (isMountedRef.current) {
                setVerifyStatus('valid');
                setBotUsername(status.botUsername ?? undefined);
                setBotStatus(status);
                // Save bot name from verification
                if (status.botUsername) {
                    const displayName = isFeishu ? status.botUsername : `@${status.botUsername}`;
                    await updateImBotConfig(botId, { name: displayName });
                    await refreshConfig();
                }
                setStep(2);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setVerifyStatus('invalid');
                toastRef.current.error(`验证失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setStarting(false);
            }
        }
    }, [hasCredentials, isFeishu, step, workspaceStep, bindingStep, botToken, feishuAppId, feishuAppSecret, botId, platform, config.imBotConfigs, projects, saveBotConfig, refreshConfig, workspaceChoice, selectedExistingPath, botUsername, buildStartParams]);

    // Complete wizard — merge local users with any Rust-persisted users to avoid
    // overwriting binds that happened while the frontend listener was inactive
    // (e.g. user bound during Feishu step 2 permissions guide).
    const handleComplete = useCallback(async () => {
        const latest = await loadAppConfig();
        const diskUsers = (latest.imBotConfigs ?? []).find(c => c.id === botId)?.allowedUsers ?? [];
        const mergedUsers = [...new Set([...diskUsers, ...allowedUsers])];
        await updateImBotConfig(botId, { setupCompleted: true, allowedUsers: mergedUsers });
        await refreshConfig();
        if (isMountedRef.current) onComplete(botId);
    }, [botId, allowedUsers, onComplete, refreshConfig]);

    // Cancel wizard - stop bot, remove config, and clean up created workspace
    const handleCancel = useCallback(async () => {
        if (isTauriEnvironment()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('cmd_stop_im_bot', { botId });
            } catch {
                // Bot might not be running
            }
        }
        await removeImBotConfig(botId);

        // Clean up workspace created during this wizard session (registration + disk directory)
        if (createdWorkspacePathRef.current) {
            try {
                const allProjects = await loadProjects();
                const project = allProjects.find(p => p.path === createdWorkspacePathRef.current);
                if (project) {
                    await removeProject(project.id);
                }
                // Remove directory from disk (Rust command validates path is under ~/.myagents/projects/)
                if (isTauriEnvironment()) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('cmd_remove_bot_workspace', { workspacePath: createdWorkspacePathRef.current });
                }
            } catch {
                // Best-effort cleanup
            }
            createdWorkspacePathRef.current = undefined;
        }

        await refreshConfig();
        // Navigate back to platform-select; ImSettings's goToList will refresh config when list is shown
        if (isMountedRef.current) onCancel();
    }, [botId, onCancel, refreshConfig]);

    const handleCopyPermJson = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(FEISHU_PERMISSIONS_JSON);
            setPermJsonCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setPermJsonCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, []);

    const platformLabel = isFeishu ? '飞书' : 'Telegram';
    const platformColor = isFeishu ? '#3370ff' : '#0088cc';

    const stepLabel = (() => {
        if (!isFeishu) {
            if (step === 1) return '配置 Bot Token';
            if (step === 2) return '设置工作区';
            return '绑定你的 Telegram 账号';
        }
        if (step === 1) return '配置应用凭证';
        if (step === 2) return '配置权限与事件';
        if (step === 3) return '设置工作区';
        return '绑定你的飞书账号';
    })();

    // Derive workspace display name from bot username
    const workspaceName = botUsername || (isFeishu ? '飞书Bot' : 'TelegramBot');

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={handleCancel}
                    className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            添加 {platformLabel} Bot
                        </h2>
                        <span
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: `${platformColor}15`, color: platformColor }}
                        >
                            {platformLabel}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        步骤 {step}/{totalSteps}: {stepLabel}
                    </p>
                    <div className="mt-1.5 flex gap-1">
                        {Array.from({ length: totalSteps }, (_, i) => (
                            <div
                                key={i}
                                className={`h-1 w-16 rounded-full ${step >= i + 1 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Step 1: Credentials */}
            {step === 1 && (
                <div className="space-y-6">
                    {/* Platform-specific tutorial + input */}
                    {isFeishu ? (
                        <div className="space-y-6">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <FeishuCredentialInput
                                    appId={feishuAppId}
                                    appSecret={feishuAppSecret}
                                    onAppIdChange={setFeishuAppId}
                                    onAppSecretChange={setFeishuAppSecret}
                                    verifyStatus={verifyStatus}
                                    botName={botUsername}
                                    showGuide={false}
                                />
                            </div>
                            {/* Step 1 guide: items 1–3 (create app, get credentials, add bot capability) */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <p className="text-sm font-medium text-[var(--ink)]">如何获取飞书应用凭证？</p>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>1. 登录<a
                                        href="https://open.feishu.cn/app"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mx-0.5 inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                    >
                                        飞书开放平台
                                    </a>并创建自建应用</li>
                                    <li>2. 在「凭证与基础信息」页获取 App ID 和 App Secret</li>
                                    <li>3. 左侧菜单进入 <span className="font-medium text-[var(--ink)]">添加应用能力</span>，找到 <span className="font-medium text-[var(--ink)]">机器人</span> 卡片，点击 <span className="font-medium text-[var(--ink)]">配置</span> 按钮添加</li>
                                </ol>
                                <img
                                    src={feishuStep1Img}
                                    alt="飞书开放平台 - 凭证与基础信息"
                                    className="mt-4 w-full rounded-lg border border-[var(--line)]"
                                />
                                <img
                                    src={feishuStep2AddBotImg}
                                    alt="飞书添加应用能力 - 机器人"
                                    className="mt-4 w-full rounded-lg border border-[var(--line)]"
                                />
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Token input */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <BotTokenInput
                                    value={botToken}
                                    onChange={setBotToken}
                                    verifyStatus={verifyStatus}
                                    botUsername={botUsername}
                                />
                            </div>

                            {/* BotFather tutorial */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    如何获取 Bot Token？
                                </h3>
                                <div className="mt-3 flex gap-5">
                                    <img
                                        src={telegramBotAddImg}
                                        alt="Telegram BotFather tutorial"
                                        className="h-[270px] flex-shrink-0 rounded-lg border border-[var(--line)] object-cover"
                                    />
                                    <ol className="flex-1 space-y-2 text-sm text-[var(--ink-muted)]">
                                        <li>1. 扫左侧二维码，或在 Telegram 中搜索 <span className="font-medium text-[var(--ink)]">@BotFather</span></li>
                                        <li>2. 发送 <code className="rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-xs">/newbot</code> 创建新 Bot</li>
                                        <li>3. 按提示设置 Bot 名称和用户名</li>
                                        <li>4. 复制返回的 <span className="font-medium text-[var(--ink)]">HTTP API Token</span></li>
                                        <li>5. 粘贴到上方的 Bot Token 输入框</li>
                                    </ol>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={handleCancel}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                        >
                            取消
                        </button>
                        <button
                            onClick={handleNext}
                            disabled={!hasCredentials || starting}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                        >
                            下一步
                            {starting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ArrowRight className="h-4 w-4" />
                            )}
                        </button>
                    </div>
                </div>
            )}

            {/* Step 2 (Feishu only): Permissions & Events guide */}
            {isFeishu && step === 2 && (
                <div className="space-y-6">
                    {/* Permissions guide */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">4. 配置权限</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">权限管理</span></li>
                            <li>点击 <span className="font-medium text-[var(--ink)]">批量导入</span></li>
                            <li>粘贴以下 JSON（一键导入所有需要的权限）：</li>
                        </ol>
                        <div className="mt-3 relative">
                            <button
                                onClick={handleCopyPermJson}
                                className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                title="复制 JSON"
                            >
                                {permJsonCopied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                            <pre className="overflow-x-auto rounded-lg bg-[var(--paper-contrast)] p-3 text-[11px] leading-relaxed text-[var(--ink-muted)]">
                                {FEISHU_PERMISSIONS_JSON}
                            </pre>
                        </div>
                        <img
                            src={feishuStep2PermImg}
                            alt="飞书权限管理 - 批量导入"
                            className="mt-4 w-full rounded-lg border border-[var(--line)]"
                        />
                    </div>

                    {/* Events guide */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">5. 配置事件订阅</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">事件与回调</span> &gt; <span className="font-medium text-[var(--ink)]">事件配置</span></li>
                            <li>请求方式选择：<span className="font-medium text-[var(--ink)]">使用长连接接收事件</span>（不需要公网服务器）</li>
                            <li>添加事件：搜索 <code className="rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[11px]">im.message.receive_v1</code>（接收消息），勾选添加</li>
                        </ol>
                        <img
                            src={feishuStep2EventImg}
                            alt="飞书事件与回调 - 事件配置"
                            className="mt-4 w-full rounded-lg border border-[var(--line)]"
                        />
                    </div>

                    {/* Publish version */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">6. 创建版本并发布</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">版本管理与发布</span></li>
                            <li>点击右上角 <span className="font-medium text-[var(--ink)]">创建版本</span>，填写版本信息后提交发布</li>
                        </ol>
                        <img
                            src={feishuStep2PublishImg}
                            alt="飞书版本管理与发布"
                            className="mt-4 w-full rounded-lg border border-[var(--line)]"
                        />
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={() => setStep(1)}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                        >
                            上一步
                        </button>
                        <button
                            onClick={handleNext}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            下一步
                            <ArrowRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Workspace step */}
            {step === workspaceStep && (
                <div className="space-y-6">
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">选择 Bot 工作区</h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            工作区是 Bot 的独立运行环境，包含记忆、配置和巡检清单等文件。建议每个 Bot 使用独立工作区，避免多个 Bot 共用同一工作区导致冲突。
                        </p>

                        <div className="mt-5 space-y-3">
                            {/* Option 1: Create new workspace */}
                            <label
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                                    workspaceChoice === 'new'
                                        ? 'border-[var(--button-primary-bg)] bg-[var(--button-primary-bg)]/5'
                                        : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="workspace-choice"
                                    checked={workspaceChoice === 'new'}
                                    onChange={() => setWorkspaceChoice('new')}
                                    className="mt-0.5 accent-[var(--button-primary-bg)]"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <FolderPlus className="h-4 w-4 text-[var(--button-primary-bg)]" />
                                        <span className="text-sm font-medium text-[var(--ink)]">
                                            新建工作区 — {workspaceName}
                                        </span>
                                        <span className="rounded-full bg-[var(--button-primary-bg)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--button-primary-bg)]">
                                            推荐
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        为此 Bot 创建专属工作区，拥有独立的记忆和配置
                                    </p>
                                    <p className="mt-1 font-mono text-[10px] text-[var(--ink-muted)]">
                                        ~/.myagents/projects/{workspaceName}/
                                    </p>
                                </div>
                            </label>

                            {/* Option 2: Select existing workspace */}
                            <label
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
                                    workspaceChoice === 'existing'
                                        ? 'border-[var(--button-primary-bg)] bg-[var(--button-primary-bg)]/5'
                                        : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="workspace-choice"
                                    checked={workspaceChoice === 'existing'}
                                    onChange={() => setWorkspaceChoice('existing')}
                                    className="mt-0.5 accent-[var(--button-primary-bg)]"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <FolderOpen className="h-4 w-4 text-[var(--ink-muted)]" />
                                        <span className="text-sm font-medium text-[var(--ink)]">
                                            选择已有工作区
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        与其他 Bot 或客户端共享现有工作区
                                    </p>

                                    {workspaceChoice === 'existing' && (
                                        <div className="mt-3">
                                            <CustomSelect
                                                value={selectedExistingPath}
                                                options={projects.map(p => ({
                                                    value: p.path,
                                                    label: shortenPathForDisplay(p.path),
                                                    icon: <FolderOpen className="h-3.5 w-3.5" />,
                                                }))}
                                                onChange={setSelectedExistingPath}
                                                placeholder="选择工作区"
                                                triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                                                className="w-full"
                                                footerAction={{
                                                    label: '选择文件夹...',
                                                    icon: <Plus className="h-3.5 w-3.5" />,
                                                    onClick: async () => {
                                                        if (!isTauriEnvironment()) return;
                                                        const { open } = await import('@tauri-apps/plugin-dialog');
                                                        const selected = await open({ directory: true, multiple: false, title: '选择 Bot 工作区' });
                                                        if (selected && typeof selected === 'string') {
                                                            if (!projects.find(p => p.path === selected)) {
                                                                await addProject(selected);
                                                                await refreshConfig();
                                                            }
                                                            setSelectedExistingPath(selected);
                                                        }
                                                    },
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </label>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={() => setStep(isFeishu ? 2 : 1)}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                        >
                            上一步
                        </button>
                        <button
                            onClick={handleNext}
                            disabled={creatingWorkspace || (workspaceChoice === 'existing' && !selectedExistingPath)}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                        >
                            下一步
                            {creatingWorkspace ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ArrowRight className="h-4 w-4" />
                            )}
                        </button>
                    </div>
                </div>
            )}

            {/* Binding step */}
            {step === bindingStep && (
                <div className="space-y-6">
                    {/* Platform-specific binding panel */}
                    {isFeishu ? (
                        botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={allowedUsers.length > 0}
                            />
                        )
                    ) : (
                        <>
                            {botStatus?.bindUrl && (
                                <BindQrPanel
                                    bindUrl={botStatus.bindUrl}
                                    hasWhitelistUsers={allowedUsers.length > 0}
                                />
                            )}
                            {/* Manual user add for Telegram only */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <WhitelistManager
                                    users={allowedUsers}
                                    onChange={setAllowedUsers}
                                    platform={platform}
                                />
                            </div>
                        </>
                    )}

                    {/* Feishu: show bound users read-only */}
                    {isFeishu && allowedUsers.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <WhitelistManager
                                users={allowedUsers}
                                onChange={setAllowedUsers}
                                platform={platform}
                            />
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-between">
                        <button
                            onClick={() => setStep(workspaceStep)}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                        >
                            上一步
                        </button>
                        <button
                            onClick={handleComplete}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            完成
                            <Check className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
