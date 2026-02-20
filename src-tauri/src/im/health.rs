// IM Health State — periodic persistence to ~/.myagents/im_state.json
// Used for Desktop UI status display, restart recovery, and diagnostics.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::types::{ImActiveSession, ImHealthState, ImStatus};
use crate::{ulog_info, ulog_warn};

/// Persist interval (seconds)
const PERSIST_INTERVAL_SECS: u64 = 5;

/// Managed health state with periodic persistence
pub struct HealthManager {
    state: Arc<Mutex<ImHealthState>>,
    persist_path: PathBuf,
}

impl HealthManager {
    pub fn new(persist_path: PathBuf) -> Self {
        // Try to load existing state, or start fresh
        let state = if persist_path.exists() {
            match std::fs::read_to_string(&persist_path) {
                Ok(content) => serde_json::from_str::<ImHealthState>(&content).unwrap_or_default(),
                Err(_) => ImHealthState::default(),
            }
        } else {
            ImHealthState::default()
        };

        Self {
            state: Arc::new(Mutex::new(state)),
            persist_path,
        }
    }

    /// Get a clone of current health state
    pub async fn get_state(&self) -> ImHealthState {
        self.state.lock().await.clone()
    }

    /// Update status
    pub async fn set_status(&self, status: ImStatus) {
        self.state.lock().await.status = status;
    }

    /// Set bot username
    pub async fn set_bot_username(&self, username: Option<String>) {
        self.state.lock().await.bot_username = username;
    }

    /// Set error message
    pub async fn set_error(&self, message: Option<String>) {
        self.state.lock().await.error_message = message;
    }

    /// Increment restart count
    pub async fn increment_restart_count(&self) {
        self.state.lock().await.restart_count += 1;
    }

    /// Update uptime
    pub async fn set_uptime(&self, seconds: u64) {
        self.state.lock().await.uptime_seconds = seconds;
    }

    /// Update last message timestamp
    pub async fn set_last_message_at(&self, timestamp: String) {
        self.state.lock().await.last_message_at = Some(timestamp);
    }

    /// Update buffered messages count
    pub async fn set_buffered_messages(&self, count: usize) {
        self.state.lock().await.buffered_messages = count;
    }

    /// Update active sessions
    pub async fn set_active_sessions(&self, sessions: Vec<ImActiveSession>) {
        self.state.lock().await.active_sessions = sessions;
    }

    /// Add an active session
    pub async fn add_active_session(&self, session: ImActiveSession) {
        self.state.lock().await.active_sessions.push(session);
    }

    /// Remove an active session
    pub async fn remove_active_session(&self, session_key: &str) {
        self.state
            .lock()
            .await
            .active_sessions
            .retain(|s| s.session_key != session_key);
    }

    /// Reset state (on stop)
    pub async fn reset(&self) {
        let mut state = self.state.lock().await;
        *state = ImHealthState::default();
    }

    /// Persist current state to disk
    pub async fn persist(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        state.last_persisted = chrono::Utc::now().to_rfc3339();

        let json = serde_json::to_string_pretty(&*state)
            .map_err(|e| format!("Serialize error: {}", e))?;

        // Ensure parent directory exists
        if let Some(parent) = self.persist_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create health dir: {}", e))?;
        }

        std::fs::write(&self.persist_path, json)
            .map_err(|e| format!("Failed to write health state: {}", e))?;

        Ok(())
    }

    /// Start periodic persistence task (runs until shutdown)
    pub fn start_persist_loop(
        &self,
        mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        let state = Arc::clone(&self.state);
        let persist_path = self.persist_path.clone();

        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(PERSIST_INTERVAL_SECS));

            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let mut s = state.lock().await;
                        s.last_persisted = chrono::Utc::now().to_rfc3339();
                        let json = serde_json::to_string_pretty(&*s).unwrap_or_default();
                        drop(s);

                        if let Some(parent) = persist_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::write(&persist_path, &json) {
                            ulog_warn!("[im-health] Failed to persist: {}", e);
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            ulog_info!("[im-health] Persist loop shutting down");
                            break;
                        }
                    }
                }
            }
        })
    }
}

/// Get default health state file path (legacy single-bot)
pub fn default_health_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("im_state.json")
}

/// Get per-bot health state file path
pub fn bot_health_path(bot_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join(format!("im_{}_state.json", bot_id))
}

/// Get per-bot buffer file path
pub fn bot_buffer_path(bot_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join(format!("im_{}_buffer.json", bot_id))
}

/// Get per-bot dedup cache file path
pub fn bot_dedup_path(bot_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join(format!("im_{}_dedup.json", bot_id))
}

/// Migrate legacy health/buffer files to per-bot paths.
///
/// Strategy: copy then rename original to `.migrated`.
/// - Copy (not move) so rollback to older app version still finds data.
/// - Rename to `.migrated` prevents a second bot from re-copying the same
///   legacy state, which would be incorrect.
pub fn migrate_legacy_files(bot_id: &str) {
    migrate_single_file(
        &default_health_path(),
        &bot_health_path(bot_id),
        "health",
    );

    let legacy_buffer = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("im_buffer.json");
    migrate_single_file(
        &legacy_buffer,
        &bot_buffer_path(bot_id),
        "buffer",
    );
}

/// Copy a legacy file to the per-bot path, then rename original to `.migrated`.
fn migrate_single_file(legacy: &PathBuf, target: &PathBuf, label: &str) {
    if !legacy.exists() || target.exists() {
        return;
    }
    match std::fs::copy(legacy, target) {
        Ok(_) => {
            ulog_info!("[im-health] Migrated legacy {} file to {:?}", label, target);
            // Mark as migrated so no other bot copies the same file
            let migrated = legacy.with_extension("json.migrated");
            if let Err(e) = std::fs::rename(legacy, &migrated) {
                ulog_warn!("[im-health] Failed to rename legacy {} to .migrated: {}", label, e);
                // Non-fatal: worst case another bot copies the same state (harmless for health)
            }
        }
        Err(e) => {
            ulog_warn!("[im-health] Failed to migrate legacy {} file: {}", label, e);
        }
    }
}
