import React from 'react';
import { PERMISSION_MODES } from '@/config/types';

export default function PermissionModeSelect({
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
                                : 'border-[var(--line)] hover:border-[var(--line-strong)]'
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
