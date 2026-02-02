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
    execute_cron_task, CronExecutePayload, ManagedSidecarManager, ProviderEnv, UserRef,
};

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task is paused (can be resumed)
    Paused,
    /// Task was stopped manually
    Stopped,
    /// Task completed (all end conditions met)
    Completed,
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

        let tasks = Arc::clone(&self.tasks);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id_owned = task_id.to_string();
        let interval_mins = task.interval_minutes;

        // Spawn the scheduler loop
        tokio::spawn(async move {
            log::info!("[CronTask] Scheduler started for task {} (interval: {} min)", task_id_owned, interval_mins);

            // Create interval timer
            let mut timer = interval(Duration::from_secs(interval_mins as u64 * 60));

            // Skip the first immediate tick - we don't want to trigger immediately
            // The first execution happens when the task is created (if desired)
            timer.tick().await;

            loop {
                // Wait for next interval
                timer.tick().await;

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
                        complete_task_internal(handle, &tasks, &task_id_owned, None).await;
                    }
                    break;
                }

                // Check if task is currently executing (overlap prevention)
                {
                    let executing = executing_tasks.read().await;
                    if executing.contains(&task_id_owned) {
                        log::warn!("[CronTask] Task {} is still executing, skipping this interval", task_id_owned);
                        continue;
                    }
                }

                // Get app handle for execution
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    log::error!("[CronTask] No app handle available for task {}", task_id_owned);
                    continue;
                };

                // Mark task as executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.insert(task_id_owned.clone());
                }

                let is_first = task.execution_count == 0;
                log::info!("[CronTask] Executing task {} (execution #{})", task_id_owned, task.execution_count + 1);

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
                            complete_task_internal(&handle, &tasks, &task_id_owned, Some(reason)).await;
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
                                complete_task_internal(&handle, &tasks, &task_id_owned, None).await;
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
            status: TaskStatus::Paused, // Start paused, caller must explicitly start
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
    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.workspace_path == workspace_path)
            .cloned()
            .collect()
    }

    /// Get active task for a specific session (running or paused)
    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| {
                t.session_id == session_id
                    && (t.status == TaskStatus::Running || t.status == TaskStatus::Paused)
            })
            .cloned()
    }

    /// Get active task for a specific tab (running or paused)
    pub async fn get_active_task_for_tab(&self, tab_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| {
                t.tab_id.as_deref() == Some(tab_id)
                    && (t.status == TaskStatus::Running || t.status == TaskStatus::Paused)
            })
            .cloned()
    }

    /// Start a task (begin scheduling)
    pub async fn start_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status == TaskStatus::Completed || task.status == TaskStatus::Stopped {
            return Err(format!("Cannot start task in {} status", serde_json::to_string(&task.status).unwrap_or_default()));
        }

        task.status = TaskStatus::Running;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Started task: {}", task_id);

        Ok(task_clone)
    }

    /// Pause a task
    pub async fn pause_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status != TaskStatus::Running {
            return Err(format!("Cannot pause task in {} status", serde_json::to_string(&task.status).unwrap_or_default()));
        }

        task.status = TaskStatus::Paused;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Paused task: {}", task_id);

        Ok(task_clone)
    }

    /// Stop a task (cannot be restarted)
    /// Also deactivates the associated session and unregisters the CronTask user
    pub async fn stop_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        task.status = TaskStatus::Stopped;
        let task_clone = task.clone();
        drop(tasks);

        // Unregister CronTask user (reference counting)
        self.unregister_cron_task_user_internal(&workspace_path, task_id).await;

        // Deactivate session via app handle
        self.deactivate_session_internal(&session_id).await;

        self.save_to_disk().await?;
        log::info!("[CronTask] Stopped task: {} (session {} deactivated, CronTask user unregistered)", task_id, session_id);

        Ok(task_clone)
    }

    /// Complete a task (with optional exit reason from AI)
    /// Also deactivates the associated session and unregisters the CronTask user
    pub async fn complete_task(&self, task_id: &str, exit_reason: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        task.status = TaskStatus::Completed;
        task.exit_reason = exit_reason;
        let task_clone = task.clone();
        drop(tasks);

        // Unregister CronTask user (reference counting)
        self.unregister_cron_task_user_internal(&workspace_path, task_id).await;

        // Deactivate session via app handle
        self.deactivate_session_internal(&session_id).await;

        self.save_to_disk().await?;
        log::info!("[CronTask] Completed task: {} (session {} deactivated, CronTask user unregistered)", task_id, session_id);

        Ok(task_clone)
    }

    /// Internal helper to deactivate a session via SidecarManager
    async fn deactivate_session_internal(&self, session_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                if let Ok(mut manager) = sidecar_state.lock() {
                    manager.deactivate_session(session_id);
                    log::debug!("[CronTask] Deactivated session: {}", session_id);
                }
            }
        }
    }

    /// Internal helper to unregister a CronTask user from the workspace (reference counting)
    async fn unregister_cron_task_user_internal(&self, workspace_path: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                if let Ok(mut manager) = sidecar_state.lock() {
                    let user = UserRef::CronTask(task_id.to_string());
                    let should_stop = manager.unregister_user(workspace_path, &user);
                    log::info!(
                        "[CronTask] Unregistered CronTask {} from workspace {}, should_stop: {}",
                        task_id, workspace_path, should_stop
                    );
                    // Note: We don't actually stop the Sidecar here - that's handled by stop_tab_sidecar
                    // when all users are unregistered
                }
            }
        }
    }

    /// Delete a task
    /// Also deactivates the associated session if task was active and unregisters the CronTask user
    pub async fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.remove(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        let was_active = task.status == TaskStatus::Running || task.status == TaskStatus::Paused;
        drop(tasks);

        // Unregister CronTask user and deactivate session if task was active
        if was_active {
            self.unregister_cron_task_user_internal(&workspace_path, task_id).await;
            self.deactivate_session_internal(&session_id).await;
        }

        self.save_to_disk().await?;
        log::info!("[CronTask] Deleted task: {} (was_active: {}, unregistered: {})", task_id, was_active, was_active);

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
        let should_complete = self.check_end_conditions(task);
        if should_complete {
            task.status = TaskStatus::Completed;
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

/// Complete a task, unregister CronTask user, and deactivate its session (internal helper)
async fn complete_task_internal(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    exit_reason: Option<String>,
) {
    // Get session ID and workspace path before updating status
    let (session_id, workspace_path) = {
        let tasks_guard = tasks.read().await;
        tasks_guard.get(task_id).map(|t| (t.session_id.clone(), t.workspace_path.clone())).unzip()
    };

    // Unregister CronTask user (reference counting) and deactivate session
    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        if let Ok(mut manager) = sidecar_state.lock() {
            // Unregister CronTask user
            if let Some(ref wp) = workspace_path {
                let user = UserRef::CronTask(task_id.to_string());
                let should_stop = manager.unregister_user(wp, &user);
                log::info!(
                    "[CronTask] Unregistered CronTask {} from workspace {}, should_stop: {}",
                    task_id, wp, should_stop
                );
            }

            // Deactivate session
            if let Some(ref sid) = session_id {
                manager.deactivate_session(sid);
                log::info!("[CronTask] Deactivated session {} for completed task {}", sid, task_id);
            }
        }
    }

    // Update task status
    {
        let mut tasks_guard = tasks.write().await;
        if let Some(task) = tasks_guard.get_mut(task_id) {
            task.status = TaskStatus::Completed;
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

    // Emit completion event
    let _ = handle.emit("cron:task-completed", serde_json::json!({
        "taskId": task_id,
        "exitReason": exit_reason
    }));

    log::info!("[CronTask] Task {} completed", task_id);
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
#[tauri::command]
pub async fn cmd_start_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.start_task(&task_id).await
}

/// Pause a cron task
#[tauri::command]
pub async fn cmd_pause_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.pause_task(&task_id).await
}

/// Stop a cron task
#[tauri::command]
pub async fn cmd_stop_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.stop_task(&task_id).await
}

/// Complete a cron task (with optional exit reason)
#[tauri::command]
pub async fn cmd_complete_cron_task(task_id: String, exit_reason: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.complete_task(&task_id, exit_reason).await
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

/// Get active cron task for a session (running or paused)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_session(&sessionId).await)
}

/// Get active cron task for a tab (running or paused)
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

/// Start the scheduler for a task (called after task is started)
/// Also registers the CronTask as a user of the workspace's Sidecar (reference counting)
/// This prevents the Sidecar from being stopped when the Tab closes
#[tauri::command]
pub async fn cmd_start_cron_scheduler(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();

    // Get task info for session activation and user registration
    let task = manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;

    // Register CronTask user and activate session
    if let Some(sidecar_state) = app_handle.try_state::<ManagedSidecarManager>() {
        if let Ok(mut sidecar_manager) = sidecar_state.lock() {
            // Register this CronTask as a user of the workspace (reference counting)
            sidecar_manager.register_user(
                &task.workspace_path,
                UserRef::CronTask(task.id.clone()),
            );
            log::info!(
                "[CronTask] Registered CronTask {} as user of workspace {}",
                task.id, task.workspace_path
            );

            // Also activate session for legacy compatibility
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
                        port,
                        task.workspace_path.clone(),
                        true, // is_cron_task = true
                    );
                }
            }
        }
    }

    // Start the scheduler
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
