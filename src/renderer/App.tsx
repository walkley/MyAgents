import { useCallback, useEffect, useState, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

import { initAnalytics, track } from '@/analytics';
import { stopTabSidecar, startGlobalSidecar, stopAllSidecars, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, resetGlobalSidecarReadyPromise, getSessionActivation, updateSessionTab, ensureSessionSidecar, releaseSessionSidecar, activateSession, deactivateSession, upgradeSessionId, getSessionPort, stopSseProxy, startBackgroundCompletion, cancelBackgroundCompletion } from '@/api/tauriClient';
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
import { type Tab, type InitialMessage, createNewTab, getFolderName, MAX_TABS } from '@/types/tab';
import { getAllCronTasks, getTabCronTask, updateCronTaskTab } from '@/api/cronTaskClient';
import { type CronRecoverySummaryPayload, type CronTaskRecoveredPayload, CRON_EVENTS } from '@/types/cronEvents';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { forceFlushLogs, setLogServerUrl, clearLogServerUrl } from '@/utils/frontendLogger';
import { CUSTOM_EVENTS, createPendingSessionId } from '../shared/constants';

export default function App() {
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate, checking: updateChecking, downloading: updateDownloading, checkForUpdate } = useUpdater();

  // Stable callback for Settings prop — avoids inline arrow creating new ref every render
  const handleRestartAndUpdate = useCallback(() => {
    void restartAndUpdate();
  }, [restartAndUpdate]);

  // App config for tray behavior
  const { config, reload: reloadConfig } = useConfig();

  // Listen for config changes from other components (e.g., Settings page)
  useEffect(() => {
    const handleConfigChange = () => {
      console.log('[App] Config changed, reloading...');
      void reloadConfig();
    };
    window.addEventListener(CUSTOM_EVENTS.CONFIG_CHANGED, handleConfigChange);
    return () => window.removeEventListener(CUSTOM_EVENTS.CONFIG_CHANGED, handleConfigChange);
  }, [reloadConfig]);

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

  // Per-tab launch guard — prevents concurrent launches overwriting each other's state
  const launchingTabRef = useRef<string | null>(null);

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

    // Initialize bundled workspace (mino) on first launch
    const initBundledWorkspace = async () => {
      if (!isTauriEnvironment()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ path: string; is_new: boolean }>('cmd_initialize_bundled_workspace');
        if (result.is_new) {
          const { addProject, loadAppConfig, saveAppConfig } = await import('@/config/configService');
          await addProject(result.path);
          const latest = await loadAppConfig();
          if (!latest.defaultWorkspacePath) {
            await saveAppConfig({ ...latest, defaultWorkspacePath: result.path });
            // Notify useConfig to pick up the new defaultWorkspacePath
            window.dispatchEvent(new Event(CUSTOM_EVENTS.CONFIG_CHANGED));
          }
        }
      } catch (err) {
        console.warn('[App] Bundled workspace init failed:', err);
      }
    };
    void initBundledWorkspace();

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    let unlistenManagerReady: (() => void) | null = null;
    let unlistenRecoverySummary: (() => void) | null = null;
    let unlistenTaskRecovered: (() => void) | null = null;
    let unlistenBgComplete: (() => void) | null = null;

    const setupCronRecoveryListeners = async () => {
      if (!isTauriEnvironment()) return;

      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Listen for background session completion events
        unlistenBgComplete = await listen<{ sessionId: string; sidecarStopped: boolean }>(
          'session:background-complete',
          (event) => {
            if (mountedRef.current) {
              const { sessionId, sidecarStopped } = event.payload;
              console.log(`[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`);
            }
          }
        );

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
                // Track cron_recover event
                track('cron_recover', {
                  recovered_count: recoveredCount,
                  failed_count: failedCount,
                });
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
      if (unlistenBgComplete) {
        unlistenBgComplete();
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

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback(async (tabId: string, newSessionId: string) => {
    // Find the current tab to get the old sessionId
    const currentTab = tabs.find(t => t.id === tabId);
    const oldSessionId = currentTab?.sessionId;

    console.log(`[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`);

    // Upgrade the session ID in Rust HashMap (sidecars + session_activations)
    // This is a no-op if oldSessionId is null or same as newSessionId
    if (oldSessionId && oldSessionId !== newSessionId) {
      const upgraded = await upgradeSessionId(oldSessionId, newSessionId);
      console.log(`[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
    }

    // Update UI state
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, sessionId: newSessionId } : t
    ));
  }, [tabs]);

  // Perform the actual tab close operation (pure function, no confirmation)
  // UI updates are immediate; resource cleanup runs in background (non-blocking)
  const performCloseTab = useCallback((tabId: string) => {
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

    // ========== IMMEDIATE UI UPDATE (non-blocking) ==========
    // Update UI state first for instant response
    if (isLastTab) {
      // Special case: If this is the last tab, replace with launcher (don't close the app)
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);
    } else {
      // Normal case: close the tab
      const newTabs = currentTabs.filter((t) => t.id !== tabId);

      // If closing the active tab, switch to the last remaining tab
      if (tabId === activeTabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }

      setTabs(newTabs);
    }

    // ========== BACKGROUND CLEANUP (non-blocking) ==========
    // Capture tab data before cleanup to avoid stale closure issues
    const tabSessionId = tab.sessionId;
    const tabAgentDir = tab.agentDir;

    // Resource cleanup runs asynchronously without blocking UI
    // CRITICAL: SSE proxy must be stopped BEFORE Sidecar to avoid "unexpected EOF" errors
    // When Sidecar dies, open HTTP connections break mid-stream causing errors
    const cleanupResources = async () => {
      try {
        // Step 1: Try to start background completion if AI is running
        // This keeps the Sidecar alive so AI can finish its response
        if (tabSessionId) {
          const bgResult = await startBackgroundCompletion(tabSessionId);
          if (bgResult.started) {
            console.log(`[App] Tab ${tabId} closing: AI still running, background completion started for session ${tabSessionId}`);
          }
        }

        // Step 2: Stop SSE proxy FIRST to ensure clean disconnection
        // This prevents "unexpected EOF" errors when Sidecar is stopped
        await stopSseProxy(tabId);

        // Step 3: Release Tab's ownership of the Session Sidecar
        // If background completion is active, Sidecar continues running (BG owner keeps it alive)
        if (tabSessionId) {
          try {
            // Update cron task tab association if exists
            const cronTask = await getTabCronTask(tabId);
            if (cronTask && cronTask.status === 'running') {
              await updateCronTaskTab(cronTask.id, undefined);
            }

            const stopped = await releaseSessionSidecar(tabSessionId, 'tab', tabId);
            console.log(`[App] Tab ${tabId} released session ${tabSessionId}, sidecar stopped: ${stopped}`);

            // Clean up session activation
            if (!cronTask || cronTask.status !== 'running') {
              await deactivateSession(tabSessionId);
            }
          } catch (error) {
            console.error(`[App] Error releasing session sidecar for tab ${tabId}:`, error);
            // Fallback to legacy stopTabSidecar
            void stopTabSidecar(tabId);
          }
        } else if (tabAgentDir) {
          // No sessionId but has agentDir - legacy case, use stopTabSidecar
          void stopTabSidecar(tabId);
        }
      } catch (error) {
        console.error(`[App] Background cleanup error for tab ${tabId}:`, error);
      }
    };

    // Fire and forget - cleanup runs in background
    void cleanupResources();
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
    sessionId?: string,
    initialMessage?: InitialMessage
  ) => {
    if (!activeTabId) return;

    // Per-tab launch guard: prevent concurrent launches on the same tab
    // A second launch would overwrite the first's initialMessage and kill its sidecar
    if (launchingTabRef.current === activeTabId) {
      console.warn(`[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`);
      return;
    }
    launchingTabRef.current = activeTabId;

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
          launchingTabRef.current = null;
          return;
        }
      }

      // ========================================
      // Scenario 2: Session has running cron task (no Tab)
      // Using Session-centric API: add Tab as owner to existing Sidecar
      // ========================================
      if (sessionId) {
        const activation = await getSessionActivation(sessionId);
        console.log(`[App] Scenario 2 check: sessionId=${sessionId}, activation=`, activation);
        if (activation && activation.task_id) {
          // Session is activated by a cron task - add Tab as owner to its Sidecar
          console.log(`[App] Scenario 2: Session ${sessionId} has cron task ${activation.task_id} on port ${activation.port}`);

          // Determine target Tab (may need new Tab if current has cron task)
          let targetTabId = activeTabId;
          const currentTabCronTask = await getTabCronTask(activeTabId);
          if (currentTabCronTask && currentTabCronTask.status === 'running') {
            // Current Tab has running cron task, need new Tab
            if (tabs.length >= MAX_TABS) {
              setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              launchingTabRef.current = null;
              return;
            }
            const newTab = createNewTab();
            setTabs((prev) => [...prev, newTab]);
            targetTabId = newTab.id;
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
          }

          // Add Tab as owner to the Session's Sidecar (cron task already owns it)
          // This uses ensureSessionSidecar which will add Tab as owner without creating new Sidecar
          const result = await ensureSessionSidecar(sessionId, project.path, 'tab', targetTabId);
          console.log(`[App] Tab ${targetTabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);

          // Update session activation to include this Tab
          await updateSessionTab(sessionId, targetTabId);

          // Update tab state (no cronTaskId/sidecarPort - managed by Owner model)
          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? {
                  ...t,
                  agentDir: project.path,
                  sessionId: sessionId,
                  view: 'chat',
                  title: getFolderName(project.path),
                }
                : t
            )
          );

          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
          setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
          launchingTabRef.current = null;
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
          launchingTabRef.current = null;
          return;
        }

        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        targetTabId = newTab.id;
        setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
      }

      // ========================================
      // Scenario 4: Normal switch (or Scenario 3 continuation)
      // Using Session-centric API: Tab becomes owner of Session's Sidecar
      // ========================================
      console.log(`[App] Scenario 4: Normal launch - tab ${targetTabId}, project: ${project.path}, sessionId: ${sessionId}`);

      // If current tab has an active session, release it before launching new one
      const currentTabForLaunch = tabs.find(t => t.id === targetTabId);
      const oldSessionForLaunch = currentTabForLaunch?.sessionId;
      if (oldSessionForLaunch) {
        const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
        if (bgResult.started) {
          console.log(`[App] Scenario 4: AI running on ${oldSessionForLaunch}, background completion started`);
        }
        // Always release old session regardless of AI state:
        // - If BG started: Sidecar stays alive via BG owner
        // - If idle: Sidecar stops (no more owners)
        await stopSseProxy(targetTabId);
        await releaseSessionSidecar(oldSessionForLaunch, 'tab', targetTabId);
        await deactivateSession(oldSessionForLaunch);
      }

      // Cancel background completion on target session if reconnecting
      if (sessionId) {
        await cancelBackgroundCompletion(sessionId);
      }

      // For new sessions (no sessionId), generate a temporary session ID
      // The actual session ID will be created by the backend when the session starts
      const effectiveSessionId = sessionId ?? createPendingSessionId(targetTabId);

      // Ensure Sidecar is running for this Session, Tab as owner
      const result = await ensureSessionSidecar(effectiveSessionId, project.path, 'tab', targetTabId);
      console.log(`[App] Session Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);

      // Activate session with Tab (for Session singleton tracking and fallback port lookup)
      // Always use effectiveSessionId to ensure session_activations has entry for this Tab
      await activateSession(effectiveSessionId, targetTabId, null, result.port, project.path, false);

      // Update tab state with effectiveSessionId (matches the Sidecar's session)
      // For new sessions, this is "pending-{tabId}" until backend creates the real session
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: effectiveSessionId,
              view: 'chat',
              title: getFolderName(project.path),
              // Only set initialMessage when explicitly provided (from Launcher send).
              // Omitting undefined prevents overwriting a prior initialMessage in race conditions.
              ...(initialMessage ? { initialMessage } : {}),
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
      launchingTabRef.current = null;
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
    }
  }, [activeTabId, tabs]);

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, initialMessage: undefined } : t
    ));
  }, []);

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

    // Scenario 2: Session has running cron task (no Tab) → Add Tab as owner to existing Sidecar
    const activation = await getSessionActivation(sessionId);
    if (activation && activation.task_id) {
      console.log(`[App] handleSwitchSession Scenario 2: Session ${sessionId} has cron task ${activation.task_id}`);

      // Get current tab info to find agentDir
      const currentTab = tabs.find(t => t.id === tabId);
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      const oldSessionId = currentTab.sessionId;

      try {
        // Step 1: Add Tab as owner to the cron task's Sidecar FIRST
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
        console.log(`[App] Tab ${tabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);
        await updateSessionTab(sessionId, tabId);

        // Step 2: Stop SSE proxy FIRST before releasing old session (avoids EOF errors)
        if (oldSessionId) {
          await stopSseProxy(tabId);
          const stopped = await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          console.log(`[App] Released old session ${oldSessionId}, sidecar stopped: ${stopped}`);
        }

        // Step 3: Update UI state (TabProvider will reconnect SSE to new Sidecar)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                ...t,
                sessionId,
              }
              : t
          )
        );
      } catch (error) {
        console.error('[App] Failed to switch to cron task session:', error);
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
        // Ensure Sidecar for new Tab as owner of this Session
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', newTab.id);
        console.log(`[App] New tab ${newTab.id} Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);

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
        console.error('[App] Failed to ensure Sidecar for new tab:', error);
        // Remove the failed tab
        setTabs((prev) => prev.filter(t => t.id !== newTab.id));
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
      return;
    }

    // Scenario 4: Normal switch
    //
    // Two sub-paths:
    // A) AI is idle → hot-swap Sidecar via upgradeSessionId (no new process)
    // B) AI is running → start background completion for old session,
    //    release Tab from old Sidecar, create new Sidecar for new session
    console.log(`[App] handleSwitchSession Scenario 4: Switching tab ${tabId} to session ${sessionId}`);

    // Get current tab info
    const currentTab = tabs.find(t => t.id === tabId);
    if (!currentTab?.agentDir) {
      console.error('[App] Cannot switch: current tab has no agentDir');
      return;
    }

    const oldSessionId = currentTab.sessionId;

    try {
      // First, cancel any background completion on the TARGET session (user reconnecting)
      await cancelBackgroundCompletion(sessionId);

      if (oldSessionId) {
        // Check if AI is running on old session → background completion
        const bgResult = await startBackgroundCompletion(oldSessionId);

        if (bgResult.started) {
          // AI is running → old Sidecar stays alive via BG owner, create new Sidecar for target
          console.log(`[App] AI running on ${oldSessionId}, starting background completion`);
          await stopSseProxy(tabId);
          await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          await deactivateSession(oldSessionId);

          // Create/reuse Sidecar for the target session
          const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
          await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
          console.log(`[App] Created new Sidecar for session ${sessionId} on port ${result.port}`);
        } else {
          // AI is idle → check if target session already has a sidecar (e.g., from BG completion)
          // If yes, we can't use upgradeSessionId — it would overwrite the existing sidecar
          const targetPort = await getSessionPort(sessionId);

          if (targetPort !== null) {
            // Target session has existing sidecar → release current, reconnect to existing
            console.log(`[App] Target session ${sessionId} has existing sidecar on port ${targetPort}, reconnecting`);
            await stopSseProxy(tabId);
            await releaseSessionSidecar(oldSessionId, 'tab', tabId);
            await deactivateSession(oldSessionId);
            const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
            await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
          } else {
            // No existing sidecar for target → hot-swap via upgradeSessionId (efficient, no new process)
            const upgraded = await upgradeSessionId(oldSessionId, sessionId);

            if (upgraded) {
              await deactivateSession(oldSessionId);
              const port = await getSessionPort(sessionId);
              if (port !== null) {
                await activateSession(sessionId, tabId, null, port, currentTab.agentDir, false);
                console.log(`[App] Session ${sessionId} took over Sidecar from ${oldSessionId} on port ${port}`);
              } else {
                console.warn(`[App] Port not found after upgrade, creating new Sidecar`);
                const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
                await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
              }
            } else {
              console.log(`[App] Sidecar upgrade failed, creating new Sidecar for session ${sessionId}`);
              await deactivateSession(oldSessionId);
              const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
              await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
            }
          }
        }
      } else {
        // No old Session → Create new Sidecar
        console.log(`[App] No previous session, creating new Sidecar for session ${sessionId}`);
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
        await activateSession(sessionId, tabId, null, result.port, currentTab.agentDir, false);
      }

      // Update UI state - TabProvider will detect sessionId change and call loadSession()
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId }
            : t
        )
      );
      console.log(`[App] handleSwitchSession Scenario 4 complete: tab ${tabId} now on session ${sessionId}`);
    } catch (error) {
      console.error('[App] Failed to switch session:', error);
    }
  }, [tabs]);

  const handleBackToLauncher = useCallback(async () => {
    if (!activeTabId) return;

    // Get current tab to access sessionId
    const currentTab = tabs.find(t => t.id === activeTabId);

    // Step 1: Try to start background completion if AI is running
    if (currentTab?.sessionId) {
      const bgResult = await startBackgroundCompletion(currentTab.sessionId);
      if (bgResult.started) {
        console.log(`[App] Back to launcher: AI still running, background completion started for session ${currentTab.sessionId}`);
      }
    }

    // Step 2: Stop SSE proxy FIRST to avoid EOF errors when Sidecar stops
    await stopSseProxy(activeTabId);

    // Step 3: Release Tab's ownership of the Session Sidecar
    // If BackgroundCompletion or CronTask also owns it, Sidecar continues running
    if (currentTab?.sessionId) {
      try {
        // Check if this Tab has an active cron task to update associations
        const cronTask = await getTabCronTask(activeTabId);
        if (cronTask && cronTask.status === 'running') {
          // Clear tab association in cron task
          await updateCronTaskTab(cronTask.id, undefined);
          // Update session activation to remove tab_id but keep task_id
          await updateSessionTab(currentTab.sessionId, undefined);
        }

        // Release Tab's ownership - Sidecar stops only if no other owners
        const stopped = await releaseSessionSidecar(currentTab.sessionId, 'tab', activeTabId);
        console.log(`[App] Tab ${activeTabId} released session ${currentTab.sessionId}, sidecar stopped: ${stopped}`);

        // Clean up session activation (Tab no longer owns this session)
        // If cron task is active, updateSessionTab above already handled it
        if (!cronTask || cronTask.status !== 'running') {
          await deactivateSession(currentTab.sessionId);
        }
      } catch (error) {
        console.error(`[App] Error releasing session sidecar for tab ${activeTabId}:`, error);
        // Fallback to legacy stopTabSidecar
        void stopTabSidecar(activeTabId);
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

  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(async (tabId: string): Promise<boolean> => {
    const currentTab = tabs.find(t => t.id === tabId);
    if (!currentTab?.sessionId || !currentTab?.agentDir) {
      return false;
    }

    const oldSessionId = currentTab.sessionId;

    // Check if AI is running → start background completion
    const bgResult = await startBackgroundCompletion(oldSessionId);
    if (!bgResult.started) {
      // AI is idle → let Chat handle it via resetSession (more efficient, reuses Sidecar)
      return false;
    }

    // AI is running → release old Sidecar (BG owner keeps it alive), create new one
    console.log(`[App] handleNewSession: AI running on ${oldSessionId}, background completion started`);

    try {
      await stopSseProxy(tabId);
      await releaseSessionSidecar(oldSessionId, 'tab', tabId);
      await deactivateSession(oldSessionId);

      // Create new pending session with new Sidecar
      const pendingSessionId = createPendingSessionId(tabId);
      const result = await ensureSessionSidecar(pendingSessionId, currentTab.agentDir, 'tab', tabId);
      await activateSession(pendingSessionId, tabId, null, result.port, currentTab.agentDir, false);

      // Update tab state → TabProvider will detect sessionId change and reconnect
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId: pendingSessionId }
            : t
        )
      );
      console.log(`[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId} on port ${result.port}`);
      return true;
    } catch (error) {
      console.error('[App] handleNewSession failed:', error);
      return false;
    }
  }, [tabs]);

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

  // Note: CRON_TASK_STOPPED event listener removed
  // With Session-centric Sidecar (Owner model), stopping a cron task only releases
  // the CronTask owner. If Tab still owns the Sidecar, it continues running.
  // No SSE reconnection or Sidecar restart is needed.

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
                />
              ) : tab.view === 'settings' ? (
                <Settings
                  initialSection={settingsInitialSection}
                  onSectionChange={() => setSettingsInitialSection(undefined)}
                  updateReady={updateReady}
                  updateVersion={updateVersion}
                  updateChecking={updateChecking}
                  updateDownloading={updateDownloading}
                  onCheckForUpdate={checkForUpdate}
                  onRestartAndUpdate={handleRestartAndUpdate}
                />
              ) : (
                /* Chat views use Tab Sidecar - wrapped in TabProvider */
                <TabProvider
                  tabId={tab.id}
                  agentDir={tab.agentDir ?? ''}
                  sessionId={tab.sessionId}
                  isActive={isActive}
                  onGeneratingChange={(isGenerating) => updateTabGenerating(tab.id, isGenerating)}
                  onSessionIdChange={(newSessionId) => updateTabSessionId(tab.id, newSessionId)}
                >
                  <Chat
                    onBack={handleBackToLauncher}
                    onSwitchSession={(sessionId) => handleSwitchSession(tab.id, sessionId)}
                    onNewSession={() => handleNewSession(tab.id)}
                    initialMessage={tab.initialMessage}
                    onInitialMessageConsumed={() => clearInitialMessage(tab.id)}
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
          message={`有 ${exitConfirmState.runningTaskCount} 个心跳循环正在运行中。退出后任务将被停止。确定要退出吗？`}
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
