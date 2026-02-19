import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { ImPlatform } from '../../../shared/types/im';
import telegramIcon from './assets/telegram.png';
import feishuIcon from './assets/feishu.jpeg';

const platforms: { id: ImPlatform; name: string; description: string; icon: string }[] = [
    {
        id: 'telegram',
        name: 'Telegram',
        description: '通过 Telegram Bot 远程使用 AI Agent',
        icon: telegramIcon,
    },
    {
        id: 'feishu',
        name: '飞书',
        description: '通过飞书自建应用 Bot 远程使用 AI Agent',
        icon: feishuIcon,
    },
];

export default function PlatformSelect({
    onSelect,
    onCancel,
}: {
    onSelect: (platform: ImPlatform) => void;
    onCancel: () => void;
}) {
    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={onCancel}
                    className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">选择平台</h2>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        选择要接入的聊天平台
                    </p>
                </div>
            </div>

            {/* Platform cards */}
            <div className="grid grid-cols-2 gap-4">
                {platforms.map((p) => (
                    <button
                        key={p.id}
                        onClick={() => onSelect(p.id)}
                        className="flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--button-primary-bg)] hover:shadow-sm"
                    >
                        <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
                        <div className="text-center">
                            <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                            <p className="mt-1 text-xs text-[var(--ink-muted)]">{p.description}</p>
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}
