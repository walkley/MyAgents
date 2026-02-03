// Cron Task Manager for MyAgents
// Manages scheduled task execution with persistence and recovery
// Includes Rust-layer scheduler that directly executes tasks via Sidecar
//
// Key responsibilities:
// - Task lifecycle management (create, start, pause, stop, complete)
// - Interval-based scheduling with overlap prevention
// - Session activation/deactivation coordination with SidecarManager
// - Persistence to ~/.myagents/cron_tasks.json with auto-recovery on startup

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};
use uuid::Uuid;

use crate::sidecar::{
    execute_cron_task, CronExecutePayload, ManagedSidecarManager, ProviderEnv,
};

/// Normalize a path for comparison (removes trailing slashes)
/// This ensures consistent path matching regardless of how paths are formatted
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string() // Keep original if it's root path
    } else {
        trimmed.to_string()
    }
}

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status (simplified: only Running and Stopped)
/// Stopped includes: manual stop, end conditions met, AI exit
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task was stopped (includes: manual stop, end conditions met, AI exit)
    Stopped,
}

/// End conditions for a cron task
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndConditions {
    /// Task will stop after this time (ISO timestamp)
    pub deadline: Option<DateTime<Utc>>,
    /// Task will stop after this many executions
    pub max_executions: Option<u32>,
    /// Allow AI to exit the task via ExitCronTask tool
    pub ai_can_exit: bool,
}

/// Provider environment for task execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// A scheduled cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    pub end_conditions: EndConditions,
    pub run_mode: RunMode,
    pub status: TaskStatus,
    pub execution_count: u32,
    pub created_at: DateTime<Utc>,
    pub last_executed_at: Option<DateTime<Utc>>,
    pub notify_enabled: bool,
    /// Tab ID associated with this task (for frontend reference)
    pub tab_id: Option<String>,
    /// Exit reason (set when AI calls ExitCronTask)
    pub exit_reason: Option<String>,
    /// Permission mode for execution (auto, plan, fullAgency, custom)
    #[serde(default)]
    pub permission_mode: String,
    /// Model to use for execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider environment (API key, base URL)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    /// Last error message (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Configuration for creating a new cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
}

fn default_true() -> bool {
    true
}

impl Default for RunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

/// Persistent storage for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CronTaskStore {
    tasks: Vec<CronTask>,
}

/// Event payload for cron task execution trigger
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskTriggerPayload {
    pub task_id: String,
    pub prompt: String,
    pub is_first_execution: bool,
    pub ai_can_exit: bool,
    pub workspace_path: String,
    pub session_id: String,
    pub run_mode: RunMode,
    pub notify_enabled: bool,
    pub tab_id: Option<String>,
}

