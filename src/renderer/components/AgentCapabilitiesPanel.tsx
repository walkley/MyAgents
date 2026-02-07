/**
 * AgentCapabilitiesPanel - Panel showing enabled agent capabilities
 * Used in the Chat sidebar (DirectoryPanel) to show Sub-Agents, Skills, Commands
 *
 * Interactions:
 * - Default expanded, click header to toggle
 * - Hover: tooltip with scope + description
 * - Click Skills/Commands: insert /name into chat input
 * - Click Agent: toast hint (AI decides when to use)
 * - Right-click Agent: enable/disable, settings
 * - Right-click Skills/Commands: settings
 */
import { Bot, ChevronDown, ChevronRight, Sparkles, Terminal } from 'lucide-react';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';

import { CUSTOM_EVENTS } from '../../shared/constants';
import { useToast } from '@/components/Toast';
import type { Tab as WorkspaceTab } from './WorkspaceConfigPanel';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';

interface CapabilityItem {
    name: string;
    description: string;
    scope?: 'user' | 'project';
    model?: string;
}

interface AgentCapabilitiesPanelProps {
    enabledAgents?: Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project' }>;
    enabledSkills?: CapabilityItem[];
    enabledCommands?: CapabilityItem[];
    /** Insert /command into chat input */
    onInsertSlashCommand?: (command: string) => void;
    /** Open settings panel to a specific tab */
    onOpenSettings?: (tab: Extract<WorkspaceTab, 'skills-commands' | 'agents'>) => void;
    /** Called when expand/collapse state changes (for sibling layout recalculation) */
    onExpandChange?: (expanded: boolean) => void;
}

/** Tooltip shown on hover — width matches the sidebar with small inset */
function ItemTooltip({ scope, description, children }: {
    scope?: string;
    description?: string;
    children: React.ReactNode;
}) {
    const [show, setShow] = useState(false);
    const [pos, setPos] = useState({ x: 0, y: 0, width: 240 });
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    const handleMouseEnter = useCallback((e: React.MouseEvent) => {
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        // Walk up to the nearest scrollable panel to get sidebar width
        const panel = el.closest('[data-capabilities-panel]') as HTMLElement | null;
        const panelRect = panel?.getBoundingClientRect();
        const panelLeft = panelRect?.left ?? rect.left;
        const panelWidth = panelRect?.width ?? 240;
        const inset = 8; // px padding from sidebar edges
        setPos({ x: panelLeft + inset, y: rect.top - 4, width: panelWidth - inset * 2 });
        timerRef.current = setTimeout(() => setShow(true), 400);
    }, []);

    const handleMouseLeave = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setShow(false);
    }, []);

    // Cleanup timer on unmount to prevent state update on unmounted component
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    return (
        <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative">
            {children}
            {show && (scope || description) && (
                <div
                    className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 shadow-lg"
                    style={{ left: pos.x, top: pos.y, width: pos.width, transform: 'translateY(-100%)' }}
                >
                    {scope && (
                        <span className="mb-1 inline-block rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                            {scope === 'user' ? '全局' : scope === 'project' ? '项目' : scope}
                        </span>
                    )}
                    {description && (
                        <p className="text-[11px] leading-relaxed text-[var(--ink-muted)]">{description}</p>
                    )}
                </div>
            )}
        </div>
    );
}

