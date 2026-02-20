import { AlertTriangle, ArrowLeft, History, Loader2, Plus, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { track } from '@/analytics';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import DirectoryPanel, { type DirectoryPanelHandle } from '@/components/DirectoryPanel';
import DropZoneOverlay from '@/components/DropZoneOverlay';
import MessageList from '@/components/MessageList';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import { FileActionProvider } from '@/context/FileActionContext';
import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import WorkspaceConfigPanel, { type Tab as WorkspaceTab } from '@/components/WorkspaceConfigPanel';
import CronTaskSettingsModal from '@/components/cron/CronTaskSettingsModal';
import { useTabState, useTabActive } from '@/context/TabContext';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useConfig } from '@/hooks/useConfig';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { useCronTask } from '@/hooks/useCronTask';
import { getSessionCronTask, updateCronTaskTab, isTaskExecuting } from '@/api/cronTaskClient';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { type PermissionMode, type McpServerDefinition } from '@/config/types';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
} from '@/config/configService';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import type { InitialMessage } from '@/types/tab';
// CronTaskConfig type is used via useCronTask hook

interface ChatProps {
  onBack?: () => void;
  /** Called when user starts a new session. Returns true if handled externally (background completion started). */
  onNewSession?: () => Promise<boolean>;
  /** Called when user selects a different session from history - uses Session singleton logic */
  onSwitchSession?: (sessionId: string) => void;
  /** Initial message from Launcher for auto-send on workspace open */
  initialMessage?: InitialMessage;
  /** Called after initialMessage has been consumed */
  onInitialMessageConsumed?: () => void;
  /** Tab joined an already-running sidecar (e.g. IM Bot session) — skip config push, adopt sidecar config */
  joinedExistingSidecar?: boolean;
  /** Called after sidecar config has been adopted */
  onJoinedExistingSidecarHandled?: () => void;
}