/// Manager for cron tasks
pub struct CronTaskManager {
    tasks: Arc<RwLock<HashMap<String, CronTask>>>,
    storage_path: PathBuf,
    /// Flag to stop all scheduler loops
    shutdown: Arc<RwLock<bool>>,
    /// Track which tasks are currently executing (for overlap prevention)
    executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Track which tasks have active schedulers (prevents duplicate scheduler spawns)
    active_schedulers: Arc<RwLock<HashSet<String>>>,
    /// Tauri app handle for emitting events (set after initialization)
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl CronTaskManager {
    /// Create a new CronTaskManager with persistence at ~/.myagents/cron_tasks.json
    pub fn new() -> Self {
        let storage_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".myagents")
            .join("cron_tasks.json");

        // Load persisted tasks synchronously before creating the manager
        // This avoids the need for block_on with async locks
        let initial_tasks = Self::load_tasks_from_file(&storage_path);

        let task_count = initial_tasks.len();
        let manager = Self {
            tasks: Arc::new(RwLock::new(initial_tasks)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        };

        if task_count > 0 {
            log::info!("[CronTask] Loaded {} tasks from disk", task_count);
        }

        manager
    }

    /// Load tasks from file synchronously (used during initialization)
    /// Returns empty HashMap on any error (logged as warning)
    fn load_tasks_from_file(storage_path: &PathBuf) -> HashMap<String, CronTask> {
        if !storage_path.exists() {
            return HashMap::new();
        }

        let content = match fs::read_to_string(storage_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[CronTask] Failed to read cron tasks file: {}", e);
                return HashMap::new();
            }
        };

        let store: CronTaskStore = match serde_json::from_str(&content) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[CronTask] Failed to parse cron tasks JSON: {}", e);
                return HashMap::new();
            }
        };

        store.tasks.into_iter().map(|t| (t.id.clone(), t)).collect()
    }

    /// Set the Tauri app handle for emitting events
    /// Must be called during app setup before starting any tasks
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.write().await;
        *app_handle = Some(handle);
        log::info!("[CronTask] App handle set");
    }

    /// Start the scheduler for a task
    /// This spawns a background tokio task that directly executes via Sidecar at intervals
    pub async fn start_task_scheduler(&self, task_id: &str) -> Result<(), String> {
        let task = self.get_task(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status != TaskStatus::Running {
            return Err(format!("Task {} is not in running status", task_id));
        }

        // Check if scheduler is already running for this task
        {
            let active = self.active_schedulers.read().await;
            if active.contains(task_id) {
                log::info!("[CronTask] Scheduler already running for task {}, skipping", task_id);
                return Ok(());
            }
        }

        // Mark scheduler as active
        {
            let mut active = self.active_schedulers.write().await;
            active.insert(task_id.to_string());
        }

        let tasks = Arc::clone(&self.tasks);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let active_schedulers = Arc::clone(&self.active_schedulers);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id_owned = task_id.to_string();
        let interval_mins = task.interval_minutes;
        let last_executed = task.last_executed_at;
        let execution_count = task.execution_count;

        // Spawn the scheduler loop
        tokio::spawn(async move {
            log::info!("[CronTask] Scheduler started for task {} (interval: {} min, executions: {})", task_id_owned, interval_mins, execution_count);

            // Wait for app_handle to be available (with timeout)
            // This handles the race condition where scheduler starts before initialize_cron_manager completes
            let mut app_handle_ready = false;
            for i in 0..50 {  // 5 seconds max wait (50 * 100ms)
                let handle_opt = app_handle.read().await;
                if handle_opt.is_some() {
                    app_handle_ready = true;
                    break;
                }
                drop(handle_opt);
                if i == 0 {
                    log::warn!("[CronTask] App handle not ready for task {}, waiting...", task_id_owned);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            if !app_handle_ready {
                log::error!("[CronTask] App handle not available after 5 seconds, aborting scheduler for task {}", task_id_owned);
                // Clean up: remove from active schedulers
                {
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                }
                return;
            }

            // Emit scheduler started event to frontend
            {
                let handle_opt = app_handle.read().await;
                if let Some(ref handle) = *handle_opt {
                    let _ = handle.emit("cron:scheduler-started", serde_json::json!({
                        "taskId": task_id_owned,
                        "intervalMinutes": interval_mins,
                        "executionCount": execution_count
                    }));
                }
            }

            // Calculate initial wait time
            // - First execution (execution_count == 0): execute immediately (2s delay for UI readiness)
            // - Subsequent executions: calculate based on last_executed_at
            let interval_duration = Duration::from_secs(interval_mins as u64 * 60);
            let initial_wait = if execution_count == 0 {
                // First execution - execute immediately with small delay for UI to be ready
                log::info!("[CronTask] Task {} first execution, starting in 2 seconds", task_id_owned);
                Duration::from_secs(2)
            } else if let Some(last_exec) = last_executed {
                let now = Utc::now();
                let next_exec = last_exec + chrono::Duration::minutes(interval_mins as i64);
                if next_exec > now {
                    // Wait until next scheduled time
                    let wait_secs = (next_exec - now).num_seconds().max(0) as u64;
                    log::info!(
                        "[CronTask] Task {} next execution in {} seconds (based on lastExecutedAt)",
                        task_id_owned, wait_secs
                    );
                    Duration::from_secs(wait_secs)
                } else {
                    // Already past due, execute soon
                    log::info!("[CronTask] Task {} is past due, executing in 5 seconds", task_id_owned);
                    Duration::from_secs(5)
                }
            } else {
                // No previous execution but execution_count > 0 (edge case, shouldn't happen)
                // Wait full interval to be safe
                log::info!("[CronTask] Task {} no lastExecutedAt but count={}, waiting full interval", task_id_owned, execution_count);
                interval_duration
            };

            // Wait for initial period
            tokio::time::sleep(initial_wait).await;

            // Create interval timer for subsequent executions
            let mut timer = interval(interval_duration);
            // Skip the first immediate tick since we already waited
            timer.tick().await;

            loop {

                // Check shutdown flag
                {
                    let shutdown_flag = shutdown.read().await;
                    if *shutdown_flag {
                        log::info!("[CronTask] Scheduler shutdown for task {}", task_id_owned);
                        break;
                    }
                }

                // Check task status
                let task_opt = {
                    let tasks_guard = tasks.read().await;
                    tasks_guard.get(&task_id_owned).cloned()
                };

                let task = match task_opt {
                    Some(t) => t,
                    None => {
                        log::info!("[CronTask] Task {} no longer exists, stopping scheduler", task_id_owned);
                        break;
                    }
                };

                // Only execute if task is still running
                if task.status != TaskStatus::Running {
                    log::info!("[CronTask] Task {} status changed to {:?}, stopping scheduler", task_id_owned, task.status);
                    break;
                }

                // Check end conditions before execution
                let should_complete = check_end_conditions_static(&task);
                if should_complete {
                    log::info!("[CronTask] Task {} reached end condition, completing", task_id_owned);
                    // Complete task and deactivate session
                    if let Some(ref handle) = *app_handle.read().await {
                        stop_task_internal(handle, &tasks, &task_id_owned, None).await;
                    }
                    break;
                }

                // Check if task is currently executing (overlap prevention)
                {
                    let executing = executing_tasks.read().await;
                    if executing.contains(&task_id_owned) {
                        log::warn!("[CronTask] Task {} is still executing, skipping this interval", task_id_owned);
                        // Wait for next interval before checking again
                        timer.tick().await;
                        continue;
                    }
                }

                // Get app handle for execution
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    log::error!("[CronTask] No app handle available for task {}, will retry next interval", task_id_owned);
                    // Wait for next interval before retrying (prevents tight loop)
                    timer.tick().await;
                    continue;
                };

                // Mark task as executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.insert(task_id_owned.clone());
                }

                let is_first = task.execution_count == 0;
                log::info!("[CronTask] Executing task {} (execution #{})", task_id_owned, task.execution_count + 1);

                // Emit execution starting event to frontend
                let _ = handle.emit("cron:execution-starting", serde_json::json!({
                    "taskId": task_id_owned,
                    "executionNumber": task.execution_count + 1,
                    "isFirstExecution": is_first
                }));

                // Execute directly via Sidecar
                let execution_result = execute_task_directly(&handle, &task, is_first).await;

                // Mark task as no longer executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.remove(&task_id_owned);
                }

                // Handle execution result
                match execution_result {
                    Ok((success, ai_exit_reason)) => {
                        // Update execution count and last_executed_at
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                t.execution_count += 1;
                                t.last_executed_at = Some(Utc::now());
                                t.last_error = None;
                            }
                        }

                        // Check if AI requested exit
                        if let Some(reason) = ai_exit_reason {
                            log::info!("[CronTask] Task {} AI requested exit: {}", task_id_owned, reason);
                            stop_task_internal(&handle, &tasks, &task_id_owned, Some(reason)).await;
                            break;
                        }

                        // Check end conditions after execution
                        let task_updated = {
                            let tasks_guard = tasks.read().await;
                            tasks_guard.get(&task_id_owned).cloned()
                        };
                        if let Some(t) = task_updated {
                            if check_end_conditions_static(&t) {
                                log::info!("[CronTask] Task {} reached end condition after execution", task_id_owned);
                                stop_task_internal(&handle, &tasks, &task_id_owned, None).await;
                                break;
                            }
                        }

                        // Emit event for frontend UI update (optional)
                        let _ = handle.emit("cron:execution-complete", serde_json::json!({
                            "taskId": task_id_owned,
                            "success": success,
                            "executionCount": task.execution_count + 1
                        }));
                    }
                    Err(e) => {
                        log::error!("[CronTask] Task {} execution failed: {}", task_id_owned, e);
                        // Update last_error
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                t.last_error = Some(e.clone());
                            }
                        }
                        // Emit error event for frontend
                        let _ = handle.emit("cron:execution-error", serde_json::json!({
                            "taskId": task_id_owned,
                            "error": e
                        }));
                        // Continue to next interval (don't break on error)
                    }
                }

                // Save updated state
                if let Some(parent) = dirs::home_dir() {
                    let storage_path = parent.join(".myagents").join("cron_tasks.json");
                    let tasks_guard = tasks.read().await;
                    let store = CronTaskStore {
                        tasks: tasks_guard.values().cloned().collect(),
                    };
                    if let Ok(content) = serde_json::to_string_pretty(&store) {
                        let _ = fs::write(&storage_path, content);
                    }
                }

                // Wait for the next interval before checking/executing again
                // This is critical - without this, the loop would run continuously
                log::info!("[CronTask] Task {} waiting {} minutes for next execution", task_id_owned, interval_mins);
                timer.tick().await;
            }

            // Clean up: remove from active schedulers
            {
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
            }
            log::info!("[CronTask] Scheduler loop exited for task {}", task_id_owned);
        });

        Ok(())
    }

    /// Mark a task as currently executing (called when execution starts)
    pub async fn mark_task_executing(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.insert(task_id.to_string());
        log::debug!("[CronTask] Task {} marked as executing", task_id);
    }

    /// Mark a task as no longer executing (called when execution completes)
    pub async fn mark_task_complete(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.remove(task_id);
        log::debug!("[CronTask] Task {} marked as complete", task_id);
    }

    /// Check if a task is currently executing
    pub async fn is_task_executing(&self, task_id: &str) -> bool {
        let executing = self.executing_tasks.read().await;
        executing.contains(task_id)
    }

    /// Save tasks to disk
    async fn save_to_disk(&self) -> Result<(), String> {
        let tasks = self.tasks.read().await;
        let store = CronTaskStore {
            tasks: tasks.values().cloned().collect(),
        };

        let content = serde_json::to_string_pretty(&store)
            .map_err(|e| format!("Failed to serialize cron tasks: {}", e))?;

        // Ensure directory exists
        if let Some(parent) = self.storage_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create cron tasks directory: {}", e))?;
        }

        fs::write(&self.storage_path, content)
            .map_err(|e| format!("Failed to write cron tasks file: {}", e))?;

        log::debug!("[CronTask] Saved {} tasks to disk", tasks.len());
        Ok(())
    }

    /// Create a new cron task (does not start it)
    pub async fn create_task(&self, config: CronTaskConfig) -> Result<CronTask, String> {
        // Validate minimum interval (15 minutes)
        if config.interval_minutes < 15 {
            return Err("Interval must be at least 15 minutes".to_string());
        }

        let task = CronTask {
            id: format!("cron_{}", Uuid::new_v4().to_string().replace("-", "")[..12].to_string()),
            workspace_path: config.workspace_path,
            session_id: config.session_id,
            prompt: config.prompt,
            interval_minutes: config.interval_minutes,
            end_conditions: config.end_conditions,
            run_mode: config.run_mode,
            status: TaskStatus::Stopped, // Start stopped, caller must explicitly start
            execution_count: 0,
            created_at: Utc::now(),
            last_executed_at: None,
            notify_enabled: config.notify_enabled,
            tab_id: config.tab_id,
            exit_reason: None,
            permission_mode: config.permission_mode,
            model: config.model,
            provider_env: config.provider_env,
            last_error: None,
        };

        let mut tasks = self.tasks.write().await;
        tasks.insert(task.id.clone(), task.clone());
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Created task: {}", task.id);

        Ok(task)
    }

    /// Get a task by ID
    pub async fn get_task(&self, task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned()
    }

    /// Get all tasks
    pub async fn get_all_tasks(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }

    /// Get tasks for a specific workspace
    /// Uses normalized path comparison to handle trailing slashes and other inconsistencies
    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        let normalized_query = normalize_path(workspace_path);
        let result: Vec<CronTask> = tasks
            .values()
            .filter(|t| normalize_path(&t.workspace_path) == normalized_query)
            .cloned()
            .collect();

        log::debug!(
            "[CronTask] get_tasks_for_workspace: query='{}' (normalized='{}'), found {} tasks",
            workspace_path, normalized_query, result.len()
        );

        result
    }

    /// Get active task for a specific session (running only)
    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.session_id == session_id && t.status == TaskStatus::Running)
            .cloned()
    }

    /// Get active task for a specific tab (running only)
    pub async fn get_active_task_for_tab(&self, tab_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.tab_id.as_deref() == Some(tab_id) && t.status == TaskStatus::Running)
            .cloned()
    }

    /// Start a task (begin scheduling)
    /// Can start a task in Stopped status (e.g., after creation or after previous stop)
    pub async fn start_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status == TaskStatus::Running {
            return Err("Task is already running".to_string());
        }

        task.status = TaskStatus::Running;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Started task: {}", task_id);

        Ok(task_clone)
    }

    /// Stop a task (with optional exit reason)
    /// Also deactivates the associated session and unregisters the CronTask user
    /// exit_reason can be set when AI calls ExitCronTask tool or end conditions are met
    pub async fn stop_task(&self, task_id: &str, exit_reason: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        task.status = TaskStatus::Stopped;
        task.exit_reason = exit_reason;
        let task_clone = task.clone();
        drop(tasks);

        // Stop the cron task Sidecar
        self.stop_cron_task_sidecar_internal(&workspace_path, task_id).await;

        // Deactivate session via app handle
        self.deactivate_session_internal(&session_id).await;

        self.save_to_disk().await?;
        log::info!("[CronTask] Stopped task: {} (session {} deactivated, Sidecar stopped)", task_id, session_id);

        Ok(task_clone)
    }

    /// Internal helper to deactivate a session via SidecarManager
    async fn deactivate_session_internal(&self, session_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                match sidecar_state.lock() {
                    Ok(mut manager) => {
                        manager.deactivate_session(session_id);
                        log::debug!("[CronTask] Deactivated session: {}", session_id);
                    }
                    Err(e) => {
                        log::error!("[CronTask] Cannot deactivate session {}: lock poisoned: {}", session_id, e);
                    }
                }
            } else {
                log::warn!("[CronTask] Cannot deactivate session {}: SidecarManager state not found", session_id);
            }
        } else {
            log::warn!("[CronTask] Cannot deactivate session {}: app handle not available", session_id);
        }
    }

    /// Internal helper to stop the cron task Sidecar
    /// With the new architecture (1 Tab = 1 Sidecar), cron tasks have their own Sidecars
    async fn stop_cron_task_sidecar_internal(&self, _workspace_path: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                match sidecar_state.lock() {
                    Ok(mut manager) => {
                        // Remove the cron task Sidecar instance
                        if let Some(_instance) = manager.remove_cron_task_instance(task_id) {
                            log::info!(
                                "[CronTask] Stopped cron task Sidecar for task {}",
                                task_id
                            );
                        } else {
                            log::debug!(
                                "[CronTask] No Sidecar instance found for task {} (may have been stopped already)",
                                task_id
                            );
                        }
                    }
                    Err(e) => {
                        log::error!("[CronTask] Cannot stop cron task Sidecar {}: lock poisoned: {}", task_id, e);
                    }
                }
            } else {
                log::warn!("[CronTask] Cannot stop cron task Sidecar {}: SidecarManager state not found", task_id);
            }
        } else {
            log::warn!("[CronTask] Cannot stop cron task Sidecar {}: app handle not available", task_id);
        }
    }

    /// Delete a task
    /// Also deactivates the associated session and stops the Sidecar if task was running
    pub async fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.remove(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        let was_running = task.status == TaskStatus::Running;
        drop(tasks);

        // Stop cron task Sidecar and deactivate session if task was running
        if was_running {
            self.stop_cron_task_sidecar_internal(&workspace_path, task_id).await;
            self.deactivate_session_internal(&session_id).await;
        }

        self.save_to_disk().await?;
        log::info!("[CronTask] Deleted task: {} (was_running: {}, sidecar_stopped: {})", task_id, was_running, was_running);

        Ok(())
    }

    /// Record task execution
    pub async fn record_execution(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.execution_count += 1;
        task.last_executed_at = Some(Utc::now());

        // Check end conditions
        let should_stop = self.check_end_conditions(task);
        if should_stop {
            task.status = TaskStatus::Stopped;
        }

        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Check if task should end based on conditions
    fn check_end_conditions(&self, task: &CronTask) -> bool {
        // Check deadline
        if let Some(deadline) = task.end_conditions.deadline {
            if Utc::now() >= deadline {
                log::info!("[CronTask] Task {} reached deadline", task.id);
                return true;
            }
        }

        // Check max executions
        if let Some(max) = task.end_conditions.max_executions {
            if task.execution_count >= max {
                log::info!("[CronTask] Task {} reached max executions ({})", task.id, max);
                return true;
            }
        }

        false
    }

    /// Get tasks that need to be recovered (running status on app restart)
    pub async fn get_tasks_to_recover(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.status == TaskStatus::Running)
            .cloned()
            .collect()
    }

    /// Update task's tab association
    pub async fn update_task_tab(&self, task_id: &str, tab_id: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.tab_id = tab_id;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Shutdown the manager (stop all scheduler loops)
    pub async fn shutdown(&self) {
        let mut shutdown = self.shutdown.write().await;
        *shutdown = true;
        log::info!("[CronTask] Manager shutdown initiated");
    }

    /// Check if shutdown has been requested
    pub async fn is_shutdown(&self) -> bool {
        let shutdown = self.shutdown.read().await;
        *shutdown
    }
}

