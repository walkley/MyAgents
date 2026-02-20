import React, { useCallback, useMemo } from 'react';
import type { HeartbeatConfig, ActiveHoursConfig } from '../../../../shared/types/im';
import { DEFAULT_HEARTBEAT_CONFIG } from '../../../../shared/types/im';

const INTERVAL_PRESETS = [
    { label: '5 分钟', value: 5 },
    { label: '15 分钟', value: 15 },
    { label: '30 分钟', value: 30 },
    { label: '1 小时', value: 60 },
    { label: '4 小时', value: 240 },
];

const COMMON_TIMEZONES = [
    { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
    { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
    { label: 'America/New_York (UTC-5)', value: 'America/New_York' },
    { label: 'America/Los_Angeles (UTC-8)', value: 'America/Los_Angeles' },
    { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
    { label: 'Europe/Berlin (UTC+1)', value: 'Europe/Berlin' },
    { label: 'UTC', value: 'UTC' },
];

export default function HeartbeatConfigCard({
    heartbeat,
    onChange,
}: {
    heartbeat: HeartbeatConfig | undefined;
    onChange: (config: HeartbeatConfig | undefined) => void;
}) {
    const config = useMemo(
        () => heartbeat ?? DEFAULT_HEARTBEAT_CONFIG,
        [heartbeat],
    );

    const update = useCallback(
        (patch: Partial<HeartbeatConfig>) => {
            onChange({ ...config, ...patch });
        },
        [config, onChange],
    );

    const toggleEnabled = useCallback(() => {
        if (!heartbeat) {
            // First enable: create with defaults
            onChange({ ...DEFAULT_HEARTBEAT_CONFIG, enabled: true });
        } else {
            update({ enabled: !config.enabled });
        }
    }, [heartbeat, config.enabled, onChange, update]);

    const toggleActiveHours = useCallback(() => {
        if (config.activeHours) {
            update({ activeHours: undefined });
        } else {
            update({
                activeHours: {
                    start: '09:00',
                    end: '22:00',
                    timezone: 'Asia/Shanghai',
                },
            });
        }
    }, [config.activeHours, update]);

    const updateActiveHours = useCallback(
        (patch: Partial<ActiveHoursConfig>) => {
            if (!config.activeHours) return;
            update({ activeHours: { ...config.activeHours, ...patch } });
        },
        [config.activeHours, update],
    );

    const isCustomInterval = !INTERVAL_PRESETS.some(p => p.value === config.intervalMinutes);

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            {/* Header with toggle */}
            <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--ink)]">心跳巡检</h3>
                <button
                    type="button"
                    onClick={toggleEnabled}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        config.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'
                    }`}
                >
                    <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            config.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>

            {config.enabled && (
                <div className="space-y-4">
                    {/* Interval */}
                    <div>
                        <p className="mb-2 text-sm font-medium text-[var(--ink)]">巡检间隔</p>
                        <div className="flex flex-wrap gap-2">
                            {INTERVAL_PRESETS.map(preset => (
                                <button
                                    key={preset.value}
                                    type="button"
                                    onClick={() => update({ intervalMinutes: preset.value })}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        config.intervalMinutes === preset.value
                                            ? 'bg-[var(--accent)] text-white'
                                            : 'bg-[var(--paper-contrast)] text-[var(--ink-secondary)] hover:bg-[var(--ink-faint)]'
                                    }`}
                                >
                                    {preset.label}
                                </button>
                            ))}
                            {/* Custom interval input */}
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    min={5}
                                    max={1440}
                                    value={isCustomInterval ? config.intervalMinutes : ''}
                                    placeholder="自定义"
                                    onChange={e => {
                                        const val = parseInt(e.target.value, 10);
                                        if (!isNaN(val) && val >= 5) {
                                            update({ intervalMinutes: val });
                                        }
                                    }}
                                    className={`w-20 rounded-lg border px-2 py-1.5 text-xs ${
                                        isCustomInterval
                                            ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                                            : 'border-[var(--line)] bg-[var(--paper)]'
                                    } text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]`}
                                />
                                <span className="text-xs text-[var(--ink-muted)]">分钟</span>
                            </div>
                        </div>
                    </div>

                    {/* Checklist file hint */}
                    <div className="rounded-lg bg-[var(--paper-contrast)] px-3 py-2">
                        <p className="text-xs text-[var(--ink-secondary)]">
                            巡检清单存放在工作区根目录的 <code className="rounded bg-[var(--paper)] px-1 py-0.5 text-[var(--accent)]">HEARTBEAT.md</code> 文件中。
                            启用心跳后会自动创建该文件，编辑文件内容即可定义 AI 的巡检任务。
                        </p>
                    </div>

                    {/* Active hours */}
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-[var(--ink)]">活跃时段</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    仅在指定时间范围内执行巡检
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={toggleActiveHours}
                                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                    config.activeHours ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'
                                }`}
                            >
                                <span
                                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                        config.activeHours ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </div>

                        {config.activeHours && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input
                                    type="time"
                                    value={config.activeHours.start}
                                    onChange={e => updateActiveHours({ start: e.target.value })}
                                    className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                />
                                <span className="text-xs text-[var(--ink-muted)]">至</span>
                                <input
                                    type="time"
                                    value={config.activeHours.end}
                                    onChange={e => updateActiveHours({ end: e.target.value })}
                                    className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                />
                                <select
                                    value={config.activeHours.timezone}
                                    onChange={e => updateActiveHours({ timezone: e.target.value })}
                                    className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                >
                                    {COMMON_TIMEZONES.map(tz => (
                                        <option key={tz.value} value={tz.value}>
                                            {tz.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
