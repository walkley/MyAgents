import { useCallback, useEffect, useState, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

import { initAnalytics, track } from '@/analytics';
import { startTabSidecar, stopTabSidecar, startGlobalSidecar, stopAllSidecars, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, resetGlobalSidecarReadyPromise, getSessionActivation, updateSessionTab, connectTabToCronSidecar, deactivateSession } from '@/api/tauriClient';
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
import { getAllCronTasks, getTabCronTask, updateCronTaskTab } from '@/api/cronTaskClient';
import { type CronRecoverySummaryPayload, type CronTaskRecoveredPayload, CRON_EVENTS } from '@/types/cronEvents';
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

  // 方案 A: Rust 统一恢复 - 前端不再主动恢复，只监听事件
  // Rust 层 initialize_cron_manager 会自动恢复所有 running 状态的任务

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

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    let unlistenManagerReady: (() => void) | null = null;
    let unlistenRecoverySummary: (() => void) | null = null;
    let unlistenTaskRecovered: (() => void) | null = null;

    const setupCronRecoveryListeners = async () => {
      if (!isTauriEnvironment()) return;

      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Listen for individual task recovered events
        unlistenTaskRecovered = await listen<CronTaskRecoveredPayload>(
          CRON_EVENTS.TASK_RECOVERED,
          (event) => {
            if (mountedRef.current) {
              const { taskId, sessionId, port } = event.payload;
              console.log(`[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`);
            }
          }
        );

        // Listen for recovery summary event
        unlistenRecoverySummary = await listen<CronRecoverySummaryPayload>(
          CRON_EVENTS.RECOVERY_SUMMARY,
          (event) => {
            if (mountedRef.current) {
              const { totalTasks, recoveredCount, failedCount, failedTasks } = event.payload;
              if (totalTasks > 0) {
                console.log(
                  `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`
                );
                if (failedTasks.length > 0) {
                  console.warn('[App] Failed tasks:', failedTasks);
                }
              }
            }
          }
        );

        // Listen for manager ready event (indicates recovery is complete)
        unlistenManagerReady = await listen(CRON_EVENTS.MANAGER_READY, () => {
          if (mountedRef.current) {
            console.log('[App] Cron manager ready (Rust recovery complete)');
          }
        });
      } catch (error) {
        console.error('[App] Failed to setup cron recovery listeners:', error);
      }
    };

    void setupCronRecoveryListeners();

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Cleanup cron recovery listeners
      if (unlistenTaskRecovered) {
        unlistenTaskRecovered();
      }
      if (unlistenRecoverySummary) {
        unlistenRecoverySummary();
      }
      if (unlistenManagerReady) {
        unlistenManagerReady();
      }
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      void stopAllSidecars();
    };
  }, [startGlobalSidecarSilent]);

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

    // Deactivate session when Tab closes (unless cron task keeps it active)
    // This ensures Session singleton constraint is maintained
    if (tab.sessionId) {
      try {
        const cronTask = await getTabCronTask(tabId);
        if (cronTask && cronTask.status === 'running') {
          // Cron task is active - update session activation to remove tab_id but keep task_id
          console.log(`[App] Tab ${tabId} closing with active cron task ${cronTask.id}, updating session activation`);
          await updateSessionTab(tab.sessionId, undefined);
        } else {
          // No active cron task - fully deactivate session
          console.log(`[App] Tab ${tabId} closing, deactivating session ${tab.sessionId}`);
          await deactivateSession(tab.sessionId);
        }
      } catch (error) {
        console.error(`[App] Error deactivating session for tab ${tabId}:`, error);
      }
    }

    // Check if this Tab has an active cron task
    // If so, don't stop the Sidecar - let it run in background for scheduled executions
    if (tab.agentDir) {
      try {
        const cronTask = await getTabCronTask(tabId);
        if (cronTask && cronTask.status === 'running') {
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

  /**
   * Launch a project with Session Singleton Architecture
   *
   * Four scenarios (evaluated in order):
   * 1. Session already open in a Tab → Jump to that Tab
   * 2. Session has running cron task (no Tab) → New Tab connects to Cron Sidecar
   * 3. Current Tab has running cron task → New Tab + New Sidecar
   * 4. Normal switch → Current Tab switches Session
   */
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
      // ========================================
      // Scenario 1: Session already open in a Tab
      // ========================================
      if (sessionId) {
        // Find if session is already open in any existing Tab
        const existingTab = tabs.find(t => t.sessionId === sessionId);
        if (existingTab) {
          console.log(`[App] Scenario 1: Session ${sessionId} already in tab ${existingTab.id}, jumping to it`);
          setActiveTabId(existingTab.id);
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
          return;
        }
      }

      // ========================================
      // Scenario 2: Session has running cron task (no Tab)
      // ========================================
      if (sessionId) {
        const activation = await getSessionActivation(sessionId);
        console.log(`[App] Scenario 2 check: sessionId=${sessionId}, activation=`, activation);
        if (activation && activation.task_id) {
          // Session is activated by a cron task - connect Tab to its Sidecar
          console.log(`[App] Scenario 2: Session ${sessionId} has cron task ${activation.task_id} on port ${activation.port}`);

          // Determine target Tab (may need new Tab if current has cron task)
          let targetTabId = activeTabId;
          const currentTabCronTask = await getTabCronTask(activeTabId);
          if (currentTabCronTask && currentTabCronTask.status === 'running') {
            // Current Tab has running cron task, need new Tab
            if (tabs.length >= MAX_TABS) {
              setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              return;
            }
            const newTab = createNewTab();
            setTabs((prev) => [...prev, newTab]);
            targetTabId = newTab.id;
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
          }

          // Connect Tab to cron task Sidecar
          const port = await connectTabToCronSidecar(targetTabId, activation.task_id);
          console.log(`[App] Tab ${targetTabId} connected to cron Sidecar on port ${port}`);

          // Update session activation to include this Tab
          await updateSessionTab(sessionId, targetTabId);

          // Update tab state
          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? {
                  ...t,
                  agentDir: project.path,
                  sessionId: sessionId,
                  view: 'chat',
                  title: getFolderName(project.path),
                  cronTaskId: activation.task_id ?? undefined, // Mark Tab as connected to cron task
                  sidecarPort: port, // Store the port for SSE connection
                }
                : t
            )
          );

          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
          setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
          return;
        }
      }

      // ========================================
      // Scenario 3: Current Tab has running cron task
      // ========================================
      let targetTabId = activeTabId;
      const currentTabCronTask = await getTabCronTask(activeTabId);
      if (currentTabCronTask && currentTabCronTask.status === 'running') {
        console.log(`[App] Scenario 3: Current tab ${activeTabId} has running cron task ${currentTabCronTask.id}, creating new tab`);

        if (tabs.length >= MAX_TABS) {
          setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
          return;
        }

        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        targetTabId = newTab.id;
        setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
      }

      // ========================================
      // Scenario 4: Normal switch (or Scenario 3 continuation)
      // ========================================
      console.log(`[App] Scenario 4: Normal launch - tab ${targetTabId}, project: ${project.path}, sessionId: ${sessionId}`);

      // Start a Tab-specific Sidecar instance
      const status = await startTabSidecar(targetTabId, project.path);
      console.log('[App] Tab sidecar started:', status);

      // Update tab state
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: sessionId ?? null,
              view: 'chat',
              title: getFolderName(project.path),
              cronTaskId: undefined, // Clear any previous cron task association
              sidecarPort: undefined, // Clear any previous port
            }
            : t
        )
      );

      if (targetTabId !== activeTabId) {
        setActiveTabId(targetTabId);
      }
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
  }, [activeTabId, tabs]);

  /**
   * Handle session switch from within Chat (history dropdown)
   * Implements Session singleton with all 4 scenarios
   */
  const handleSwitchSession = useCallback(async (tabId: string, sessionId: string) => {
    // Scenario 1: Session already open in a Tab → Jump to that Tab
    const existingTab = tabs.find(t => t.sessionId === sessionId);
    if (existingTab) {
      console.log(`[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${existingTab.id}, jumping to it`);
      setActiveTabId(existingTab.id);
      return;
    }

    // Scenario 2: Session has running cron task (no Tab) → Connect to Cron Sidecar
    const activation = await getSessionActivation(sessionId);
    if (activation && activation.task_id) {
      console.log(`[App] handleSwitchSession Scenario 2: Session ${sessionId} has cron task ${activation.task_id}`);

      // Get current tab info to find agentDir
      const currentTab = tabs.find(t => t.id === tabId);
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      // Connect Tab to cron task Sidecar
      try {
        const port = await connectTabToCronSidecar(tabId, activation.task_id);
        await updateSessionTab(sessionId, tabId);

        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                ...t,
                sessionId,
                cronTaskId: activation.task_id ?? undefined,
                sidecarPort: port,
              }
              : t
          )
        );
      } catch (error) {
        console.error('[App] Failed to connect to cron Sidecar:', error);
      }
      return;
    }

    // Scenario 3: Current Tab has running cron task → Create new Tab + new Sidecar
    const currentTabCronTask = await getTabCronTask(tabId);
    if (currentTabCronTask && currentTabCronTask.status === 'running') {
      console.log(`[App] handleSwitchSession Scenario 3: Current tab ${tabId} has cron task, creating new tab`);

      // Check max tabs limit
      if (tabs.length >= MAX_TABS) {
        console.warn('[App] Cannot create new tab: max tabs reached');
        return;
      }

      // Get agentDir from current tab
      const currentTab = tabs.find(t => t.id === tabId);
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      // Create new tab
      const newTab = createNewTab();
      setTabs((prev) => [...prev, newTab]);
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

      try {
        // Start new Sidecar for new tab
        await startTabSidecar(newTab.id, currentTab.agentDir);

        // Update new tab state
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id
              ? {
                ...t,
                agentDir: currentTab.agentDir,
                sessionId,
                view: 'chat',
                title: getFolderName(currentTab.agentDir ?? ''),
              }
              : t
          )
        );

        // Jump to new tab
        setActiveTabId(newTab.id);
        console.log(`[App] handleSwitchSession Scenario 3: Created new tab ${newTab.id} for session ${sessionId}`);
      } catch (error) {
        console.error('[App] Failed to start Sidecar for new tab:', error);
        // Remove the failed tab
        setTabs((prev) => prev.filter(t => t.id !== newTab.id));
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
      return;
    }

    // Scenario 4: Normal switch → Update Tab's sessionId
    console.log(`[App] handleSwitchSession Scenario 4: Switching tab ${tabId} to session ${sessionId}`);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, sessionId }
          : t
      )
    );
  }, [tabs]);

  const handleBackToLauncher = useCallback(async () => {
    if (!activeTabId) return;

    // Get current tab to access sessionId
    const currentTab = tabs.find(t => t.id === activeTabId);

    // Check if this Tab has an active cron task before stopping Sidecar
    try {
      const cronTask = await getTabCronTask(activeTabId);
      if (cronTask && cronTask.status === 'running') {
        // Cron task is active - keep Sidecar running but clear tab association
        console.log(`[App] Tab ${activeTabId} has active cron task ${cronTask.id}, keeping Sidecar alive`);
        await updateCronTaskTab(cronTask.id, undefined);
        // Update session activation to remove tab_id but keep task_id
        if (currentTab?.sessionId) {
          await updateSessionTab(currentTab.sessionId, undefined);
        }
        // Don't stop Sidecar
      } else {
        // No active cron task - stop Sidecar and deactivate session
        void stopTabSidecar(activeTabId);
        if (currentTab?.sessionId) {
          await deactivateSession(currentTab.sessionId);
        }
      }
    } catch (error) {
      console.error(`[App] Error checking cron task for tab ${activeTabId}:`, error);
      // On error, stop Sidecar to be safe
      void stopTabSidecar(activeTabId);
      // Still try to deactivate session
      if (currentTab?.sessionId) {
        await deactivateSession(currentTab.sessionId).catch(() => {});
      }
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' }
          : t
      )
    );
  }, [activeTabId, tabs]);

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

  // Listen for CRON_TASK_STOPPED event (switch Tab back to normal Sidecar)
  useEffect(() => {
    const handleCronTaskStopped = (event: CustomEvent<{ tabId: string; agentDir: string }>) => {
      const { tabId, agentDir } = event.detail;
      console.log(`[App] Cron task stopped for tab ${tabId}, switching to normal Sidecar`);

      // Use void to handle async operation without making handler async
      void (async () => {
        try {
          // 1. Start a new Tab Sidecar (this will replace any existing one)
          await startTabSidecar(tabId, agentDir);
          console.log(`[App] Started normal Tab Sidecar for tab ${tabId}`);

          // 2. Clear Tab's cron state (sidecarPort and cronTaskId)
          // This triggers TabProvider recreation with new sidecarPort=undefined
          setTabs(prev => prev.map(t =>
            t.id === tabId
              ? { ...t, sidecarPort: undefined, cronTaskId: undefined }
              : t
          ));
        } catch (error) {
          console.error(`[App] Failed to switch tab ${tabId} to normal Sidecar:`, error);
        }
      })();
    };
    window.addEventListener(CUSTOM_EVENTS.CRON_TASK_STOPPED, handleCronTaskStopped as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.CRON_TASK_STOPPED, handleCronTaskStopped as EventListener);
    };
  }, []);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onExitRequested: async () => {
      // Check for running cron tasks
      try {
        const tasks = await getAllCronTasks();
        const runningTasks = tasks.filter(t => t.status === 'running');

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
                  sidecarPort={tab.sidecarPort}
                >
                  <Chat
                    onBack={handleBackToLauncher}
                    onSwitchSession={(sessionId) => handleSwitchSession(tab.id, sessionId)}
                  />
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