// ============ Helper Functions ============

/// Check if task should end based on conditions (static version for use in scheduler)
fn check_end_conditions_static(task: &CronTask) -> bool {
    // Check deadline
    if let Some(deadline) = task.end_conditions.deadline {
        if Utc::now() >= deadline {
            log::info!("[CronTask] Task {} reached deadline", task.id);
            return true;
        }
    }

    // Check max executions
    if let Some(max) = task.end_conditions.max_executions {
        if task.execution_count >= max {
            log::info!("[CronTask] Task {} reached max executions ({})", task.id, max);
            return true;
        }
    }

    false
}

/// Execute a task directly via Sidecar (without going through frontend)
/// Returns (success, ai_exit_reason) tuple
async fn execute_task_directly(
    handle: &AppHandle,
    task: &CronTask,
    is_first_execution: bool,
) -> Result<(bool, Option<String>), String> {
    // Get SidecarManager state
    let sidecar_state = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;

    // Convert run_mode enum to string for payload
    let run_mode_str = match task.run_mode {
        RunMode::SingleSession => "single_session",
        RunMode::NewSession => "new_session",
    };

    // Build execution payload
    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        prompt: task.prompt.clone(),
        session_id: Some(task.session_id.clone()),
        is_first_execution: Some(is_first_execution),
        ai_can_exit: Some(task.end_conditions.ai_can_exit),
        permission_mode: Some(task.permission_mode.clone()),
        model: task.model.clone(),
        provider_env: task.provider_env.as_ref().map(|env| ProviderEnv {
            base_url: env.base_url.clone(),
            api_key: env.api_key.clone(),
        }),
        run_mode: Some(run_mode_str.to_string()),
    };

    // Execute via Sidecar
    let result = execute_cron_task(handle, &sidecar_state, &task.workspace_path, payload).await?;

    // Send notification if enabled
    if task.notify_enabled {
        send_task_notification(handle, task, &result);
    }

    let ai_exit_reason = if result.ai_requested_exit == Some(true) {
        result.exit_reason
    } else {
        None
    };

    Ok((result.success, ai_exit_reason))
}

