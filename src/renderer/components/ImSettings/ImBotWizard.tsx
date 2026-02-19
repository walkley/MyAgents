import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Loader2 } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { getAllMcpServers, getEnabledMcpServerIds, addOrUpdateImBotConfig, loadAppConfig, removeImBotConfig, updateImBotConfig } from '@/config/configService';
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
    const totalSteps = isFeishu ? 3 : 2;

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

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    // The binding step: step 2 for Telegram, step 3 for Feishu
    const bindingStep = isFeishu ? 3 : 2;

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

    // Step 1 -> Step 2: validate credentials and start bot
    const handleNext = useCallback(async () => {
        // Step 2 -> Step 3 for Feishu (permissions guide -> binding)
        if (isFeishu && step === 2) {
            setStep(3);
            return;
        }

        if (!hasCredentials) {
            toastRef.current.error(isFeishu ? '请输入 App ID 和 App Secret' : '请输入 Bot Token');
            return;
        }

        // Check for duplicate credentials
        const existingBots = config.imBotConfigs ?? [];
        if (isFeishu) {
            if (existingBots.some(b => b.feishuAppId === feishuAppId.trim())) {
                toastRef.current.error('该飞书应用凭证已被其他 Bot 使用');
                return;
            }
        } else {
            if (existingBots.some(b => b.botToken === botToken.trim())) {
                toastRef.current.error('该 Bot Token 已被其他 Bot 使用');
                return;
            }
        }

        setStarting(true);
        setVerifyStatus('verifying');

        try {
            // Create the bot config
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

            // Build start params
            const selectedProvider = providers.find(p => p.id === newConfig.providerId);
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
            const botMcpIds = newConfig.mcpEnabledServers ?? [];
            const enabledMcpDefs = allServers.filter(
                s => globalEnabled.includes(s.id) && botMcpIds.includes(s.id)
            );

            const status = await invoke<ImBotStatus>('cmd_start_im_bot', {
                botId,
                botToken: newConfig.botToken,
                allowedUsers: newConfig.allowedUsers,
                permissionMode: newConfig.permissionMode,
                workspacePath: newConfig.defaultWorkspacePath || '',
                model: newConfig.model || null,
                providerEnvJson: providerEnvJson || null,
                mcpServersJson: enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null,
                availableProvidersJson: availableProviders.length > 0 ? JSON.stringify(availableProviders) : null,
                platform: newConfig.platform,
                feishuAppId: newConfig.feishuAppId || null,
                feishuAppSecret: newConfig.feishuAppSecret || null,
            });

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
    }, [hasCredentials, isFeishu, step, botToken, feishuAppId, feishuAppSecret, botId, platform, config.imBotConfigs, providers, apiKeys, projects, saveBotConfig, refreshConfig]);

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

    // Skip binding step
    const handleSkip = useCallback(async () => {
        await updateImBotConfig(botId, { setupCompleted: true });
        await refreshConfig();
        if (isMountedRef.current) onComplete(botId);
    }, [botId, onComplete, refreshConfig]);

    // Cancel wizard - stop bot and remove config
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
        // Navigate back to platform-select; ImSettings's goToList will refresh config when list is shown
        if (isMountedRef.current) onCancel();
    }, [botId, onCancel]);

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
            return step === 1 ? '配置 Bot Token' : '绑定你的 Telegram 账号';
        }
        if (step === 1) return '配置应用凭证';
        if (step === 2) return '配置权限与事件';
        return '绑定你的飞书账号';
    })();

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
                            {/* Step 1 guide: only items 1 & 2 + image */}
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
                                </ol>
                                <img
                                    src={feishuStep1Img}
                                    alt="飞书开放平台 - 凭证与基础信息"
                                    className="mt-4 w-full rounded-lg border border-[var(--line)]"
                                />
                            </div>
                        </div>
                    ) : (
                        <>
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
                                        <li>5. 粘贴到下方的 Bot Token 输入框</li>
                                    </ol>
                                </div>
                            </div>

                            {/* Token input */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <BotTokenInput
                                    value={botToken}
                                    onChange={setBotToken}
                                    verifyStatus={verifyStatus}
                                    botUsername={botUsername}
                                />
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
                        <h3 className="text-sm font-medium text-[var(--ink)]">3. 配置权限</h3>
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
                        <h3 className="text-sm font-medium text-[var(--ink)]">4. 配置事件订阅</h3>
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

            {/* Binding step: step 2 for Telegram, step 3 for Feishu */}
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
                            onClick={handleSkip}
                            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                        >
                            跳过
                        </button>
                        <button
                            onClick={handleComplete}
                            className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            <Check className="h-4 w-4" />
                            完成
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