export default function AgentCapabilitiesPanel({
    enabledAgents,
    enabledSkills,
    enabledCommands,
    onInsertSlashCommand,
    onOpenSettings,
    onExpandChange,
}: AgentCapabilitiesPanelProps) {
    const [isExpanded, setIsExpanded] = useState(true); // Default expanded
    const toast = useToast();
    const toastRef = useRef(toast);
    useEffect(() => { toastRef.current = toast; }, [toast]);

    // Stabilize onExpandChange ref to avoid re-creating toggleExpand
    const onExpandChangeRef = useRef(onExpandChange);
    useEffect(() => { onExpandChangeRef.current = onExpandChange; }, [onExpandChange]);

    // Context menu state
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

    const toggleExpand = useCallback(() => {
        setIsExpanded(prev => {
            const next = !prev;
            // Notify parent after DOM update for layout recalculation
            requestAnimationFrame(() => onExpandChangeRef.current?.(next));
            return next;
        });
    }, []);

    // Convert agents map to list
    const agentList = useMemo<CapabilityItem[]>(() =>
        enabledAgents
            ? Object.entries(enabledAgents).map(([name, def]) => ({
                name,
                description: def.description || '',
                model: def.model,
                scope: def.scope,
            }))
            : [],
    [enabledAgents]);

    const skillsList = enabledSkills || [];
    const commandsList = enabledCommands || [];

    const agentCount = agentList.length;
    const skillsCount = skillsList.length;
    const commandsCount = commandsList.length;
    const totalCount = agentCount + skillsCount + commandsCount;

    // Click handlers
    const handleSkillClick = useCallback((name: string) => {
        onInsertSlashCommand?.(name);
    }, [onInsertSlashCommand]);

    const handleCommandClick = useCallback((name: string) => {
        onInsertSlashCommand?.(name);
    }, [onInsertSlashCommand]);

    const handleAgentClick = useCallback(() => {
        toastRef.current.info('该 Agent 已启用，AI 自主判断使用时机');
    }, []);

    // Navigate to the correct settings panel based on scope
    const openSettingsForScope = useCallback((scope: 'user' | 'project' | undefined, projectTab: Extract<WorkspaceTab, 'skills-commands' | 'agents'>, globalSection: string) => {
        if (scope === 'user') {
            // Global items → open global Settings page
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: globalSection } }));
        } else {
            // Project items → open project WorkspaceConfigPanel
            onOpenSettings?.(projectTab);
        }
        setCtxMenu(null);
    }, [onOpenSettings]);

    // Right-click handlers
    const handleAgentContextMenu = useCallback((e: React.MouseEvent, scope?: 'user' | 'project') => {
        e.preventDefault();
        e.stopPropagation();
        const items: ContextMenuItem[] = [
            {
                label: '设置',
                onClick: () => openSettingsForScope(scope, 'agents', 'agents'),
            },
        ];
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }, [openSettingsForScope]);

    const handleSkillCommandContextMenu = useCallback((e: React.MouseEvent, scope?: 'user' | 'project') => {
        e.preventDefault();
        e.stopPropagation();
        const items: ContextMenuItem[] = [
            {
                label: '设置',
                onClick: () => openSettingsForScope(scope, 'skills-commands', 'skills'),
            },
        ];
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }, [openSettingsForScope]);

    // Empty state
    if (totalCount === 0) {
        return (
            <div data-capabilities-panel className="flex shrink-0 flex-col border-t border-[var(--line)]">
                <button
                    onClick={toggleExpand}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink)] transition-colors"
                >
                    {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                    <span className="font-semibold">Agent 能力</span>
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
        <div
            data-capabilities-panel
            className={`flex flex-col border-t border-[var(--line)] ${isExpanded ? 'min-h-0' : 'shrink-0'}`}
            style={isExpanded ? { flex: '0 0 40%' } : undefined}
        >
            {/* Header - always visible */}
            <button
                onClick={toggleExpand}
                className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-sm text-[var(--ink)] transition-colors"
            >
                {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span className="font-semibold">Agent 能力 ({totalCount})</span>
            </button>

            {/* Expanded content - scrollable */}
            {isExpanded && (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 space-y-2">
                    {/* Sub-Agents Group */}
                    {agentCount > 0 && (
                        <div>
                            <p className="px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Sub-Agents ({agentCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {agentList.map(item => (
                                    <ItemTooltip key={`agent-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={handleAgentClick}
                                            onContextMenu={e => handleAgentContextMenu(e, item.scope)}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                        >
                                            <Bot className="h-3 w-3 shrink-0 text-violet-500" />
                                            <p className="min-w-0 flex-1 truncate text-xs text-[var(--ink)]">{item.name}</p>
                                            {item.model && (
                                                <span className="shrink-0 rounded bg-[var(--paper-contrast)] px-1 py-0.5 text-[9px] text-[var(--ink-muted)]">
                                                    {item.model}
                                                </span>
                                            )}
                                        </button>
                                    </ItemTooltip>
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
                                    <ItemTooltip key={`skill-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={() => handleSkillClick(item.name)}
                                            onContextMenu={e => handleSkillCommandContextMenu(e, item.scope)}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                        >
                                            <Sparkles className="h-3 w-3 shrink-0 text-amber-500" />
                                            <p className="min-w-0 flex-1 truncate text-xs text-[var(--ink)]">{item.name}</p>
                                        </button>
                                    </ItemTooltip>
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
                                    <ItemTooltip key={`cmd-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={() => handleCommandClick(item.name)}
                                            onContextMenu={e => handleSkillCommandContextMenu(e, item.scope)}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--paper-contrast)] transition-colors"
                                        >
                                            <Terminal className="h-3 w-3 shrink-0 text-green-500" />
                                            <p className="min-w-0 flex-1 truncate text-xs text-[var(--ink)]">/{item.name}</p>
                                        </button>
                                    </ItemTooltip>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Context Menu */}
            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={ctxMenu.items}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </div>
    );
}