/// Stop a task, unregister CronTask user, and deactivate its session (internal helper)
/// Used by scheduler when end conditions are met or AI requests exit
async fn stop_task_internal(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    exit_reason: Option<String>,
) {
    // Get session ID and workspace path before updating status
    let task_info = {
        let tasks_guard = tasks.read().await;
        tasks_guard.get(task_id).map(|t| (t.session_id.clone(), t.workspace_path.clone()))
    };

    let Some((session_id, _workspace_path)) = task_info else {
        log::warn!("[CronTask] Task {} not found in stop_task_internal", task_id);
        return;
    };

    // Stop cron task Sidecar and deactivate session
    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        if let Ok(mut manager) = sidecar_state.lock() {
            // Stop the cron task Sidecar
            if let Some(_instance) = manager.remove_cron_task_instance(task_id) {
                log::info!(
                    "[CronTask] Stopped cron task Sidecar for task {}",
                    task_id
                );
            }

            // Deactivate session
            manager.deactivate_session(&session_id);
            log::info!("[CronTask] Deactivated session {} for stopped task {}", session_id, task_id);
        }
    }

    // Update task status
    {
        let mut tasks_guard = tasks.write().await;
        if let Some(task) = tasks_guard.get_mut(task_id) {
            task.status = TaskStatus::Stopped;
            task.exit_reason = exit_reason.clone();
        }
    }

    // Save to disk
    if let Some(parent) = dirs::home_dir() {
        let storage_path = parent.join(".myagents").join("cron_tasks.json");
        let tasks_guard = tasks.read().await;
        let store = CronTaskStore {
            tasks: tasks_guard.values().cloned().collect(),
        };
        if let Ok(content) = serde_json::to_string_pretty(&store) {
            let _ = fs::write(&storage_path, content);
        }
    }

    // Emit stopped event
    let _ = handle.emit("cron:task-stopped", serde_json::json!({
        "taskId": task_id,
        "exitReason": exit_reason
    }));

    log::info!("[CronTask] Task {} stopped", task_id);
}

