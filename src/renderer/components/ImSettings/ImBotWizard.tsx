import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { getAllMcpServers, getEnabledMcpServerIds, addOrUpdateImBotConfig, removeImBotConfig, updateImBotConfig } from '@/config/configService';
import BotTokenInput from './components/BotTokenInput';
import BindQrPanel from './components/BindQrPanel';
import WhitelistManager from './components/WhitelistManager';
import type { ImBotConfig, ImBotStatus } from '../../../shared/types/im';
import { DEFAULT_IM_BOT_CONFIG } from '../../../shared/types/im';
import telegramBotAddImg from './assets/telegram_bot_add.png';

export default function ImBotWizard({
    onComplete,
    onCancel,
}: {
    onComplete: (botId: string) => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { config, providers, apiKeys, projects, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    const [step, setStep] = useState<1 | 2>(1);
    const [botToken, setBotToken] = useState('');
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [starting, setStarting] = useState(false);
    const [botId] = useState(() => crypto.randomUUID());
    const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
    const [botStatus, setBotStatus] = useState<ImBotStatus | null>(null);

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Poll status when in step 2
    useEffect(() => {
        if (step !== 2 || !isTauriEnvironment()) return;

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
    }, [step, botId]);

    // Listen for user-bound events
    useEffect(() => {
        if (step !== 2 || !isTauriEnvironment()) return;
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
                    toastRef.current.success(`用户 ${displayName} 已通过二维码绑定`);
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
    }, [step, botId]);

    // Save bot config to disk and sync React state
    const saveBotConfig = useCallback(async (cfg: ImBotConfig) => {
        await addOrUpdateImBotConfig(cfg);
        await refreshConfig();
    }, [refreshConfig]);

    // Step 1 → Step 2: validate token and start bot
    const handleNext = useCallback(async () => {
        if (!botToken.trim()) {
            toastRef.current.error('请输入 Bot Token');
            return;
        }

        // Check for duplicate token
        const existingBots = config.imBotConfigs ?? [];
        if (existingBots.some(b => b.botToken === botToken.trim())) {
            toastRef.current.error('该 Bot Token 已被其他 Bot 使用');
            return;
        }

        setStarting(true);
        setVerifyStatus('verifying');

        try {
            // Create the bot config
            const name = 'Telegram Bot';
            const mino = projects.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
            const newConfig: ImBotConfig = {
                ...DEFAULT_IM_BOT_CONFIG,
                id: botId,
                name,
                platform: 'telegram',
                botToken: botToken.trim(),
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

            // Start the bot (this verifies the token)
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
            });

            if (isMountedRef.current) {
                setVerifyStatus('valid');
                setBotUsername(status.botUsername ?? undefined);
                setBotStatus(status);
                // Save Telegram username as bot name
                if (status.botUsername) {
                    await updateImBotConfig(botId, { name: `@${status.botUsername}` });
                    await refreshConfig();
                }
                setStep(2);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setVerifyStatus('invalid');
                toastRef.current.error(`Token 验证失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setStarting(false);
            }
        }
    }, [botToken, botId, config.imBotConfigs, providers, apiKeys, projects, saveBotConfig, refreshConfig]);

    // Complete wizard
    const handleComplete = useCallback(async () => {
        await updateImBotConfig(botId, { setupCompleted: true, allowedUsers });
        await refreshConfig();
        onComplete(botId);
    }, [botId, allowedUsers, onComplete, refreshConfig]);

    // Skip binding step
    const handleSkip = useCallback(async () => {
        await updateImBotConfig(botId, { setupCompleted: true });
        await refreshConfig();
        onComplete(botId);
    }, [botId, onComplete, refreshConfig]);

    // Cancel wizard — stop bot and remove config
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
        await refreshConfig();
        onCancel();
    }, [botId, onCancel, refreshConfig]);

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
                            添加 Telegram Bot
                        </h2>
                        <span className="rounded-full bg-[#0088cc]/10 px-2 py-0.5 text-xs font-medium text-[#0088cc]">
                            Telegram
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        步骤 {step}/2: {step === 1 ? '配置 Bot Token' : '绑定你的 Telegram 账号'}
                    </p>
                    <div className="mt-1.5 flex gap-1">
                        <div className={`h-1 w-16 rounded-full ${step >= 1 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`} />
                        <div className={`h-1 w-16 rounded-full ${step >= 2 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`} />
                    </div>
                </div>
            </div>

            {step === 1 && (
                <div className="space-y-6">
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
                            disabled={!botToken.trim() || starting}
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

            {step === 2 && (
                <div className="space-y-6">
                    {/* QR binding */}
                    {botStatus?.bindUrl && (
                        <BindQrPanel
                            bindUrl={botStatus.bindUrl}
                            hasWhitelistUsers={allowedUsers.length > 0}
                        />
                    )}

                    {/* Manual user add */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <WhitelistManager
                            users={allowedUsers}
                            onChange={setAllowedUsers}
                        />
                    </div>

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
