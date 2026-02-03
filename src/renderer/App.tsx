import { useCallback, useEffect, useState, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { initAnalytics, track } from '@/analytics';
import { startTabSidecar, stopTabSidecar, startGlobalSidecar, stopAllSidecars, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, resetGlobalSidecarReadyPromise, getSessionActivation, startCronSidecar, getWorkspaceSidecar, updateSessionTab, registerTabUser } from '@/api/tauriClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomTitleBar from '@/components/CustomTitleBar';
import TabBar from '@/components/TabBar';
import TabProvider from '@/context/TabProvider';
import { useUpdater } from '@/hooks/useUpdater';
import { useTrayEvents } from '@/hooks/useTrayEvents';
import { useConfig } from '@/hooks/useConfig';
import Chat from '@/pages/Chat';
import Launcher from '@/pages/Launcher';
import Settings from '@/pages/Settings';
import {
  type Project,
  type Provider,
} from '@/config/types';
import { type Tab, createNewTab, getFolderName, MAX_TABS } from '@/types/tab';
import { getAllCronTasks, getTasksToRecover, startCronScheduler, getTabCronTask, updateCronTaskTab } from '@/api/cronTaskClient';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { forceFlushLogs, setLogServerUrl, clearLogServerUrl } from '@/utils/frontendLogger';
import { CUSTOM_EVENTS } from '../shared/constants';

export default function App() {
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate } = useUpdater();

  // App config for tray behavior
  const { config } = useConfig();

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);

  // Multi-tab state
  const [tabs, setTabs] = useState<Tab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Tab close confirmation state
  const [closeConfirmState, setCloseConfirmState] = useState<{
    tabId: string;
    tabTitle: string;
  } | null>(null);

  // Exit confirmation state (for cron tasks)
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    resolve: (value: boolean) => void;
  } | null>(null);

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // Reset and reinitialize the ready promise for retry
      if (retryCountRef.current > 0) {
        resetGlobalSidecarReadyPromise();
        initGlobalSidecarReadyPromise();
      }

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      // Set log server URL to global sidecar for unified logging
      try {
        const globalUrl = await getGlobalServerUrl();
        setLogServerUrl(globalUrl);
        console.log('[App] Global sidecar started, log URL set:', globalUrl);
      } catch (e) {
        console.warn('[App] Failed to set log server URL:', e);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(`[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error('[App] Global sidecar failed after max retries:', error);
      }
    }
  }, []);

  // Recover running cron tasks after app restart
  const recoverCronTasks = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const tasksToRecover = await getTasksToRecover();
      if (tasksToRecover.length === 0) {
        console.log('[App] No cron tasks to recover');
        return;
      }

      console.log(`[App] Recovering ${tasksToRecover.length} cron task(s)...`);

      for (const task of tasksToRecover) {
        try {
          // Start Sidecar first so it's ready when scheduler triggers or user opens session
          // This ensures Sidecar reuse works correctly
          console.log(`[App] Starting Sidecar for cron task ${task.id} (workspace: ${task.workspacePath})`);
          await startCronSidecar(task.workspacePath, task.id);
          console.log(`[App] Sidecar started for cron task ${task.id}`);

          // Restart the scheduler for each running task
          await startCronScheduler(task.id);
          console.log(`[App] Cron task ${task.id} scheduler restarted`);
        } catch (error) {
          console.error(`[App] Failed to recover cron task ${task.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[App] Failed to recover cron tasks:', error);
    }
  }, []);

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking)
    void initAnalytics().then(() => {
      // Track app launch event
      track('app_launch', { launch_type: 'cold' });
    });

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    // Recover cron tasks that were running before app restart
    // This is done after a short delay to ensure Rust is fully initialized
    const recoveryTimeout = setTimeout(() => {
      void recoverCronTasks();
    }, 1000);

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      clearTimeout(recoveryTimeout);
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      void stopAllSidecars();
    };
  }, [startGlobalSidecarSilent, recoverCronTasks]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback((tabId: string, isGenerating: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isGenerating } : t
    ));
  }, []);

  // Perform the actual tab close operation (pure function, no confirmation)
  const performCloseTab = useCallback(async (tabId: string) => {
    const currentTabs = tabs;

    // Double-check: tab might have been removed
    const tab = currentTabs.find(t => t.id === tabId);
    if (!tab) return;

    // Calculate actual tab_count after close:
    // - If closing the last tab, a new launcher is created, so count = 1
    // - Otherwise, count = currentTabs.length - 1
    const isLastTab = currentTabs.length === 1;
    const actualTabCount = isLastTab ? 1 : currentTabs.length - 1;

    // Track tab_close event with correct count
    track('tab_close', { view: tab.view, tab_count: actualTabCount });

    // Check if this Tab has an active cron task
    // If so, don't stop the Sidecar - let it run in background for scheduled executions
    if (tab.agentDir) {
      try {
        const cronTask = await getTabCronTask(tabId);
        if (cronTask && (cronTask.status === 'running' || cronTask.status === 'paused')) {
          // Cron task is active - keep Sidecar running but clear tab association
          console.log(`[App] Tab ${tabId} has active cron task ${cronTask.id}, keeping Sidecar alive`);
          await updateCronTaskTab(cronTask.id, undefined); // Clear tabId association
          // Don't stop Sidecar
        } else {
          // No active cron task - stop Sidecar as usual
          void stopTabSidecar(tabId);
        }
      } catch (error) {
        console.error(`[App] Error checking cron task for tab ${tabId}:`, error);
        // On error, stop Sidecar to be safe
        void stopTabSidecar(tabId);
      }
    }

    // Special case: If this is the last tab, replace with launcher (don't close the app)
    if (isLastTab) {
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);
      return;
    }

    // Normal case: close the tab
    const newTabs = currentTabs.filter((t) => t.id !== tabId);

    // If closing the active tab, switch to the last remaining tab
    if (tabId === activeTabId && newTabs.length > 0) {
      setActiveTabId(newTabs[newTabs.length - 1].id);
    }

    setTabs(newTabs);
  }, [tabs, activeTabId]);

  // Close tab with confirmation if generating (shows custom dialog)
  const closeTabWithConfirmation = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);

    // If generating, show confirmation dialog
    if (tab?.isGenerating) {
      setCloseConfirmState({
        tabId,
        tabTitle: tab.title
      });
      return;
    }

    // Otherwise, close directly
    void performCloseTab(tabId);
  }, [tabs, performCloseTab]);

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    if (!activeTabId) return;

    const activeTab = tabs.find(t => t.id === activeTabId);

    // Special case: If only one launcher tab, do nothing
    if (tabs.length === 1 && activeTab?.view === 'launcher') {
      return;
    }

    // Multiple tabs OR last tab is chat/settings: use the unified confirmation logic
    closeTabWithConfirmation(activeTabId);
  }, [activeTabId, tabs, closeTabWithConfirmation]);

  // Keyboard shortcuts: Cmd+T (new tab), Cmd+W (close tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (!modKey) return;

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        // New tab
        if (tabs.length < MAX_TABS) {
          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
        }
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        closeCurrentTab();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, closeCurrentTab]);

  const handleLaunchProject = useCallback(async (
    project: Project,
    _provider: Provider,
    sessionId?: string
  ) => {
    if (!activeTabId) return;

    // Track workspace_open or history_open event
    if (sessionId) {
      track('history_open');
    } else {
      track('workspace_open');
    }

    setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
    setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));

    try {
      // Check if the session is already activated by another Tab or CronTask (Session singleton constraint)
      if (sessionId) {
        const activation = await getSessionActivation(sessionId);
        if (activation) {
          // Session is already activated
          if (activation.tab_id && activation.tab_id !== activeTabId) {
            // Session is open in another Tab - check if that Tab exists
            const targetTab = tabs.find(t => t.id === activation.tab_id);
            if (targetTab) {
              // Jump to the existing Tab
              console.log(`[App] Session ${sessionId} already active in tab ${activation.tab_id}, jumping to it`);
              setActiveTabId(activation.tab_id);
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              return;
            }
          }

          // Tab doesn't exist or no tab_id (cron task running without Tab)
          // Connect this Tab to the existing Sidecar instead of creating a new one
          console.log(`[App] Session ${sessionId} activated by cron task, connecting current tab to existing Sidecar on port ${activation.port}`);

          // Check if workspace Sidecar exists
          const sidecarInfo = await getWorkspaceSidecar(project.path);
          if (sidecarInfo && sidecarInfo.port > 0) {
            // Sidecar exists - register this Tab as a user and update session's tab_id
            await registerTabUser(project.path, activeTabId);
            await updateSessionTab(sessionId, activeTabId);

            console.log(`[App] Connected tab ${activeTabId} to existing Sidecar on port ${sidecarInfo.port}`);

            // Update tab to chat view
            setTabs((prev) =>
              prev.map((t) =>
                t.id === activeTabId
                  ? {
                    ...t,
                    agentDir: project.path,
                    sessionId: sessionId ?? null,
                    view: 'chat',
                    title: getFolderName(project.path),
                  }
                  : t
              )
            );
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
            return;
          }
          // Sidecar doesn't exist - fall through to create new one
          console.log(`[App] No existing Sidecar found for workspace, creating new one`);
        }
      }

      console.log('[App] Starting sidecar for project:', project.path, 'sessionId:', sessionId);

      // Start a Tab-specific Sidecar instance
      const status = await startTabSidecar(activeTabId, project.path);
      console.log('[App] Tab sidecar started:', status);

      // Update tab to chat view with project info and optional sessionId
      // SSE will be connected by TabProvider, which will load the session if sessionId is provided
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: sessionId ?? null,
              view: 'chat',
              title: getFolderName(project.path),
            }
            : t
        )
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[App] Failed to start:', errorMsg);
      setTabErrors((prev) => ({ ...prev, [activeTabId]: errorMsg }));

      // In browser dev mode, still allow navigation
      if (isBrowserDevMode()) {
        console.log('[App] Browser mode: continuing despite error');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? {
                ...t,
                agentDir: project.path,
                view: 'chat',
                title: getFolderName(project.path),
              }
              : t
          )
        );
      }
    } finally {
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
    }
  }, [activeTabId]);

  const handleBackToLauncher = useCallback(async () => {
    if (!activeTabId) return;

    // Check if this Tab has an active cron task before stopping Sidecar
    try {
      const cronTask = await getTabCronTask(activeTabId);
      if (cronTask && (cronTask.status === 'running' || cronTask.status === 'paused')) {
        // Cron task is active - keep Sidecar running but clear tab association
        console.log(`[App] Tab ${activeTabId} has active cron task ${cronTask.id}, keeping Sidecar alive`);
        await updateCronTaskTab(cronTask.id, undefined);
        // Don't stop Sidecar
      } else {
        // No active cron task - stop Sidecar
        void stopTabSidecar(activeTabId);
      }
    } catch (error) {
      console.error(`[App] Error checking cron task for tab ${activeTabId}:`, error);
      // On error, stop Sidecar to be safe
      void stopTabSidecar(activeTabId);
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' }
          : t
      )
    );
  }, [activeTabId]);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const tab = tabs.find(t => t.id === tabId);
    if (tabs.length === 1 && tab?.view === 'launcher') {
      return;
    }

    closeTabWithConfirmation(tabId);
  }, [tabs, closeTabWithConfirmation]);

  const handleNewTab = useCallback(() => {
    if (tabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Track tab_new event
    track('tab_new', { tab_count: tabs.length + 1 });
  }, [tabs.length]);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  const handleOpenSettings = useCallback(async (initialSection?: string) => {
    // Track settings_open event
    track('settings_open', { section: initialSection ?? null });

    // Set initial section for Settings component
    setSettingsInitialSection(initialSection);

    // Check if there's already a Settings tab
    const existingSettingsTab = tabs.find((t) => t.view === 'settings');
    if (existingSettingsTab) {
      // Switch to existing Settings tab
      setActiveTabId(existingSettingsTab.id);
      return;
    }

    // Create new Settings tab
    if (tabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }

    // Create Tab first (instant UI response)
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'settings',
      title: '设置',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Global Sidecar is now started on App mount, no need to start here
  }, [tabs]);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (event: CustomEvent<{ section?: string }>) => {
      handleOpenSettings(event.detail?.section);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    };
  }, [handleOpenSettings]);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (event: CustomEvent<{ targetTabId: string; sessionId: string }>) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabs.find(t => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    };
  }, [tabs]);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onExitRequested: async () => {
      // Check for running cron tasks
      try {
        const tasks = await getAllCronTasks();
        const runningTasks = tasks.filter(t => t.status === 'running' || t.status === 'paused');

        if (runningTasks.length > 0) {
          // Show confirmation dialog
          return new Promise<boolean>((resolve) => {
            setExitConfirmState({
              runningTaskCount: runningTasks.length,
              resolve,
            });
          });
        }
      } catch (error) {
        console.error('[App] Failed to check cron tasks:', error);
      }

      // No running tasks, allow exit
      return true;
    },
  });

  return (
    <div className="flex h-screen flex-col bg-[var(--paper)]">
      {/* Chrome-style titlebar with tabs */}
      <CustomTitleBar
        onSettingsClick={handleOpenSettings}
        updateReady={updateReady}
        updateVersion={updateVersion}
        onRestartAndUpdate={() => void restartAndUpdate()}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onReorderTabs={handleReorderTabs}
        />
      </CustomTitleBar>

      {/* Tab content - only Chat views need TabProvider for sidecar communication */}
      <div className="relative flex-1 overflow-hidden">
        {tabs.map((tab) => {
          const isLoading = loadingTabs[tab.id] ?? false;
          const error = tabErrors[tab.id] ?? null;
          const isActive = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
            >
              {/* Launcher and Settings use Global Sidecar - no TabProvider needed */}
              {tab.view === 'launcher' ? (
                <Launcher
                  onLaunchProject={handleLaunchProject}
                  isStarting={isLoading}
                  startError={error}
                  onOpenSettings={handleOpenSettings}
                />
              ) : tab.view === 'settings' ? (
                <Settings
                  initialSection={settingsInitialSection}
                  onSectionChange={() => setSettingsInitialSection(undefined)}
                />
              ) : (
                /* Chat views use Tab Sidecar - wrapped in TabProvider */
                <TabProvider
                  tabId={tab.id}
                  agentDir={tab.agentDir ?? ''}
                  sessionId={tab.sessionId}
                  isActive={isActive}
                  onGeneratingChange={(isGenerating) => updateTabGenerating(tab.id, isGenerating)}
                >
                  <Chat onBack={handleBackToLauncher} />
                </TabProvider>
              )}
            </div>
          );
        })}
      </div>

      {/* Close confirmation dialog */}
      {closeConfirmState && (
        <ConfirmDialog
          title="关闭标签页"
          message={`正在与 AI 对话中，确定要关闭「${closeConfirmState.tabTitle}」吗？`}
          confirmText="关闭"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={() => {
            void performCloseTab(closeConfirmState.tabId);
            setCloseConfirmState(null);
          }}
          onCancel={() => setCloseConfirmState(null)}
        />
      )}

      {/* Exit confirmation dialog for running cron tasks */}
      {exitConfirmState && (
        <ConfirmDialog
          title="退出应用"
          message={`有 ${exitConfirmState.runningTaskCount} 个定时任务正在运行中。退出后任务将被停止。确定要退出吗？`}
          confirmText="退出"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={() => {
            exitConfirmState.resolve(true);
            setExitConfirmState(null);
          }}
          onCancel={() => {
            exitConfirmState.resolve(false);
            setExitConfirmState(null);
          }}
        />
      )}
    </div>
  );
}