/// Send system notification for task execution
fn send_task_notification(
    handle: &AppHandle,
    task: &CronTask,
    result: &crate::sidecar::CronExecuteResponse,
) {
    let title = if result.success {
        "定时任务执行完成".to_string()
    } else {
        "定时任务执行失败".to_string()
    };

    let body = if let Some(ref reason) = result.exit_reason {
        format!("AI 主动结束: {}", reason)
    } else if let Some(ref error) = result.error {
        format!("错误: {}", error)
    } else {
        format!("任务 #{} 已完成", task.execution_count + 1)
    };

    // Use tauri notification plugin
    let _ = handle.emit("notification:show", serde_json::json!({
        "title": title,
        "body": body
    }));
}

/// Global singleton instance
static CRON_TASK_MANAGER: std::sync::OnceLock<CronTaskManager> = std::sync::OnceLock::new();

/// Get the global CronTaskManager instance
pub fn get_cron_task_manager() -> &'static CronTaskManager {
    CRON_TASK_MANAGER.get_or_init(CronTaskManager::new)
}

// ============ Tauri Commands ============

/// Create a new cron task
#[tauri::command]
pub async fn cmd_create_cron_task(config: CronTaskConfig) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.create_task(config).await
}

/// Start a cron task
/// The cron task Sidecar will be started on-demand when the first execution runs
#[tauri::command]
pub async fn cmd_start_cron_task(
    _app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    let task = manager.start_task(&task_id).await?;

    log::info!(
        "[CronTask] Started cron task {} for workspace {}",
        task.id, task.workspace_path
    );

    Ok(task)
}

