/**
 * AgentCapabilitiesPanel - Collapsible panel showing enabled agent capabilities
 * Used in the Chat sidebar (DirectoryPanel) to show Sub-Agents, Skills, Commands
 */
import { Bot, ChevronDown, ChevronRight, Sparkles, Terminal, X } from 'lucide-react';
import { useState, useCallback, useMemo } from 'react';

interface CapabilityItem {
    name: string;
    description: string;
    model?: string;
}

interface AgentCapabilitiesPanelProps {
    enabledAgents?: Record<string, { description: string; prompt?: string; model?: string }>;
    enabledSkills?: CapabilityItem[];
    enabledCommands?: CapabilityItem[];
}

export default function AgentCapabilitiesPanel({
    enabledAgents,
    enabledSkills,
    enabledCommands,
}: AgentCapabilitiesPanelProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedItem, setSelectedItem] = useState<{ name: string; description: string; type: string } | null>(null);

    const toggleExpand = useCallback(() => {
        setIsExpanded(prev => !prev);
    }, []);

    // Convert agents map to list
    const agentList = useMemo<CapabilityItem[]>(() =>
        enabledAgents
            ? Object.entries(enabledAgents).map(([name, def]) => ({
                name,
                description: def.description || '',
                model: def.model,
            }))
            : [],
    [enabledAgents]);

    const skillsList = enabledSkills || [];
    const commandsList = enabledCommands || [];

    const agentCount = agentList.length;
    const skillsCount = skillsList.length;
    const commandsCount = commandsList.length;
    const totalCount = agentCount + skillsCount + commandsCount;

    // Show empty state guidance when panel has no capabilities at all
    if (totalCount === 0) {
        return (
            <div className="border-t border-[var(--line)]">
                <button
                    onClick={toggleExpand}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
                >
                    {isExpanded ? (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                    ) : (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                    )}
                    <Bot className="h-3 w-3 shrink-0 text-violet-500" />
                    <span className="font-medium">Agent 能力</span>
                </button>
                {isExpanded && (
                    <div className="px-4 pb-3 text-center">
                        <p className="text-[11px] text-[var(--ink-muted)]">
                            在项目设置中配置 Agent 能力
                        </p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="border-t border-[var(--line)]">
            {/* Header - always visible */}
            <button
                onClick={toggleExpand}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
            >
                {isExpanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                <Bot className="h-3 w-3 shrink-0 text-violet-500" />
                <span className="font-medium">Agent 能力 ({totalCount})</span>
            </button>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-3 pb-2 space-y-2">
                    {/* Sub-Agents Group */}
                    {agentCount > 0 && (
                        <div>
                            <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Sub-Agents ({agentCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {agentList.map(item => (
                                    <button
                                        key={`agent-${item.name}`}
                                        onClick={() => setSelectedItem({ name: item.name, description: item.description, type: 'Sub-Agent' })}
                                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                    >
                                        <Bot className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1">
                                                <p className="truncate text-xs font-medium text-[var(--ink)]">{item.name}</p>
                                                {item.model && (
                                                    <span className="shrink-0 rounded bg-[var(--paper-contrast)] px-1 py-0.5 text-[9px] text-[var(--ink-muted)]">
                                                        {item.model}
                                                    </span>
                                                )}
                                            </div>
                                            {item.description && (
                                                <p className="truncate text-[11px] text-[var(--ink-muted)]">{item.description}</p>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Skills Group */}
                    {skillsCount > 0 && (
                        <div>
                            <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Skills ({skillsCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {skillsList.map(item => (
                                    <button
                                        key={`skill-${item.name}`}
                                        onClick={() => setSelectedItem({ name: item.name, description: item.description, type: 'Skill' })}
                                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                    >
                                        <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-xs font-medium text-[var(--ink)]">{item.name}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Commands Group */}
                    {commandsCount > 0 && (
                        <div>
                            <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Commands ({commandsCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {commandsList.map(item => (
                                    <button
                                        key={`cmd-${item.name}`}
                                        onClick={() => setSelectedItem({ name: item.name, description: item.description, type: 'Command' })}
                                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                    >
                                        <Terminal className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-xs font-medium text-[var(--ink)]">/{item.name}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Info card popup */}
            {selectedItem && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setSelectedItem(null)}>
                    <div
                        className="w-[300px] rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-xl"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <span className="rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                                    {selectedItem.type}
                                </span>
                                <h4 className="text-sm font-semibold text-[var(--ink)]">{selectedItem.name}</h4>
                            </div>
                            <button
                                onClick={() => setSelectedItem(null)}
                                className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        {selectedItem.description && (
                            <p className="text-xs text-[var(--ink-muted)]">{selectedItem.description}</p>
                        )}
                        <p className="mt-3 text-[10px] text-[var(--ink-muted)]/60">
                            在项目设置 &rarr; Agents 中编辑
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