export default function Chat({ onBack, onNewSession, onSwitchSession, initialMessage, onInitialMessageConsumed, joinedExistingSidecar, onJoinedExistingSidecarHandled }: ChatProps) {
  // Get state from TabContext (required - Chat must be inside TabProvider)
  const {
    tabId,
    agentDir,
    sessionId,
    messages,
    isLoading,
    sessionState,
    unifiedLogs,
    systemInitInfo: _systemInitInfo,
    agentError,
    systemStatus,
    pendingPermission,
    pendingAskUserQuestion,
    toolCompleteCount,
    setMessages,
    setIsLoading,
    setAgentError,
    connectSse,
    disconnectSse,
    sendMessage,
    stopResponse,
    loadSession,
    resetSession,
    clearUnifiedLogs,
    respondPermission,
    respondAskUserQuestion,
    apiPost,
    apiGet,
    setSessionState,
    onCronTaskExitRequested,
    queuedMessages,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
    isConnected,
  } = useTabState();
  const isActive = useTabActive();
  const toast = useToast();

  // Get config to find current project provider
  const { config, projects, providers, patchProject, apiKeys, providerVerifyStatus, refreshProviderData } = useConfig();
  const currentProject = projects.find((p) => p.path === agentDir);
  const currentProvider = currentProject?.providerId
    ? providers.find((p) => p.id === currentProject.providerId)
    : providers[0]; // Default to first provider

  // PERFORMANCE: Ref-stabilize object deps used in handleSendMessage
  // Prevents useCallback from creating new references when these objects change,
  // which would defeat SimpleChatInput's memo.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;

  // PERFORMANCE: inputValue is now managed internally by SimpleChatInput
  // to avoid re-rendering Chat (and MessageList) on every keystroke
  const [showLogs, setShowLogs] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(true); // Workspace panel visibility
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false); // Workspace config panel
  const [workspaceRefreshKey, _setWorkspaceRefreshKey] = useState(0); // Key to trigger workspace refresh
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    currentProject?.permissionMode ?? 'auto'
  );
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentProject?.model ?? currentProvider?.primaryModel
  );
  // Cron task state
  const [showCronSettings, setShowCronSettings] = useState(false);
  const [cronPrompt, setCronPrompt] = useState('');

  // Startup overlay state (for auto-send from Launcher)
  const [showStartupOverlay, setShowStartupOverlay] = useState(!!initialMessage);

  // Time rewind state
  const [rewindTarget, setRewindTarget] = useState<{
    messageId: string;
    content: string;
    attachments?: import('@/types/chat').MessageAttachment[];
  } | null>(null);
  const [rewindStatus, setRewindStatus] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Refs for one-time project settings sync (see effect after provider change effect)
  const hadInitialMessage = useRef(!!initialMessage);
  const projectSyncedRef = useRef(false);

  // Ref for input focus
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref for SimpleChatInput to call processDroppedFiles
  const chatInputRef = useRef<SimpleChatInputHandle>(null);

  // Ref for DirectoryPanel to trigger refresh
  const directoryPanelRef = useRef<DirectoryPanelHandle>(null);

  // Ref for tracking previous isActive state (for config sync on tab switch)
  const prevIsActiveRef = useRef(isActive);

  // Track whether we're joining an existing sidecar (e.g. IM Bot session)
  // When true, mount effects skip config push and adopt sidecar's config instead.
  const joinedExistingSidecarRef = useRef(joinedExistingSidecar ?? false);
  joinedExistingSidecarRef.current = joinedExistingSidecar ?? false;

  // Ref for chat content area (for Tauri drop zone)
  const chatContentRef = useRef<HTMLDivElement>(null);

  // Ref for directory panel container (for Tauri drop zone)
  const directoryPanelContainerRef = useRef<HTMLDivElement>(null);

  // State to trigger workspace refresh
  const [workspaceRefreshTrigger, setWorkspaceRefreshTrigger] = useState(0);

  // Enabled sub-agents for sidebar display
  const [enabledAgents, setEnabledAgents] = useState<Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project' }> | undefined>();
  // Enabled skills/commands for sidebar display
  const [enabledSkills, setEnabledSkills] = useState<Array<{ name: string; description: string; scope?: 'user' | 'project' }>>([]);
  const [enabledCommands, setEnabledCommands] = useState<Array<{ name: string; description: string; scope?: 'user' | 'project' }>>([]);
  // Initial tab for workspace config panel (set when opening from capabilities panel)
  const [workspaceConfigInitialTab, setWorkspaceConfigInitialTab] = useState<WorkspaceTab | undefined>();

  // Callback to refresh workspace (exposed to SimpleChatInput)
  const triggerWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshTrigger(prev => prev + 1);
  }, []);

  // Stable callbacks for DirectoryPanel → AgentCapabilitiesPanel
  const handleInsertReference = useCallback((paths: string[]) => {
    chatInputRef.current?.insertReferences(paths);
  }, []);

  const handleInsertSlashCommand = useCallback((command: string) => {
    chatInputRef.current?.insertSlashCommand(command);
  }, []);

  const handleOpenSettings = useCallback((tab: Extract<WorkspaceTab, 'skills-commands' | 'agents'>) => {
    setWorkspaceConfigInitialTab(tab);
    setShowWorkspaceConfig(true);
  }, []);

  // Auto-send initial message from Launcher
  const initialMessageConsumedRef = useRef(false);
  const onInitialMessageConsumedRef = useRef(onInitialMessageConsumed);
  onInitialMessageConsumedRef.current = onInitialMessageConsumed;

  useEffect(() => {
    if (!initialMessage || initialMessageConsumedRef.current) return;
    // Wait for SSE connection (sidecar reachable) instead of non-pending sessionId.
    // The sessionId upgrades from pending only after the first message is processed,
    // but the first message IS the auto-send — so checking isPendingSessionId would deadlock.
    if (!isActive || !sessionId || !isConnected) return;

    initialMessageConsumedRef.current = true;

    const autoSend = async () => {
      try {
        // 1. Sync MCP configuration
        if (initialMessage.mcpEnabledServers?.length) {
          const allServers = await getAllMcpServers();
          const globalEnabled = await getEnabledMcpServerIds();
          const effective = allServers.filter(s =>
            globalEnabled.includes(s.id) && initialMessage.mcpEnabledServers!.includes(s.id)
          );
          await apiPost('/api/mcp/set', { servers: effective });
        }

        // 2. Compute effective values BEFORE setState (avoid stale closure)
        const effectivePermission = initialMessage.permissionMode ?? permissionMode;
        const effectiveModel = initialMessage.model ?? selectedModel;

        // 3. Update local UI state to reflect Launcher choices
        if (initialMessage.permissionMode) setPermissionMode(initialMessage.permissionMode);
        if (initialMessage.model) setSelectedModel(initialMessage.model);

        // 4. Build providerEnv locally from providerId (never stored in Tab state for security)
        const provider = initialMessage.providerId
          ? providers.find(p => p.id === initialMessage.providerId) ?? currentProvider
          : currentProvider;
        const providerEnv = provider && provider.type !== 'subscription' ? {
          baseUrl: provider.config.baseUrl,
          apiKey: apiKeys[provider.id],
          authType: provider.authType,
        } : undefined;

        // 5. Send message
        setIsLoading(true);
        scrollToBottom();
        await sendMessage(
          initialMessage.text,
          initialMessage.images,
          effectivePermission,
          effectiveModel,
          providerEnv
        );

        // 6. Hide overlay
        setShowStartupOverlay(false);
        onInitialMessageConsumedRef.current?.();
      } catch (err) {
        console.error('[Chat] Auto-send failed:', err);
        setShowStartupOverlay(false);
        onInitialMessageConsumedRef.current?.();
        toast.error('发送失败，请重试');
      }
    };
    void autoSend();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, isActive, sessionId, isConnected]);

  // Safety timeout for startup overlay (30s)
  useEffect(() => {
    if (!showStartupOverlay) return;
    const t = setTimeout(() => setShowStartupOverlay(false), 30000);
    return () => clearTimeout(t);
  }, [showStartupOverlay]);

  // Cron task management hook
  const {
    state: cronState,
    enableCronMode,
    disableCronMode,
    updateConfig: _updateCronConfig,
    updateRunningConfig,
    startTask: startCronTask,
    stop: stopCronTask,
    restoreFromTask: restoreCronTask,
    updateSessionId: updateCronTaskSessionId,
  } = useCronTask({
    workspacePath: agentDir,
    sessionId: sessionId ?? '',
    tabId,
    onExecute: async (_taskId, prompt, _isFirstExecution, _aiCanExit) => {
      // Send cron task message
      // Note: taskId, isFirstExecution, aiCanExit are available for future enhancements
      // (e.g., injecting cron context into system prompt)
      const providerEnv = currentProvider && currentProvider.type !== 'subscription' ? {
        baseUrl: currentProvider.config.baseUrl,
        apiKey: apiKeys[currentProvider.id],
        authType: currentProvider.authType,
      } : undefined;
      await sendMessage(prompt, undefined, permissionMode, selectedModel, providerEnv, true /* isCron */);
    },
    onComplete: (task, reason) => {
      console.log('[Chat] Cron task completed:', task.id, reason);
    },
    onExecutionComplete: async (task, success) => {
      // Called when a single execution completes (task may still be running)
      // Refresh the session to show the latest messages
      // Use task.sessionId (the cron task's actual session) instead of Chat's sessionId
      // which may be a pending/different session
      console.log('[Chat] Cron execution complete, refreshing session:', task.id, task.executionCount, 'taskSessionId:', task.sessionId, 'success:', success);
      setIsLoading(false);
      // Only refresh session on successful execution.
      // On timeout (success=false), the original streaming task may still be running
      // and calling loadSession would abort it (via switchToSession) and lose data.
      if (success && task.sessionId) {
        await loadSession(task.sessionId);
      }
    },
    // Register for SSE cron:task-exit-requested events via TabContext
    onCronTaskExitRequestedRef: onCronTaskExitRequested,
  });

  // PERFORMANCE: Ref-stabilize cronState for handleSendMessage
  const cronStateRef = useRef(cronState);
  cronStateRef.current = cronState;

  // Sync cron task's sessionId when session is created after task creation
  // This handles two cases:
  // 1. Task has empty sessionId (legacy) - needs to be updated
  // 2. Task has pending sessionId (pending-xxx) and real sessionId is now available
  const sessionIdSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    const task = cronState.task;
    if (!task || !sessionId) return;

    // Skip if sessionId is still pending (no real session ID yet)
    if (isPendingSessionId(sessionId)) return;

    // If task has empty or pending sessionId but we now have a real sessionId, update the task
    // Use ref to prevent duplicate updates for the same sessionId
    const taskNeedsUpdate = task.sessionId === '' || isPendingSessionId(task.sessionId);
    if (taskNeedsUpdate && sessionIdSyncedRef.current !== sessionId) {
      sessionIdSyncedRef.current = sessionId;
      console.log(`[Chat] Syncing cron task sessionId: taskId=${task.id}, oldSessionId=${task.sessionId}, newSessionId=${sessionId}`);
      void updateCronTaskSessionId(sessionId);
    }
  }, [cronState.task, sessionId, updateCronTaskSessionId]);

  // File drop zone for chat area (HTML5 drag-drop for non-Tauri/development)
  const handleFileDrop = useCallback((files: File[]) => {
    chatInputRef.current?.processDroppedFiles(files);
  }, []);

  const { isDragActive, dragHandlers } = useFileDropZone({
    onFilesDropped: handleFileDrop,
  });

  // Handle Tauri file drop on chat area (copy to myagents_files + insert reference)
  const handleTauriChatDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on chat area:', paths);
    }
    // Use the SimpleChatInput's method to process file paths
    await chatInputRef.current?.processDroppedFilePaths?.(paths);
    // Refresh workspace to show new files
    triggerWorkspaceRefresh();
  }, [triggerWorkspaceRefresh]);

  // Handle Tauri file drop on directory panel
  const handleTauriDirectoryDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on directory panel:', paths);
    }
    // DirectoryPanel handles this internally now
    await directoryPanelRef.current?.handleFileDrop(paths);
  }, []);

  // Use refs to avoid recreating onDrop callback when handlers change
  const handleTauriChatDropRef = useRef(handleTauriChatDrop);
  const handleTauriDirectoryDropRef = useRef(handleTauriDirectoryDrop);
  useEffect(() => {
    handleTauriChatDropRef.current = handleTauriChatDrop;
    handleTauriDirectoryDropRef.current = handleTauriDirectoryDrop;
  }, [handleTauriChatDrop, handleTauriDirectoryDrop]);

  const { isDragging: isTauriDragging, activeZoneId, registerZone, unregisterZone } = useTauriFileDrop({
    onDrop: (paths, zoneId) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop event - zoneId:', zoneId, 'paths:', paths);
      }
      if (zoneId === 'chat-content') {
        void handleTauriChatDropRef.current(paths);
      } else if (zoneId === 'directory-panel') {
        void handleTauriDirectoryDropRef.current(paths);
      } else {
        // Default: drop to chat area
        void handleTauriChatDropRef.current(paths);
      }
    },
  });

  // Register drop zones for Tauri (only for position detection, handlers are in onDrop above)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    // Register chat content drop zone (empty callback - handled in global onDrop)
    registerZone('chat-content', chatContentRef.current, () => {});

    // Register directory panel drop zone (empty callback - handled in global onDrop)
    registerZone('directory-panel', directoryPanelContainerRef.current, () => {});

    return () => {
      unregisterZone('chat-content');
      unregisterZone('directory-panel');
    };
  }, [registerZone, unregisterZone]);

  // Combined drag active state (HTML5 or Tauri)
  const isAnyDragActive = isDragActive || isTauriDragging;

  // MCP state
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);
  const [workspaceMcpEnabled, setWorkspaceMcpEnabled] = useState<string[]>(
    currentProject?.mcpEnabledServers ?? []
  );

  // Track which session's cron task state has been loaded
  const cronLoadedSessionRef = useRef<string | null>(null);

  // Track if we need to set loading state after TabProvider's loadSession completes
  // This is used when restoring a cron task that is currently executing
  const pendingCronLoadingRef = useRef(false);

  // Track previous messages reference to detect when loadSession completes
  // Using reference comparison instead of length to handle edge case where
  // message count stays the same after loadSession
  const prevMessagesRef = useRef(messages);

  // Restore or clear cron task state when session changes
  // 方案 A: Rust 统一恢复 - Scheduler 由 Rust 层 initialize_cron_manager 自动恢复
  // 前端只负责同步 UI 状态
  //
  // This handles:
  // 1. App restart recovery - restore cron task UI for running/paused tasks
  //    (Scheduler already started by Rust layer)
  // 2. Tab re-open - reconnect to existing cron task
  // 3. Session switch - clear cron state if switching to a session without cron task
  useEffect(() => {
    if (!sessionId || !tabId || !isTauriEnvironment()) return;

    // Skip if already loaded for this session
    if (cronLoadedSessionRef.current === sessionId) return;

    const loadCronTaskState = async () => {
      try {
        const task = await getSessionCronTask(sessionId);

        if (task && task.status === 'running') {
          console.log('[Chat] Restoring cron task UI for session:', sessionId, task.id, 'to tab:', tabId);

          // Update task's tabId to this new tab
          await updateCronTaskTab(task.id, tabId);

          // Restore UI state only - Scheduler is managed by Rust layer (方案 A)
          // Do NOT call startCronScheduler here to avoid duplicate scheduler starts
          restoreCronTask(task);

          // Check if task is currently executing (e.g., execution started before app restart)
          // If executing, mark it so we can set loading state after TabProvider's loadSession completes
          // NOTE: Do NOT call loadSession here - TabProvider already handles session loading
          // Calling it here causes infinite loop with TabProvider's session loading effect
          const executing = await isTaskExecuting(task.id);
          if (executing) {
            console.log('[Chat] Cron task is currently executing, marking for loading state');
            pendingCronLoadingRef.current = true;
          }
        } else if (cronState.task && cronState.task.sessionId && cronState.task.sessionId !== sessionId) {
          // Current cron state is for a different session - clear FRONTEND state only
          // This happens when user switches from a cron-task session to a regular session
          // Note: Only clear if cronState.task.sessionId is NOT empty (empty means task was just created)
          //
          // IMPORTANT: We do NOT call stopCronTask() here because:
          // 1. The task should continue running for its original session
          // 2. The Rust scheduler executes on session-specific Sidecar
          // 3. When user goes back to the original session, state will be restored (above code)
          // 4. Per PRD: "暂停后允许手动对话" - task continues while user interacts with other sessions
          //
          // EXCEPTION: Don't clear if this is a pending -> real session ID upgrade (same cron task!)
          // This happens when SDK creates the real session after first message
          const isSessionUpgrade = isPendingSessionId(cronState.task.sessionId) && !isPendingSessionId(sessionId);
          if (isSessionUpgrade) {
            console.log('[Chat] Session ID upgraded from pending to real, keeping cron state:', cronState.task.sessionId, '->', sessionId);
          } else {
            console.log('[Chat] Clearing frontend cron state (session changed from', cronState.task.sessionId, 'to', sessionId, ')');
            disableCronMode();
          }
        }

        cronLoadedSessionRef.current = sessionId;
      } catch (error) {
        console.error('[Chat] Failed to load cron task state:', error);
      }
    };

    void loadCronTaskState();
  }, [sessionId, tabId, restoreCronTask, disableCronMode, cronState.task, setIsLoading]);

  // Set loading state after TabProvider's loadSession completes (for cron task executing scenario)
  // This effect watches for messages reference changes, which indicates loadSession has completed
  // Using reference comparison (not length) to handle edge case where message count stays the same
  useEffect(() => {
    // Only proceed if we have pending cron loading and messages array has changed
    if (pendingCronLoadingRef.current && messages !== prevMessagesRef.current) {
      console.log('[Chat] loadSession completed, setting loading state for cron execution');
      setIsLoading(true);
      pendingCronLoadingRef.current = false;
    }
    prevMessagesRef.current = messages;
  }, [messages, setIsLoading]);

  // Load MCP config on mount and sync to backend
  useEffect(() => {
    const loadMcpConfig = async () => {
      try {
        // When joining an existing sidecar (e.g. IM Bot session), skip pushing Tab's
        // MCP config to avoid overwriting the session's current config.
        // Still load local MCP state for sidebar display.
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        setGlobalMcpEnabled(enabledIds);

        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping MCP push (joined existing sidecar)');
          }
          return;
        }

        // CRITICAL: Always sync effective MCP servers to backend on initial load
        // This ensures the Agent SDK has correct MCP config (including empty = no MCP)
        // Without this, backend currentMcpServers stays null and falls back to file config
        const workspaceEnabled = currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );

        // Always call /api/mcp/set, even with empty array
        // Empty array means "user explicitly disabled all MCP"
        // null (not calling) means "use file config fallback" - which we don't want
        await apiPost('/api/mcp/set', { servers: effectiveServers });
        if (isDebugMode()) {
          console.log('[Chat] Initial MCP sync:', effectiveServers.map(s => s.id).join(', ') || 'none');
        }
      } catch (err) {
        console.error('[Chat] Failed to load MCP config:', err);
      }
    };
    loadMcpConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only reload when project MCP config changes
  }, [currentProject?.mcpEnabledServers]);

  // Load enabled agents and sync to backend
  const loadAndSyncAgents = useCallback(async () => {
    try {
      const response = await apiGet<{ success: boolean; agents: Record<string, { description: string; prompt: string; model?: string; scope?: 'user' | 'project' }> }>('/api/agents/enabled');
      if (response.success && response.agents) {
        setEnabledAgents(response.agents);
        // Skip push when joining existing sidecar to avoid overwriting session config
        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping agents push (joined existing sidecar)');
          }
          return;
        }
        // Sync to backend for SDK injection
        await apiPost('/api/agents/set', { agents: response.agents });
        if (isDebugMode()) {
          console.log('[Chat] Agents synced:', Object.keys(response.agents).join(', ') || 'none');
        }
      }
    } catch (err) {
      console.error('[Chat] Failed to load agents:', err);
    }
  }, [apiGet, apiPost]);

  // Load skills/commands for sidebar display
  const loadSkillsAndCommands = useCallback(async () => {
    try {
      const response = await apiGet<{ success: boolean; commands: Array<{ name: string; description: string; source: string; scope?: 'user' | 'project' }> }>('/api/commands');
      if (response.success && response.commands) {
        setEnabledSkills(response.commands.filter(c => c.source === 'skill').map(c => ({ name: c.name, description: c.description, scope: c.scope })));
        setEnabledCommands(response.commands.filter(c => c.source === 'custom').map(c => ({ name: c.name, description: c.description, scope: c.scope })));
      }
    } catch (err) {
      console.error('[Chat] Failed to load skills/commands:', err);
    }
  }, [apiGet]);

  // Load capabilities on mount and when workspace config changes (e.g. skill copied, settings saved)
  useEffect(() => {
    loadAndSyncAgents();
    loadSkillsAndCommands();
  }, [loadAndSyncAgents, loadSkillsAndCommands, workspaceRefreshTrigger]);

  // Sync workspace MCP to project config when it changes
  useEffect(() => {
    if (currentProject?.mcpEnabledServers) {
      setWorkspaceMcpEnabled(currentProject.mcpEnabledServers);
    }
  }, [currentProject?.mcpEnabledServers]);

  // Handle workspace MCP toggle — persist via patchProject (updates disk + React state)
  const handleWorkspaceMcpToggle = useCallback(async (serverId: string, enabled: boolean) => {
    const newEnabled = enabled
      ? [...workspaceMcpEnabled, serverId]
      : workspaceMcpEnabled.filter(id => id !== serverId);

    setWorkspaceMcpEnabled(newEnabled);

    // Persist to project config (patchProject updates disk AND projects React state,
    // keeping currentProject.mcpEnabledServers in sync for tab-activate sync at L672)
    if (currentProject) {
      void patchProject(currentProject.id, { mcpEnabledServers: newEnabled });
    }

    // Get the effective MCP servers and send to backend
    const effectiveServers = mcpServers.filter(s =>
      globalMcpEnabled.includes(s.id) && newEnabled.includes(s.id)
    );

    try {
      await apiPost('/api/mcp/set', { servers: effectiveServers });
      console.log('[Chat] MCP servers synced:', effectiveServers.map(s => s.id));
    } catch (err) {
      console.error('[Chat] Failed to sync MCP servers:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apiPost is stable, only care about state changes
  }, [workspaceMcpEnabled, currentProject, mcpServers, globalMcpEnabled]);

  // Sync selectedModel when provider changes (skip initial mount to preserve project-stored model)
  const providerInitRef = useRef(true);
  useEffect(() => {
    if (providerInitRef.current) {
      providerInitRef.current = false;
      return;
    }
    if (currentProvider?.primaryModel) {
      setSelectedModel(currentProvider.primaryModel);
    }
  }, [currentProvider?.id, currentProvider?.primaryModel]);

  // One-time sync: apply project-stored settings after useConfig finishes async load.
  // useState initializers run with currentProject=undefined (useConfig loads asynchronously),
  // so project settings must be re-applied once currentProject becomes available.
  // Placed AFTER provider change effect so project model takes priority in same render cycle.
  // Skipped when initialMessage is provided (BrandSection path applies its own settings).
  useEffect(() => {
    if (!currentProject || projectSyncedRef.current || hadInitialMessage.current) return;
    projectSyncedRef.current = true;
    // permissionMode: null means "use global default" (per Project type contract)
    setPermissionMode(currentProject.permissionMode ?? config.defaultPermissionMode);
    // Skip model override when joining existing sidecar — adoption effect will set the correct model
    if (currentProject.model && !joinedExistingSidecarRef.current) {
      setSelectedModel(currentProject.model);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time sync when project first loads
  }, [currentProject?.id]);

  // Sync selectedModel to backend so pre-warm uses the correct model.
  // Without this, backend currentModel stays undefined until the first message,
  // causing a blocking setModel() call during pre-warm → active transition.
  useEffect(() => {
    if (selectedModel) {
      // Skip push when joining existing sidecar — adoption effect will set the correct model
      if (joinedExistingSidecarRef.current) {
        if (isDebugMode()) {
          console.log('[Chat] Skipping model push (joined existing sidecar)');
        }
        return;
      }
      apiPost('/api/model/set', { model: selectedModel }).catch(err => {
        console.error('[Chat] Failed to sync model to backend:', err);
      });
    }
  }, [selectedModel, apiPost]);

  // Adopt sidecar config when joining an existing sidecar (e.g. IM Bot session).
  // Reads the sidecar's current model and applies it to React state so the Tab
  // reflects the session's actual config instead of overwriting it with its own.
  const onJoinedExistingSidecarHandledRef = useRef(onJoinedExistingSidecarHandled);
  onJoinedExistingSidecarHandledRef.current = onJoinedExistingSidecarHandled;
  useEffect(() => {
    if (!joinedExistingSidecar) return;

    const adoptConfig = async () => {
      try {
        const config = await apiGet<{ success: boolean; model?: string | null }>('/api/session/config');
        if (config.success && config.model) {
          setSelectedModel(config.model);
          console.log('[Chat] Adopted sidecar config: model=' + config.model);
        }
      } catch (err) {
        console.error('[Chat] Failed to read sidecar config:', err);
      } finally {
        // Clear the flag whether adoption succeeded or failed
        onJoinedExistingSidecarHandledRef.current?.();
      }
    };

    adoptConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time adoption on mount
  }, [joinedExistingSidecar]);

  const { containerRef: messagesContainerRef, scrollToBottom } = useAutoScroll(isLoading, messages.length, sessionId);

  // Auto-focus input when Tab becomes active
  useEffect(() => {
    if (isActive && inputRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  // Sync config when Tab becomes active (from inactive)
  // This ensures settings changes are picked up when switching back to Chat Tab
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    // Only sync when Tab becomes active (was inactive, now active)
    if (!wasInactive || !isActive) return;

    const syncConfigOnTabActivate = async () => {
      try {
        // 1. Refresh provider data (providers list, API keys, verify status)
        await refreshProviderData();

        // 2. Reload MCP config and sync to backend
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        setGlobalMcpEnabled(enabledIds);

        // Skip MCP push when still in the adoption window (joined existing sidecar)
        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping MCP push on tab activate (joined existing sidecar)');
          }
          return;
        }

        // 3. Sync effective MCP servers to backend for next message
        const workspaceEnabled = currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );
        await apiPost('/api/mcp/set', { servers: effectiveServers });

        if (isDebugMode()) {
          console.log('[Chat] Config synced on tab activate:', {
            providers: providers.length,
            mcpServers: servers.length,
            effectiveMcp: effectiveServers.map(s => s.id).join(', ') || 'none',
          });
        }
      } catch (err) {
        console.error('[Chat] Failed to sync config on tab activate:', err);
      }
    };

    void syncConfigOnTabActivate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providers.length is only used for debug logging
  }, [isActive, refreshProviderData, currentProject?.mcpEnabledServers, apiPost]);

  // Connect SSE when component mounts
  useEffect(() => {
    // Only connect if we have a valid agentDir
    if (!agentDir) return;

    void connectSse();

    // Cleanup: disconnect SSE on unmount
    return () => {
      disconnectSse();
    };
    // connectSse/disconnectSse are stable from TabProvider's useCallback
  }, [agentDir, connectSse, disconnectSse]);

  // Listen for skill copy events to refresh DirectoryPanel (file tree shows .claude/skills/)
  // Note: WorkspaceConfigPanel has its own event listener for internalRefreshKey
  useEffect(() => {
    const handleSkillCopied = () => {
      setWorkspaceRefreshTrigger(k => k + 1);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, []);

  // Handle provider change with analytics tracking
  const handleProviderChange = useCallback((providerId: string) => {
    // Skip if selecting the same provider
    if (currentProject?.providerId === providerId) {
      return;
    }

    // Track provider_switch event
    track('provider_switch', { provider_id: providerId });

    // Update project's provider and reset model to new provider's primary model
    const newProvider = providers.find(p => p.id === providerId);
    if (currentProject) {
      void patchProject(currentProject.id, { providerId, model: newProvider?.primaryModel ?? null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id/.providerId to avoid recreating on unrelated project changes
  }, [currentProject?.id, currentProject?.providerId, patchProject, providers]);

  // Handle model change with analytics tracking and project write-back
  const handleModelChange = useCallback((model: string) => {
    // Skip if selecting the same model
    if (selectedModel === model) {
      return;
    }

    // Track model_switch event
    track('model_switch', { model });

    setSelectedModel(model);
    if (currentProject) {
      void patchProject(currentProject.id, { model });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id to avoid recreating on unrelated project changes
  }, [selectedModel, currentProject?.id, patchProject]);

  // Handle permission mode change with project write-back
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    if (currentProject) {
      void patchProject(currentProject.id, { permissionMode: mode });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id to avoid recreating on unrelated project changes
  }, [currentProject?.id, patchProject]);

  // PERFORMANCE: text is now passed from SimpleChatInput (which manages its own state)
  // This avoids re-rendering Chat on every keystroke.
  // Returns false to signal SimpleChatInput NOT to clear the input (e.g., on rejection).
  const handleSendMessage = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean | void> => {
    // Must have content and not be in stopping state
    if ((!text && (!images || images.length === 0)) || sessionState === 'stopping') {
      return false;
    }

    // Queue limit: max 5 queued messages
    const isAiBusy = isLoading || sessionState === 'running';
    if (isAiBusy && queuedMessages.length >= 5) {
      toastRef.current.warning('最多排队 5 条消息');
      return false;
    }

    // Scroll to bottom immediately so user sees their query
    // This also re-enables auto-scroll if user had scrolled up
    scrollToBottom();

    // Only set loading if AI is idle (direct send). For queued sends, don't change loading state.
    if (!isAiBusy) {
      setIsLoading(true);
    }

    // Note: User message is added by SSE replay from backend
    // TabProvider.sendMessage passes attachments which will be merged with the replay message

    try {
      // Build provider env from current provider config (read from refs for stability)
      // For subscription type, don't send providerEnv (use SDK's default auth)
      const provider = currentProviderRef.current;
      const keys = apiKeysRef.current;
      const providerEnv = provider && provider.type !== 'subscription' ? {
        baseUrl: provider.config.baseUrl,
        apiKey: keys[provider.id], // Get from stored apiKeys, not provider object
        authType: provider.authType,
      } : undefined;

      // If cron mode is enabled and task hasn't started yet, start the task
      const cron = cronStateRef.current;
      if (cron.isEnabled && !cron.task && cron.config) {
        // Start the cron task - pass prompt directly to avoid React state timing issues
        // The prompt is passed as a parameter because updateCronConfig() is async
        // and the state wouldn't be updated before startCronTask() is called
        await startCronTask(text);
        return; // startCronTask handles the message sending via onExecute callback
      }

      // sendMessage is fire-and-forget (returns true immediately for optimistic UI).
      // Error handling is done inside sendMessage's .then()/.catch() in TabProvider.
      await sendMessage(text, images, permissionMode, selectedModel, providerEnv);
    } catch (error) {
      const errorMessage = {
        id: `error-${crypto.randomUUID()}`,
        role: 'assistant' as const,
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      setMessages((prev) => [...prev, errorMessage]);
      // Reset both isLoading and sessionState to ensure UI recovers
      if (!isAiBusy) {
        setIsLoading(false);
        setSessionState('idle');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- toastRef/currentProviderRef/apiKeysRef/cronStateRef are refs (stable); scrollToBottom/setMessages/setIsLoading/setSessionState are stable
  }, [sessionState, isLoading, queuedMessages.length, startCronTask, sendMessage, permissionMode, selectedModel, scrollToBottom]);

  // Cancel a queued message and restore its text (and images if any) to the input box
  const handleCancelQueued = useCallback(async (queueId: string) => {
    // Snapshot the queued message info before it's removed (for image restore)
    const queuedMsg = queuedMessages.find(q => q.queueId === queueId);
    const cancelledText = await cancelQueuedMessage(queueId);
    if (cancelledText) {
      chatInputRef.current?.setValue(cancelledText);
      // Restore images if the queued message had them
      // Note: We only have preview data URLs (not File blobs) to avoid memory leaks,
      // so we reconstruct ImageAttachment with a minimal placeholder File.
      if (queuedMsg?.images && queuedMsg.images.length > 0) {
        const restoredImages: ImageAttachment[] = queuedMsg.images.map(img => ({
          id: img.id,
          file: new File([], img.name), // Placeholder — original blob is gone
          preview: img.preview,
        }));
        chatInputRef.current?.setImages(restoredImages);
      }
    }
  }, [cancelQueuedMessage, queuedMessages]);

  // Force-execute a queued message (interrupt current AI response)
  const handleForceExecuteQueued = useCallback(async (queueId: string) => {
    await forceExecuteQueuedMessage(queueId);
  }, [forceExecuteQueuedMessage]);

  // Stable callbacks for SimpleChatInput (extracted from inline arrows to enable memo)
  const handleStop = useCallback(async () => {
    try {
      await stopResponse();
    } catch (error) {
      console.error('[Chat] Failed to stop message:', error);
    }
  }, [stopResponse]);

  const handleOpenAgentSettings = useCallback(() => setShowWorkspaceConfig(true), []);
  const handleCollapseWorkspace = useCallback(() => setShowWorkspace(false), []);
  const handleOpenCronSettings = useCallback(() => setShowCronSettings(true), []);

  const handleCronStop = useCallback(async () => {
    const originalPrompt = await stopCronTask();
    if (originalPrompt) {
      chatInputRef.current?.setValue(originalPrompt);
    }
  }, [stopCronTask]);

  const handleCancelQueuedVoid = useCallback(
    (queueId: string) => { void handleCancelQueued(queueId); },
    [handleCancelQueued]
  );

  const handleForceExecuteQueuedVoid = useCallback(
    (queueId: string) => { void handleForceExecuteQueued(queueId); },
    [handleForceExecuteQueued]
  );

  // Stable callbacks for MessageList (extracted from inline arrows to enable memo)
  const handlePermissionDecision = useCallback((decision: 'deny' | 'allow_once' | 'always_allow') => {
    void respondPermission(decision);
  }, [respondPermission]);

  const handleAskUserQuestionSubmit = useCallback((_requestId: string, answers: Record<string, string>) => {
    void respondAskUserQuestion(answers);
  }, [respondAskUserQuestion]);

  const handleAskUserQuestionCancel = useCallback(() => {
    void respondAskUserQuestion(null);
  }, [respondAskUserQuestion]);

  // Stable callback for time rewind — uses ref for messages to keep reference stable
  const handleRewind = useCallback((messageId: string) => {
    const msgs = messagesRef.current;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;
    setRewindTarget({
      messageId,
      content: typeof msg.content === 'string' ? msg.content : '',
      attachments: msg.attachments,
    });
  }, []); // [] — 通过 ref 读取 messages，引用永远稳定

  const handleRewindConfirm = useCallback(() => {
    if (!rewindTarget) return;
    const { messageId, content, attachments } = rewindTarget;

    // 1. 立即关闭对话框 + 乐观更新 UI
    setRewindTarget(null);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    if (content) {
      chatInputRef.current?.setValue(content);
    }
    const imageAttachments = attachments?.filter(a =>
      a.isImage || a.mimeType?.startsWith('image/')
    );
    if (imageAttachments?.length) {
      const restoredImages: ImageAttachment[] = imageAttachments.map(a => ({
        id: a.id,
        file: new File([], a.name),
        preview: a.previewUrl || '',
      }));
      chatInputRef.current?.setImages(restoredImages);
    }

    // 2. 显示固定 loading 文案（后端 rewindPromise 会阻塞 enqueueUserMessage 防止竞态）
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost('/chat/rewind', { userMessageId: messageId })
      .then(res => {
        const r = res as { success?: boolean; error?: string } | undefined;
        if (r && !r.success) {
          toastRef.current.error('时间回溯失败：' + (r.error || '未知错误'));
        }
      })
      .catch(err => {
        console.error('[Chat] Rewind failed:', err);
        toastRef.current.error('文件回溯失败，对话记录已回退但文件状态可能未还原');
      })
      .finally(() => {
        setRewindStatus(null);
        setIsLoading(false);
      });
  }, [rewindTarget, apiPost, setMessages, setIsLoading]);

  // Handler for selecting a session from history dropdown
  const handleSelectSession = useCallback((id: string) => {
    track('session_switch');
    if (onSwitchSession) {
      onSwitchSession(id);
    } else {
      if (cronStateRef.current.task?.status === 'running') {
        console.log('[Chat] Cannot switch session while cron task is running (no onSwitchSession handler)');
        return;
      }
      void loadSession(id);
    }
  }, [onSwitchSession, loadSession]);

  // Internal handler for starting a new session
  // If AI is running, App.tsx handles it via background completion (returns true).
  // If AI is idle, falls back to resetSession (reuses Sidecar).
  const handleNewSession = useCallback(async () => {
    if (onNewSession) {
      const handled = await onNewSession();
      if (handled) {
        // App.tsx started background completion and created new Sidecar
        // TabProvider will detect sessionId change and reconnect
        return;
      }
    }

    // Fallback: AI is idle, reset session within existing Sidecar
    console.log('[Chat] Starting new session...');
    const success = await resetSession();
    if (success) {
      console.log('[Chat] New session started');
    } else {
      console.error('[Chat] Failed to start new session');
    }
  }, [onNewSession, resetSession]);

  return (
    <div className="flex h-full flex-col overflow-hidden overscroll-none bg-[var(--paper-strong)] text-[var(--ink)] md:flex-row">
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden border-b border-[var(--line-subtle)] md:border-r md:border-b-0 ${showWorkspace ? 'w-full md:w-3/4' : 'w-full'}`}>
        {/* Compact header - single row */}
        <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                title="Back to projects"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {/* Project name */}
            {agentDir && (
              <span className="text-sm font-medium text-[var(--ink)]">
                {agentDir.split(/[/\\]/).filter(Boolean).pop()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* New Session button - before History */}
            <button
              type="button"
              onClick={handleNewSession}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
              title="新建对话"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
            {/* History button */}
            <div className="relative">
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowHistory((prev) => !prev)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${showHistory
                  ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]'
                  }`}
              >
                <History className="h-3.5 w-3.5" />
                历史
              </button>
              <SessionHistoryDropdown
                agentDir={agentDir}
                currentSessionId={sessionId}
                onSelectSession={handleSelectSession}
                onDeleteCurrentSession={handleNewSession}
                isOpen={showHistory}
                onClose={() => setShowHistory(false)}
              />
            </div>
            {/* Dev-only buttons - controlled by config.showDevTools */}
            {config.showDevTools && (
              <>
                <button
                  type="button"
                  onClick={() => setShowLogs((prev) => !prev)}
                  className={`rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors ${showLogs
                    ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]'
                    }`}
                >
                  Logs
                </button>
                </>
            )}
            {/* Workspace toggle button - only show when workspace is hidden */}
            {!showWorkspace && (
              <button
                type="button"
                onClick={() => setShowWorkspace(true)}
                className="hidden md:flex items-center gap-1 rounded-lg px-2 py-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                title="展开工作区"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Content area with relative positioning for floating input */}
        <div
          ref={chatContentRef}
          className="relative flex flex-1 flex-col overflow-hidden"
          {...dragHandlers}
        >
          {/* Drop zone overlay for file drag */}
          <DropZoneOverlay
            isVisible={isAnyDragActive && (!isTauriDragging || activeZoneId === 'chat-content' || activeZoneId === null)}
            message="松手将文件加入工作区"
            subtitle="非图片文件将复制到 myagents_files 并自动引用"
          />

          {/* Startup overlay when launching from Launcher with initial message */}
          {showStartupOverlay && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                <p className="text-sm text-[var(--ink-muted)]">正在启动工作区...</p>
              </div>
            </div>
          )}

          {agentError && (
            <div className="flex-shrink-0 border-b border-[var(--line)] bg-[#f5e4d9]/80 px-4 py-2 text-[11px] text-[var(--ink)]">
              <div className="mx-auto flex max-w-3xl items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <div className="flex-1">
                  <span className="font-semibold text-[var(--ink)]">Agent error: </span>
                  <span className="text-[var(--ink-muted)]">{agentError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAgentError(null)}
                  className="flex-shrink-0 rounded px-2 py-0.5 text-[10px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {/* Unified Logs Panel - fullscreen modal displaying logs */}
          <UnifiedLogsPanel
            sseLogs={unifiedLogs}
            isVisible={showLogs}
            onClose={() => setShowLogs(false)}
            onClearAll={clearUnifiedLogs}
          />

          {/* Message list with max-width */}
          <FileActionProvider
            onInsertReference={handleInsertReference}
            refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
          >
            <MessageList
              messages={messages}
              isLoading={isLoading}
              containerRef={messagesContainerRef}
              bottomPadding={140}
              pendingPermission={pendingPermission}
              onPermissionDecision={handlePermissionDecision}
              pendingAskUserQuestion={pendingAskUserQuestion}
              onAskUserQuestionSubmit={handleAskUserQuestionSubmit}
              onAskUserQuestionCancel={handleAskUserQuestionCancel}
              systemStatus={rewindStatus || systemStatus}
              isStreaming={isLoading || sessionState === 'running'}
              onRewind={handleRewind}
            />
          </FileActionProvider>

          {/* Floating input with integrated cron task components */}
          <SimpleChatInput
            ref={chatInputRef}
            onSend={handleSendMessage}
            onStop={handleStop}
            isLoading={isLoading || sessionState === 'running'}
            sessionState={sessionState}
            systemStatus={systemStatus}
            agentDir={agentDir}
            provider={currentProvider}
            providers={providers}
            onProviderChange={handleProviderChange}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            apiKeys={apiKeys}
            providerVerifyStatus={providerVerifyStatus}
            inputRef={inputRef}
            workspaceMcpEnabled={workspaceMcpEnabled}
            globalMcpEnabled={globalMcpEnabled}
            mcpServers={mcpServers}
            onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
            onRefreshProviders={refreshProviderData}
            onOpenAgentSettings={handleOpenAgentSettings}
            onWorkspaceRefresh={triggerWorkspaceRefresh}
            // Cron task props - StatusBar and Overlay are rendered inside SimpleChatInput
            cronModeEnabled={cronState.isEnabled}
            cronConfig={cronState.config}
            cronTask={cronState.task}
            onCronButtonClick={handleOpenCronSettings}
            onCronSettings={handleOpenCronSettings}
            onCronCancel={disableCronMode}
            onCronStop={handleCronStop}
            onInputChange={setCronPrompt}
            queuedMessages={queuedMessages}
            onCancelQueued={handleCancelQueuedVoid}
            onForceExecuteQueued={handleForceExecuteQueuedVoid}
          />
        </div>
      </div>

      {showWorkspace && (
        <div
          ref={directoryPanelContainerRef}
          className="flex w-full flex-col md:w-1/4"
          style={{ minWidth: 'var(--sidebar-min-width)' }}
        >
          <DirectoryPanel
            ref={directoryPanelRef}
            agentDir={agentDir}
            provider={currentProvider}
            providers={providers}
            onProviderChange={handleProviderChange}
            onCollapse={handleCollapseWorkspace}
            onOpenConfig={handleOpenAgentSettings}
            refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
            isTauriDragActive={isTauriDragging && activeZoneId === 'directory-panel'}
            onInsertReference={handleInsertReference}
            enabledAgents={enabledAgents}
            enabledSkills={enabledSkills}
            enabledCommands={enabledCommands}
            onInsertSlashCommand={handleInsertSlashCommand}
            onOpenSettings={handleOpenSettings}
          />
        </div>
      )}

      {/* Workspace Config Panel */}
      {showWorkspaceConfig && (
        <WorkspaceConfigPanel
          agentDir={agentDir}
          onClose={() => {
            setShowWorkspaceConfig(false);
            setWorkspaceConfigInitialTab(undefined);
            // Refresh capabilities data in case settings were changed
            setWorkspaceRefreshTrigger(prev => prev + 1);
          }}
          refreshKey={workspaceRefreshKey}
          initialTab={workspaceConfigInitialTab}
        />
      )}

      {/* Time Rewind Confirm Dialog */}
      {rewindTarget && (
        <ConfirmDialog
          title="时间回溯"
          message="您的「对话记录」与「文件修改状态」都将回溯到本次对话发生之前。"
          confirmText="确认回溯"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={handleRewindConfirm}
          onCancel={() => setRewindTarget(null)}
        />
      )}

      {/* Cron Task Settings Modal */}
      <CronTaskSettingsModal
        isOpen={showCronSettings}
        onClose={() => setShowCronSettings(false)}
        initialPrompt={cronPrompt}
        initialConfig={cronState.config}
        onConfirm={(config) => {
          // Pass current model, permissionMode, and providerEnv to ensure the cron task
          // uses the same settings that are active when user enables cron mode
          const providerEnv = currentProvider && currentProvider.type !== 'subscription' ? {
            baseUrl: currentProvider.config.baseUrl,
            apiKey: apiKeys[currentProvider.id],
          } : undefined;

          // If task is already running, only update config (preserves task state)
          // Otherwise, enable cron mode which will prepare for a new task
          if (cronState.task) {
            // Task is running - update config without resetting task state
            updateRunningConfig({
              ...config,
              model: selectedModel,
              permissionMode: permissionMode,
              providerEnv: providerEnv,
            });
          } else {
            // No task running - enable cron mode normally
            enableCronMode({
              ...config,
              model: selectedModel,
              permissionMode: permissionMode,
              providerEnv: providerEnv,
            });
          }
          // Track cron_enable event
          track('cron_enable', {
            interval_minutes: config.intervalMinutes,
            run_mode: config.runMode,
            has_time_limit: !!config.endConditions.deadline,
            has_count_limit: !!(config.endConditions.maxExecutions && config.endConditions.maxExecutions > 0),
            notify_enabled: config.notifyEnabled,
          });
          setShowCronSettings(false);
        }}
      />
    </div>
  );
}