/// Stop a cron task (with optional exit reason)
/// exit_reason can be set when AI calls ExitCronTask or end conditions are met
#[tauri::command]
pub async fn cmd_stop_cron_task(task_id: String, exit_reason: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.stop_task(&task_id, exit_reason).await
}

/// Delete a cron task
#[tauri::command]
pub async fn cmd_delete_cron_task(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.delete_task(&task_id).await
}

/// Get a cron task by ID
#[tauri::command]
pub async fn cmd_get_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))
}

/// Get all cron tasks
#[tauri::command]
pub async fn cmd_get_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_all_tasks().await)
}

/// Get cron tasks for a workspace
#[tauri::command]
pub async fn cmd_get_workspace_cron_tasks(workspace_path: String) -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_for_workspace(&workspace_path).await)
}

/// Get active cron task for a session (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_session(&sessionId).await)
}

/// Get active cron task for a tab (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_tab_cron_task(tabId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_tab(&tabId).await)
}

/// Record task execution (called by Sidecar after execution completes)
#[tauri::command]
pub async fn cmd_record_cron_execution(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.record_execution(&task_id).await
}

/// Update task's tab association
#[tauri::command]
pub async fn cmd_update_cron_task_tab(task_id: String, tab_id: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_tab(&task_id, tab_id).await
}

