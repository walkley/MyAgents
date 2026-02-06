/**
 * AgentDetailPanel - Component for viewing and editing a Sub-Agent
 * Supports preview/edit mode with save confirmation
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalAgentsPanel).
 */
import { Loader2, ChevronDown, ChevronUp, Trash2, Edit2, X, Check } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useRef, useMemo } from 'react';

import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { apiGetJson as globalApiGet, apiPutJson as globalApiPut, apiDelete as globalApiDelete, apiPostJson as globalApiPost } from '@/api/apiFetch';
import { useTabStateOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import type { AgentFrontmatter, AgentDetail, AgentMeta } from '../../shared/agentTypes';
import { sanitizeFolderName } from '../../shared/utils';

interface AgentDetailPanelProps {
    name: string;
    scope: 'user' | 'project';
    onBack: () => void;
    onSaved: (autoClose?: boolean) => void;
    onDeleted: () => void;
    startInEditMode?: boolean;
    agentDir?: string;
}

export interface AgentDetailPanelRef {
    isEditing: () => boolean;
}

const AgentDetailPanel = forwardRef<AgentDetailPanelRef, AgentDetailPanelProps>(
    function AgentDetailPanel({ name, scope, onBack: _onBack, onSaved, onDeleted, startInEditMode = false, agentDir }, ref) {
        const toast = useToast();
        const toastRef = useRef(toast);
        toastRef.current = toast;

        const tabState = useTabStateOptional();
        const apiGet = tabState?.apiGet;
        const apiPost = tabState?.apiPost;
        const apiPut = tabState?.apiPut;
        const apiDeleteFn = tabState?.apiDelete;

        const api = useMemo(() => {
            if (apiGet && apiPost && apiPut && apiDeleteFn) {
                return { get: apiGet, post: apiPost, put: apiPut, delete: apiDeleteFn };
            }
            return { get: globalApiGet, post: globalApiPost, put: globalApiPut, delete: globalApiDelete };
        }, [apiGet, apiPost, apiPut, apiDeleteFn]);

        const isInTabContext = !!tabState;
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [agent, setAgent] = useState<AgentDetail | null>(null);
        const [showAdvanced, setShowAdvanced] = useState(false);
        const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
        const [deleting, setDeleting] = useState(false);
        const [isEditing, setIsEditing] = useState(false);
        const [isNewAgent, setIsNewAgent] = useState(startInEditMode);

        // Original values for comparison
        const [originalAgentName, setOriginalAgentName] = useState('');
        const [originalDescription, setOriginalDescription] = useState('');
        const [originalBody, setOriginalBody] = useState('');
        const [originalModel, setOriginalModel] = useState('');
        const [originalTools, setOriginalTools] = useState('');
        const [originalDisallowedTools, setOriginalDisallowedTools] = useState('');
        const [originalMaxTurns, setOriginalMaxTurns] = useState('');
        const [originalPermissionMode, setOriginalPermissionMode] = useState('');
        const [originalMemory, setOriginalMemory] = useState('');
        const [originalSkills, setOriginalSkills] = useState('');
        const [originalHooksYaml, setOriginalHooksYaml] = useState('');
        const [originalDisplayName, setOriginalDisplayName] = useState('');
        const [originalIcon, setOriginalIcon] = useState('');
        const [originalColor, setOriginalColor] = useState('');

        // Editable fields
        const [agentName, setAgentName] = useState('');
        const [description, setDescription] = useState('');
        const [body, setBody] = useState('');
        const [model, setModel] = useState('');
        const [tools, setTools] = useState('');
        const [disallowedTools, setDisallowedTools] = useState('');
        const [maxTurns, setMaxTurns] = useState('');
        const [permissionMode, setPermissionMode] = useState('');
        const [memory, setMemory] = useState('');
        const [skills, setSkills] = useState('');
        const [hooksYaml, setHooksYaml] = useState('');
        const [displayName, setDisplayName] = useState('');
        const [icon, setIcon] = useState('');
        const [color, setColor] = useState('');

        const nameInputRef = useRef<HTMLInputElement>(null);
        const [focusField, setFocusField] = useState<'name' | 'description' | 'body' | null>(null);

        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load agent data
        useEffect(() => {
            const loadAgent = async () => {
                setLoading(true);
                try {
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const response = await api.get<{ success: boolean; agent: AgentDetail; error?: string }>(
                        `/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                    );
                    if (response.success && response.agent) {
                        setAgent(response.agent);
                        const fm = response.agent.frontmatter;
                        const nameVal = fm.name || name;
                        const desc = fm.description || '';
                        const bd = response.agent.body || '';
                        const mdl = fm.model || '';
                        const tls = fm.tools || '';
                        const dtls = fm.disallowedTools || '';
                        const mt = fm.maxTurns !== undefined ? String(fm.maxTurns) : '';
                        const pm = fm.permissionMode || '';
                        const mem = fm.memory || '';
                        const sk = fm.skills ? fm.skills.join(', ') : '';
                        const hk = fm.hooks ? yamlDump(fm.hooks, { lineWidth: -1 }).trim() : '';
                        const dn = response.agent.meta?.displayName || '';
                        const ic = response.agent.meta?.icon || '';
                        const cl = response.agent.meta?.color || '';

                        setAgentName(nameVal); setOriginalAgentName(nameVal);
                        setDescription(desc); setOriginalDescription(desc);
                        setBody(bd); setOriginalBody(bd);
                        setModel(mdl); setOriginalModel(mdl);
                        setTools(tls); setOriginalTools(tls);
                        setDisallowedTools(dtls); setOriginalDisallowedTools(dtls);
                        setMaxTurns(mt); setOriginalMaxTurns(mt);
                        setPermissionMode(pm); setOriginalPermissionMode(pm);
                        setMemory(mem); setOriginalMemory(mem);
                        setSkills(sk); setOriginalSkills(sk);
                        setHooksYaml(hk); setOriginalHooksYaml(hk);
                        setDisplayName(dn); setOriginalDisplayName(dn);
                        setIcon(ic); setOriginalIcon(ic);
                        setColor(cl); setOriginalColor(cl);

                        if (startInEditMode) setIsEditing(true);
                    } else {
                        toastRef.current.error(response.error || '加载失败');
                    }
                } catch {
                    toastRef.current.error('加载失败');
                } finally {
                    setLoading(false);
                }
            };
            loadAgent();
        }, [name, scope, agentDir, startInEditMode, api, isInTabContext]);

        const handleEdit = useCallback((field?: 'name' | 'description' | 'body') => {
            setFocusField(field || 'name');
            setIsEditing(true);
        }, []);

        useEffect(() => {
            if (isEditing && focusField && focusField !== 'body') {
                const timer = setTimeout(() => {
                    if (focusField === 'name') nameInputRef.current?.focus();
                    setFocusField(null);
                }, 0);
                return () => clearTimeout(timer);
            }
        }, [isEditing, focusField]);

        const handleCancel = useCallback(async () => {
            if (isNewAgent) {
                try {
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    await api.delete<{ success: boolean }>(`/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`);
                } catch { /* ignore */ }
                onDeleted();
            } else {
                setAgentName(originalAgentName);
                setDescription(originalDescription);
                setBody(originalBody);
                setModel(originalModel);
                setTools(originalTools);
                setDisallowedTools(originalDisallowedTools);
                setMaxTurns(originalMaxTurns);
                setPermissionMode(originalPermissionMode);
                setMemory(originalMemory);
                setSkills(originalSkills);
                setHooksYaml(originalHooksYaml);
                setDisplayName(originalDisplayName);
                setIcon(originalIcon);
                setColor(originalColor);
                setIsEditing(false);
            }
        }, [isNewAgent, name, scope, agentDir, originalAgentName, originalDescription, originalBody, originalModel, originalTools, originalDisallowedTools, originalMaxTurns, originalPermissionMode, originalMemory, originalSkills, originalHooksYaml, originalDisplayName, originalIcon, originalColor, onDeleted, api, isInTabContext]);

        const expectedFolderName = agentName.trim() ? sanitizeFolderName(agentName.trim()) : '';

        const handleSave = useCallback(async () => {
            if (!agent) return;
            if (!agentName.trim()) {
                toastRef.current.error('Agent 名称不能为空');
                return;
            }
            setSaving(true);
            try {
                const frontmatter: Partial<AgentFrontmatter> = {
                    name: agentName.trim(),
                    description,
                };

                if (model) frontmatter.model = model as AgentFrontmatter['model'];
                if (tools) frontmatter.tools = tools;
                if (disallowedTools) frontmatter.disallowedTools = disallowedTools;
                if (maxTurns) frontmatter.maxTurns = parseInt(maxTurns, 10) || undefined;
                if (permissionMode) frontmatter.permissionMode = permissionMode;
                if (memory) frontmatter.memory = memory;
                if (skills.trim()) {
                    frontmatter.skills = skills.split(',').map(s => s.trim()).filter(Boolean);
                }
                if (hooksYaml.trim()) {
                    try {
                        frontmatter.hooks = yamlLoad(hooksYaml) as Record<string, unknown>;
                    } catch {
                        toastRef.current.error('Hooks YAML 格式错误');
                        setSaving(false);
                        return;
                    }
                }

                const newFolderName = sanitizeFolderName(agentName.trim());
                const nameWasModified = agentName.trim() !== originalAgentName;
                const shouldRename = nameWasModified && newFolderName && newFolderName !== agent.folderName;

                // Build meta if any meta fields are set
                const meta: AgentMeta = {};
                if (displayName.trim()) meta.displayName = displayName.trim();
                if (icon.trim()) meta.icon = icon.trim();
                if (color.trim()) meta.color = color.trim();
                const hasMeta = Object.keys(meta).length > 0;

                const payload = isInTabContext
                    ? { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}), ...(hasMeta ? { meta } : {}) }
                    : { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}), ...(scope === 'project' && agentDir ? { agentDir } : {}), ...(hasMeta ? { meta } : {}) };

                const response = await api.put<{
                    success: boolean;
                    error?: string;
                    folderName?: string;
                }>(`/api/agent/${encodeURIComponent(name)}`, payload);

                if (response.success) {
                    toastRef.current.success('保存成功');
                    setIsEditing(false);
                    setIsNewAgent(false);
                    setOriginalAgentName(agentName.trim());
                    setOriginalDescription(description);
                    setOriginalBody(body);
                    setOriginalModel(model);
                    setOriginalTools(tools);
                    setOriginalDisallowedTools(disallowedTools);
                    setOriginalMaxTurns(maxTurns);
                    setOriginalPermissionMode(permissionMode);
                    setOriginalMemory(memory);
                    setOriginalSkills(skills);
                    setOriginalHooksYaml(hooksYaml);
                    setOriginalDisplayName(displayName);
                    setOriginalIcon(icon);
                    setOriginalColor(color);

                    if (shouldRename && response.folderName) {
                        onSaved(true);
                    } else {
                        onSaved();
                    }
                } else {
                    toastRef.current.error(response.error || '保存失败');
                }
            } catch {
                toastRef.current.error('保存失败');
            } finally {
                setSaving(false);
            }
        }, [agent, agentName, description, body, model, tools, disallowedTools, maxTurns, permissionMode, memory, skills, hooksYaml, displayName, icon, color, name, scope, agentDir, originalAgentName, onSaved, api, isInTabContext]);

        const handleDelete = useCallback(async () => {
            if (!agent) return;
            setDeleting(true);
            try {
                const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                const response = await api.delete<{ success: boolean; error?: string }>(
                    `/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                );
                if (response.success) {
                    toastRef.current.success('已删除');
                    onDeleted();
                } else {
                    toastRef.current.error(response.error || '删除失败');
                }
            } catch {
                toastRef.current.error('删除失败');
            } finally {
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }, [agent, name, scope, agentDir, onDeleted, api, isInTabContext]);

        if (loading) {
            return (
                <div className="flex h-64 items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (!agent) {
            return (
                <div className="flex h-64 items-center justify-center text-[var(--ink-muted)]">
                    Agent 未找到
                </div>
            );
        }

        // Preview mode
        if (!isEditing) {
            return (
                <div className="flex h-full flex-col">
                    {/* Header */}
                    <div className="border-b border-[var(--line)] px-6 py-4">
                        <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                                <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{agentName}</h2>
                                {description && (
                                    <p className="mt-1 text-sm text-[var(--ink-muted)]">{description}</p>
                                )}
                            </div>
                            <div className="ml-4 flex items-center gap-2">
                                <button
                                    onClick={() => handleEdit()}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                                <button
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                        {/* Badges */}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {model && (
                                <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    模型: {model || 'inherit'}
                                </span>
                            )}
                            {permissionMode && (
                                <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    权限: {permissionMode}
                                </span>
                            )}
                            {memory && (
                                <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    记忆: {memory}
                                </span>
                            )}
                            {tools && (
                                <span className="rounded-full bg-[var(--paper-contrast)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    工具: {tools}
                                </span>
                            )}
                        </div>
                    </div>
                    {/* Body preview */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4">
                        {body ? (
                            <div className="prose prose-sm max-w-none text-[var(--ink)]" onClick={() => handleEdit('body')}>
                                <Markdown>{body}</Markdown>
                            </div>
                        ) : (
                            <p className="text-sm italic text-[var(--ink-muted)]">暂无 System Prompt</p>
                        )}
                    </div>

                    {showDeleteConfirm && (
                        <ConfirmDialog
                            title="删除 Agent"
                            message={scope === 'user'
                                ? `确定要删除 "${agentName}" 吗？引用此 Agent 的项目将受到影响，此操作不可恢复。`
                                : `确定要删除 "${agentName}" 吗？此操作不可恢复。`}
                            confirmText="删除"
                            cancelText="取消"
                            confirmVariant="danger"
                            onConfirm={handleDelete}
                            onCancel={() => setShowDeleteConfirm(false)}
                            loading={deleting}
                        />
                    )}
                </div>
            );
        }

        // Edit mode
        return (
            <div className="flex h-full flex-col">
                {/* Edit Header */}
                <div className="border-b border-[var(--line)] px-6 py-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-[var(--ink-muted)]">编辑 Agent</span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleCancel}
                                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                            >
                                <X className="h-3.5 w-3.5" />
                                取消
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                            >
                                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                保存
                            </button>
                        </div>
                    </div>
                </div>

                {/* Edit Form */}
                <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4 space-y-4">
                    {/* Name */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">名称</label>
                        <input
                            ref={nameInputRef}
                            type="text"
                            value={agentName}
                            onChange={e => setAgentName(e.target.value)}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                            placeholder="Agent 名称"
                        />
                        {/* Folder name hint */}
                        {agentName.trim() && expectedFolderName !== name && (
                            <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                文件夹将重命名为: {expectedFolderName}
                            </p>
                        )}
                    </div>

                    {/* Display Name */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">显示名称</label>
                        <input
                            type="text"
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                            placeholder="在 UI 中显示的名称（留空使用 name）"
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">描述</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none resize-none"
                            placeholder="描述 Agent 的职责和使用场景（模型据此决定何时委派）"
                        />
                    </div>

                    {/* Icon & Color */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">图标 (lucide)</label>
                            <input
                                type="text"
                                value={icon}
                                onChange={e => setIcon(e.target.value)}
                                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                placeholder="shield-check"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">主题色</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={color}
                                    onChange={e => setColor(e.target.value)}
                                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                    placeholder="#4CAF50"
                                />
                                {color && (
                                    <div
                                        className="h-8 w-8 shrink-0 rounded-md border border-[var(--line)]"
                                        style={{ backgroundColor: color }}
                                    />
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Model */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">模型</label>
                        <select
                            value={model}
                            onChange={e => setModel(e.target.value)}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                        >
                            <option value="">继承主模型 (inherit)</option>
                            <option value="sonnet">Sonnet</option>
                            <option value="opus">Opus</option>
                            <option value="haiku">Haiku</option>
                        </select>
                    </div>

                    {/* System Prompt */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">System Prompt</label>
                        <div className="overflow-hidden rounded-lg border border-[var(--line)]" style={{ height: '300px' }}>
                            <MonacoEditor
                                value={body}
                                onChange={setBody}
                                language="markdown"
                                autoFocus={focusField === 'body'}
                            />
                        </div>
                    </div>

                    {/* Advanced Section */}
                    <div className="border-t border-[var(--line)] pt-4">
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="flex w-full items-center justify-between text-sm font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <span>高级设置</span>
                            {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>

                        {showAdvanced && (
                            <div className="mt-4 space-y-4">
                                {/* Tools */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">允许的工具 (逗号分隔)</label>
                                    <input
                                        type="text"
                                        value={tools}
                                        onChange={e => setTools(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                        placeholder="Read, Grep, Glob, Bash"
                                    />
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        留空则继承主 Agent 的所有工具
                                    </p>
                                </div>

                                {/* Disallowed Tools */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">禁用的工具 (逗号分隔)</label>
                                    <input
                                        type="text"
                                        value={disallowedTools}
                                        onChange={e => setDisallowedTools(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                        placeholder="Edit, Write"
                                    />
                                </div>

                                {/* Permission Mode */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">权限模式</label>
                                    <select
                                        value={permissionMode}
                                        onChange={e => setPermissionMode(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                    >
                                        <option value="">默认 (default)</option>
                                        <option value="default">default</option>
                                        <option value="acceptEdits">acceptEdits</option>
                                        <option value="bypassPermissions">bypassPermissions</option>
                                        <option value="plan">plan</option>
                                    </select>
                                </div>

                                {/* Max Turns */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">最大轮数</label>
                                    <input
                                        type="number"
                                        value={maxTurns}
                                        onChange={e => setMaxTurns(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                        placeholder="留空使用默认值"
                                        min={1}
                                    />
                                </div>

                                {/* Memory */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">持久记忆</label>
                                    <select
                                        value={memory}
                                        onChange={e => setMemory(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                    >
                                        <option value="">无</option>
                                        <option value="user">user (用户级)</option>
                                        <option value="project">project (项目级)</option>
                                        <option value="local">local (本地)</option>
                                    </select>
                                </div>

                                {/* Skills */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">预加载 Skills (逗号分隔)</label>
                                    <input
                                        type="text"
                                        value={skills}
                                        onChange={e => setSkills(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                        placeholder="api-conventions, error-handling"
                                    />
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        Skill 名称列表，完整内容注入 Agent 上下文
                                    </p>
                                </div>

                                {/* Hooks */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">Hooks (YAML)</label>
                                    <div className="overflow-hidden rounded-lg border border-[var(--line)]" style={{ height: '150px' }}>
                                        <MonacoEditor
                                            value={hooksYaml}
                                            onChange={setHooksYaml}
                                            language="yaml"
                                        />
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        生命周期钩子: PreToolUse, PostToolUse, Stop
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {showDeleteConfirm && (
                    <ConfirmDialog
                        title="删除 Agent"
                        message={scope === 'user'
                            ? `确定要删除 "${agentName}" 吗？引用此 Agent 的项目将受到影响，此操作不可恢复。`
                            : `确定要删除 "${agentName}" 吗？此操作不可恢复。`}
                        confirmText="删除"
                        cancelText="取消"
                        confirmVariant="danger"
                        onConfirm={handleDelete}
                        onCancel={() => setShowDeleteConfirm(false)}
                        loading={deleting}
                    />
                )}
            </div>
        );
    }
);

export default AgentDetailPanel;