/// Get tasks that need recovery (tasks that were running before app restart)
#[tauri::command]
pub async fn cmd_get_tasks_to_recover() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_to_recover().await)
}

/// Start the scheduler for a task
/// This function is called both for initial task start and for recovery after app restart.
/// It ensures CronTask user is registered (idempotent) and starts the scheduler loop.
#[tauri::command]
pub async fn cmd_start_cron_scheduler(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();

    // Get task info for session activation
    let task = manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;

    // Activate session if Tab's Sidecar instance exists
    // The cron task will get its own Sidecar when it starts executing
    if let Some(sidecar_state) = app_handle.try_state::<ManagedSidecarManager>() {
        if let Ok(mut sidecar_manager) = sidecar_state.lock() {
            if let Some(tab_id) = &task.tab_id {
                if let Some(instance) = sidecar_manager.get_instance(tab_id) {
                    let port = instance.port;
                    log::info!(
                        "[CronTask] Activating session {} as cron task on port {}",
                        task.session_id, port
                    );
                    sidecar_manager.activate_session(
                        task.session_id.clone(),
                        task.tab_id.clone(),
                        Some(task_id.clone()),  // task_id for Tab connection
                        port,
                        task.workspace_path.clone(),
                        true, // is_cron_task = true
                    );
                }
            }
        }
    }

    // Start the scheduler loop
    manager.start_task_scheduler(&task_id).await
}

/// Mark a task as currently executing (called when execution starts)
#[tauri::command]
pub async fn cmd_mark_task_executing(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_executing(&task_id).await;
    Ok(())
}

/// Mark a task as no longer executing (called when execution completes)
#[tauri::command]
pub async fn cmd_mark_task_complete(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_complete(&task_id).await;
    Ok(())
}

/// Check if a task is currently executing
#[tauri::command]
pub async fn cmd_is_task_executing(task_id: String) -> Result<bool, String> {
    let manager = get_cron_task_manager();
    Ok(manager.is_task_executing(&task_id).await)
}

/// Initialize cron task manager with app handle (called during app setup)
pub async fn initialize_cron_manager(handle: AppHandle) {
    let manager = get_cron_task_manager();
    manager.set_app_handle(handle).await;
    log::info!("[CronTask] Manager initialized with app handle");
}
