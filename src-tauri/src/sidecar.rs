// Sidecar process management module
// Handles spawning, monitoring, and shutting down multiple Bun backend server instances
// Supports per-Tab isolation with independent Sidecar processes

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::sync::Once;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::proxy_config;

// Ensure file descriptor limit is increased only once (unix only)
#[cfg(unix)]
static RLIMIT_INIT: Once = Once::new();

/// Increase file descriptor limit to prevent "low max file descriptors" error from Bun
/// This is especially important on macOS where the default soft limit is often 2560
#[cfg(unix)]
fn ensure_high_file_descriptor_limit() {
    RLIMIT_INIT.call_once(|| {
        use libc::{getrlimit, setrlimit, rlimit, RLIMIT_NOFILE};

        unsafe {
            let mut rlim = rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };

            // Get current limits
            if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                let old_soft = rlim.rlim_cur;
                let hard_limit = rlim.rlim_max;

                // Only increase if current soft limit is below a reasonable threshold
                // Target: at least 65536, or hard limit if lower
                let target = std::cmp::min(65536, hard_limit);

                if old_soft < target {
                    rlim.rlim_cur = target;

                    if setrlimit(RLIMIT_NOFILE, &rlim) == 0 {
                        log::info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        log::warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    log::info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                log::warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
const BASE_PORT: u16 = 31415;
// Health check: 60 attempts × 100ms = 6 seconds total (optimized for faster startup)
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 60;
const HEALTH_CHECK_DELAY_MS: u64 = 100;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
// HTTP health check for existing sidecar - shorter timeout since sidecar should respond immediately
const HTTP_HEALTH_CHECK_TIMEOUT_MS: u64 = 500;
const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 5;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Special identifier for global sidecar (used by Settings page)
pub const GLOBAL_SIDECAR_ID: &str = "__global__";
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
const SIDECAR_MARKER: &str = "--myagents-sidecar";

// ===== Proxy Configuration =====
// Default values (must match TypeScript PROXY_DEFAULTS in types.ts)
// Proxy configuration is now managed by the shared proxy_config module
// See src/proxy_config.rs for implementation details

/// Cleanup stale sidecar processes from previous app instances
/// This should be called on app startup before creating the SidecarManager
/// Cleans up:
/// 1. Bun sidecar processes (identified by SIDECAR_MARKER)
/// 2. SDK child processes (claude-agent-sdk/cli.js)
/// 3. MCP child processes (~/.myagents/mcp/)
///
/// Note: This runs BEFORE logging is initialized, so we use eprintln! for debugging
pub fn cleanup_stale_sidecars() {
    // Use eprintln! because this runs before tauri_plugin_log is initialized
    eprintln!("[sidecar] Cleaning up stale sidecar processes...");

    #[cfg(unix)]
    {
        // 1. Clean up bun sidecar processes (our main sidecar)
        let sidecar_count = kill_processes_by_pattern("sidecar", SIDECAR_MARKER, true);

        // 2. Clean up SDK child processes
        // These are spawned by SDK and don't have our marker
        // Pattern matches: bun .../claude-agent-sdk/cli.js
        let sdk_count = kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

        // 3. Clean up MCP child processes from our installation
        // Pattern matches: bun ~/.myagents/mcp/.../cli.js
        // This is specific to our MCP installation path, won't affect other apps
        let mcp_count = kill_processes_by_pattern("MCP", ".myagents/mcp/", true);

        eprintln!(
            "[sidecar] Startup cleanup complete: {} sidecar, {} SDK, {} MCP processes cleaned",
            sidecar_count, sdk_count, mcp_count
        );
    }

    #[cfg(windows)]
    {
        // Windows: Clean up all related processes
        // 1. Clean up bun sidecar processes (our main sidecar)
        kill_windows_processes_by_pattern(SIDECAR_MARKER);

        // 2. Clean up SDK child processes
        kill_windows_processes_by_pattern("claude-agent-sdk");

        // 3. Clean up MCP child processes
        kill_windows_processes_by_pattern(".myagents\\mcp\\");

        // Verify cleanup completed (max 1 second wait)
        let start = std::time::Instant::now();
        let max_wait = Duration::from_secs(1);
        loop {
            if !has_windows_processes(SIDECAR_MARKER)
                && !has_windows_processes("claude-agent-sdk")
                && !has_windows_processes(".myagents\\mcp\\")
            {
                log::info!("[sidecar] Windows cleanup verified in {:?}", start.elapsed());
                break;
            }
            if start.elapsed() > max_wait {
                log::warn!("[sidecar] Windows cleanup timeout after 1s, some processes may remain");
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Find PIDs by command line pattern, excluding current process
/// Note: Uses "--" separator before pattern to handle patterns starting with "-"
/// (e.g., "--myagents-sidecar" would otherwise be interpreted as a pgrep option)
#[cfg(unix)]
fn find_pids_by_pattern(pattern: &str) -> Vec<i32> {
    let current_pid = std::process::id() as i32;

    Command::new("pgrep")
        .args(["-f", "--", pattern])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<i32>().ok())
                // Exclude current process to avoid self-kill
                .filter(|&pid| pid != current_pid)
                .collect()
        })
        .unwrap_or_default()
}

/// Kill processes by pattern with optional SIGKILL fallback
/// - name: descriptive name for logging
/// - pattern: command line pattern to match
/// - force_kill: if true, use SIGKILL for processes that don't respond to SIGTERM
/// Returns: number of processes killed
///
/// Note: Uses eprintln! because this may run before tauri_plugin_log is initialized
#[cfg(unix)]
fn kill_processes_by_pattern(name: &str, pattern: &str, force_kill: bool) -> usize {
    let pids = find_pids_by_pattern(pattern);
    if pids.is_empty() {
        return 0;
    }

    eprintln!("[sidecar] Found {} {} processes, sending SIGTERM...", pids.len(), name);

    // First try SIGTERM for graceful shutdown
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }

    if !force_kill {
        return pids.len(); // Assume all killed (can't verify without waiting)
    }

    // Wait briefly for graceful shutdown
    thread::sleep(Duration::from_millis(300));

    // Check if any processes survived, use SIGKILL if needed
    let remaining = find_pids_by_pattern(pattern);
    if !remaining.is_empty() {
        eprintln!(
            "[sidecar] {} {} processes didn't respond to SIGTERM, using SIGKILL...",
            remaining.len(), name
        );
        for pid in &remaining {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }

    let final_remaining = find_pids_by_pattern(pattern);
    let killed_count = pids.len() - final_remaining.len();
    eprintln!("[sidecar] {} cleanup complete, killed {}/{} processes", name, killed_count, pids.len());
    killed_count
}



// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, not for Tabs or CronTasks.
// Multiple owners (Tabs, CronTasks) can share a Session's Sidecar.

/// Owner of a Sidecar - can be a Tab, CronTask, or BackgroundCompletion
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Cron Task ID that owns part of this Sidecar
    CronTask(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
}

/// Session-centric Sidecar instance
/// Each Session has at most one Sidecar, shared by multiple owners.
pub struct SessionSidecar {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Set of owners (Tabs and CronTasks) that are using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
}

impl SessionSidecar {
    /// Check if the sidecar process is still running
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }

        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.healthy = false;
                false
            }
            Ok(None) => true,
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar
    pub fn add_owner(&mut self, owner: SidecarOwner) {
        self.owners.insert(owner);
    }

    /// Remove an owner from this Sidecar
    /// Returns true if this was the last owner (Sidecar should be stopped)
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> bool {
        self.owners.remove(owner);
        self.owners.is_empty()
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        log::info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {}",
            self.session_id, self.port
        );
        let _ = kill_process(&mut self.process);
    }
}

/// Single Sidecar instance (legacy - kept for backward compatibility)
pub struct SidecarInstance {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
}

impl SidecarInstance {
    /// Check if the sidecar process is still running
    /// This actively checks the process rather than just relying on the healthy flag
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }
        
        // Try to check if process has exited
        match self.process.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                self.healthy = false;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }
}

/// Ensure Bun process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        log::info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = kill_process(&mut self.process);
        
        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                log::info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Session activation record
/// Tracks which Sidecar is currently "activating" a Session
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionActivation {
    /// Session ID being activated
    pub session_id: String,
    /// Tab ID that owns this activation (None for headless cron tasks)
    pub tab_id: Option<String>,
    /// Cron task ID if activated by cron task
    pub task_id: Option<String>,
    /// Port of the Sidecar handling this session
    pub port: u16,
    /// Workspace path
    pub workspace_path: String,
    /// Whether this is a cron task activation
    pub is_cron_task: bool,
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}

/// Multi-instance Sidecar Manager
/// Manages multiple Sidecar processes with Session singleton support
///
/// Architecture (v0.1.11 - Session-Centric):
/// - Sessions own Sidecars (1:1 relationship between Session and Sidecar)
/// - Multiple owners (Tabs, CronTasks) can share a Session's Sidecar
/// - Sidecar only stops when all owners release
///
/// Legacy support (v0.1.10):
/// - instances: per-Tab Sidecar instances (for backward compatibility)
/// - cron_task_instances: dedicated cron task Sidecars (for backward compatibility)
pub struct SidecarManager {
    // ===== New Session-Centric Storage (v0.1.11) =====
    /// Session ID -> SessionSidecar (primary storage for Session-centric model)
    sidecars: HashMap<String, SessionSidecar>,

    // ===== Legacy Storage (kept for backward compatibility) =====
    /// Tab ID -> Sidecar Instance (legacy, used for Global Sidecar)
    instances: HashMap<String, SidecarInstance>,
    /// Session ID -> Session Activation (tracks which session is active for Session singleton)
    session_activations: HashMap<String, SessionActivation>,
    /// Port counter for allocation (starts from BASE_PORT)
    port_counter: AtomicU16,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            sidecars: HashMap::new(),
            instances: HashMap::new(),
            session_activations: HashMap::new(),
            port_counter: AtomicU16::new(BASE_PORT),
        }
    }

    /// Get the next available port with max attempts to prevent infinite loop
    fn allocate_port(&self) -> Result<u16, String> {
        const MAX_ATTEMPTS: u32 = 200;
        
        for _ in 0..MAX_ATTEMPTS {
            let port = self.port_counter.fetch_add(1, Ordering::SeqCst);
            
            // Reset counter if we've gone past the range
            if port > BASE_PORT + PORT_RANGE {
                self.port_counter.store(BASE_PORT, Ordering::SeqCst);
            }
            
            if is_port_available(port) {
                return Ok(port);
            }
        }
        
        Err(format!("No available port found after {} attempts", MAX_ATTEMPTS))
    }

    /// Check if a Tab has a running instance
    #[allow(dead_code)]
    pub fn has_instance(&self, tab_id: &str) -> bool {
        self.instances.contains_key(tab_id)
    }

    /// Get instance status for a Tab
    pub fn get_instance(&self, tab_id: &str) -> Option<&SidecarInstance> {
        self.instances.get(tab_id)
    }

    /// Get mutable instance reference
    pub fn get_instance_mut(&mut self, tab_id: &str) -> Option<&mut SidecarInstance> {
        self.instances.get_mut(tab_id)
    }

    /// Insert a new instance
    pub fn insert_instance(&mut self, tab_id: String, instance: SidecarInstance) {
        self.instances.insert(tab_id, instance);
    }

    /// Remove and return an instance (will be dropped, killing the process)
    pub fn remove_instance(&mut self, tab_id: &str) -> Option<SidecarInstance> {
        self.instances.remove(tab_id)
    }

    /// Get all Tab IDs
    #[allow(dead_code)]
    pub fn tab_ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }

    /// Iterate over all instances (tab_id, instance)
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn iter_instances(&self) -> impl Iterator<Item = (&String, &SidecarInstance)> {
        self.instances.iter()
    }

    /// Stop all instances (session sidecars and global sidecar)
    pub fn stop_all(&mut self) {
        log::info!(
            "[sidecar] Stopping all instances (sessions: {}, global: {})",
            self.sidecars.len(),
            self.instances.len()
        );
        self.sidecars.clear(); // Session-centric Sidecars (Drop kills processes)
        self.instances.clear(); // Global Sidecar (Drop kills process)
        self.session_activations.clear();
    }

    // ============= Session Activation Methods =============

    /// Get session activation by session ID
    pub fn get_session_activation(&self, session_id: &str) -> Option<&SessionActivation> {
        self.session_activations.get(session_id)
    }

    /// Activate a session (associate it with a Sidecar)
    pub fn activate_session(
        &mut self,
        session_id: String,
        tab_id: Option<String>,
        task_id: Option<String>,
        port: u16,
        workspace_path: String,
        is_cron_task: bool,
    ) {
        log::info!(
            "[sidecar] Activating session {} on port {}, tab: {:?}, task: {:?}, cron: {}",
            session_id, port, tab_id, task_id, is_cron_task
        );
        self.session_activations.insert(
            session_id.clone(),
            SessionActivation {
                session_id,
                tab_id,
                task_id,
                port,
                workspace_path,
                is_cron_task,
            },
        );
    }

    /// Deactivate a session
    pub fn deactivate_session(&mut self, session_id: &str) -> Option<SessionActivation> {
        log::info!("[sidecar] Deactivating session {}", session_id);
        self.session_activations.remove(session_id)
    }

    /// Update session activation's tab_id (e.g., when a Tab connects to headless Sidecar)
    pub fn update_session_tab(&mut self, session_id: &str, tab_id: Option<String>) {
        if let Some(activation) = self.session_activations.get_mut(session_id) {
            log::info!(
                "[sidecar] Updating session {} tab: {:?} -> {:?}",
                session_id, activation.tab_id, tab_id
            );
            activation.tab_id = tab_id;
            // If a tab connects, it's no longer a pure cron task session
            if activation.tab_id.is_some() {
                activation.is_cron_task = false;
            }
        }
    }

    /// Get all active sessions for a workspace
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn get_workspace_sessions(&self, workspace_path: &str) -> Vec<&SessionActivation> {
        self.session_activations
            .values()
            .filter(|a| a.workspace_path == workspace_path)
            .collect()
    }

    // ============= Session-Centric Sidecar API (v0.1.11) =============

    /// Get the port for a Session's Sidecar
    pub fn get_session_port(&self, session_id: &str) -> Option<u16> {
        self.sidecars.get(session_id).map(|s| s.port)
    }

    /// Check if a Session has a healthy Sidecar
    /// Reserved for future use (e.g., debugging, health checks)
    #[allow(dead_code)]
    pub fn has_session_sidecar(&mut self, session_id: &str) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            sidecar.is_running()
        } else {
            false
        }
    }

    /// Get SessionSidecar reference by session ID
    /// Reserved for future use (e.g., debugging, introspection)
    #[allow(dead_code)]
    pub fn get_session_sidecar(&self, session_id: &str) -> Option<&SessionSidecar> {
        self.sidecars.get(session_id)
    }

    /// Get mutable SessionSidecar reference by session ID
    /// Reserved for future use (e.g., advanced owner management)
    #[allow(dead_code)]
    pub fn get_session_sidecar_mut(&mut self, session_id: &str) -> Option<&mut SessionSidecar> {
        self.sidecars.get_mut(session_id)
    }

    /// Insert a new SessionSidecar
    /// Reserved for future use (currently used internally via ensure_session_sidecar)
    #[allow(dead_code)]
    pub fn insert_session_sidecar(&mut self, session_id: String, sidecar: SessionSidecar) {
        log::info!(
            "[sidecar] Inserting SessionSidecar for session {} on port {}, owners: {:?}",
            session_id, sidecar.port, sidecar.owners
        );
        self.sidecars.insert(session_id, sidecar);
    }

    /// Remove and return a SessionSidecar (will be dropped, killing the process)
    /// Reserved for future use (e.g., explicit session cleanup)
    #[allow(dead_code)]
    pub fn remove_session_sidecar(&mut self, session_id: &str) -> Option<SessionSidecar> {
        log::info!("[sidecar] Removing SessionSidecar for session {}", session_id);
        self.sidecars.remove(session_id)
    }

    /// Add an owner to a Session's Sidecar
    /// Returns true if owner was added, false if session doesn't exist
    /// Reserved for future use (e.g., explicit owner management)
    #[allow(dead_code)]
    pub fn add_session_owner(&mut self, session_id: &str, owner: SidecarOwner) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            log::info!(
                "[sidecar] Adding owner {:?} to session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.add_owner(owner);
            true
        } else {
            false
        }
    }

    /// Remove an owner from a Session's Sidecar
    /// If this was the last owner, the Sidecar is removed (and killed via Drop)
    /// Returns (was_removed, sidecar_was_stopped)
    pub fn remove_session_owner(&mut self, session_id: &str, owner: &SidecarOwner) -> (bool, bool) {
        let should_stop = if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            log::info!(
                "[sidecar] Removing owner {:?} from session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.remove_owner(owner) // Returns true if this was the last owner
        } else {
            return (false, false);
        };

        if should_stop {
            log::info!(
                "[sidecar] Last owner removed from session {}, stopping Sidecar",
                session_id
            );
            self.sidecars.remove(session_id);
            (true, true)
        } else {
            (true, false)
        }
    }

    /// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
    /// This updates the key in both sidecars and session_activations HashMaps
    /// without stopping the Sidecar.
    ///
    /// Returns true if the upgrade was successful.
    pub fn upgrade_session_id(&mut self, old_session_id: &str, new_session_id: &str) -> bool {
        log::info!(
            "[sidecar] Upgrading session ID: {} -> {}",
            old_session_id, new_session_id
        );

        let mut upgraded = false;

        // 1. Upgrade in sidecars HashMap
        if let Some(mut sidecar) = self.sidecars.remove(old_session_id) {
            // Update the session_id field in the sidecar itself
            sidecar.session_id = new_session_id.to_string();
            self.sidecars.insert(new_session_id.to_string(), sidecar);
            log::info!(
                "[sidecar] Upgraded sidecars HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        // 2. Upgrade in session_activations HashMap
        if let Some(mut activation) = self.session_activations.remove(old_session_id) {
            // Update the session_id field in the activation itself
            activation.session_id = new_session_id.to_string();
            self.session_activations.insert(new_session_id.to_string(), activation);
            log::info!(
                "[sidecar] Upgraded session_activations HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        if !upgraded {
            log::debug!(
                "[sidecar] No entries found for session {} to upgrade",
                old_session_id
            );
        }

        upgraded
    }

}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure all processes are killed when manager is dropped
impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Thread-safe managed state wrapper
pub type ManagedSidecarManager = Arc<Mutex<SidecarManager>>;

/// Create a new managed sidecar manager
pub fn create_sidecar_manager() -> ManagedSidecarManager {
    Arc::new(Mutex::new(SidecarManager::new()))
}

// ============= Legacy compatibility types =============
// These are kept for backward compatibility during migration
// 
// TODO(PRD 0.1.0): Remove legacy API after confirming all frontend code
// uses the new multi-instance API (startTabSidecar, stopTabSidecar, etc.)
// 
// Legacy functions to remove:
// - start_sidecar, stop_sidecar, get_sidecar_status
// - restart_sidecar, ensure_sidecar_running, check_process_alive
// - cmd_start_sidecar, cmd_stop_sidecar, cmd_get_sidecar_status
// - cmd_get_server_url, cmd_restart_sidecar, cmd_ensure_sidecar_running
// - cmd_check_sidecar_alive

/// Legacy sidecar status (still used by existing commands)
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub agent_dir: String,
}

/// Legacy managed sidecar type alias
pub type ManagedSidecar = ManagedSidecarManager;

/// Legacy function: create_sidecar_state -> create_sidecar_manager
pub fn create_sidecar_state() -> ManagedSidecar {
    create_sidecar_manager()
}

/// Legacy SidecarConfig with required agent_dir
#[derive(Debug, Clone)]
pub struct LegacySidecarConfig {
    #[allow(dead_code)]
    pub port: u16,
    pub agent_dir: PathBuf,
    #[allow(dead_code)]
    pub initial_prompt: Option<String>,
}

// ============= Core Functions =============

/// Kill a child process gracefully (non-blocking)
///
/// This function sends SIGTERM to the process and spawns a background thread
/// to wait for graceful shutdown. If the process doesn't exit within the timeout,
/// the background thread will force kill it.
///
/// The function returns immediately after sending SIGTERM, making it suitable
/// for use in Drop implementations without blocking the UI.
fn kill_process(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();

    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = child.kill();
    }

    // Spawn a background thread to wait for graceful shutdown
    // This ensures we don't block the caller (important for UI responsiveness)
    // The thread will force kill if the process doesn't exit within timeout
    std::thread::spawn(move || {
        let timeout = Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
        let start = std::time::Instant::now();

        loop {
            // Check if process has exited
            #[cfg(unix)]
            {
                // Use waitpid with WNOHANG to check without blocking
                let mut status: i32 = 0;
                let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };

                if result > 0 {
                    // Process has exited
                    log::debug!("[sidecar] Process {} exited gracefully", pid);
                    return;
                } else if result < 0 {
                    // Error (process might already be gone)
                    log::debug!("[sidecar] Process {} already gone or error", pid);
                    return;
                }
                // result == 0 means process still running
            }
            #[cfg(windows)]
            {
                // On Windows, we can't easily check if process exited without the Child handle
                // Just wait for the timeout and then assume it's dead
            }

            if start.elapsed() > timeout {
                log::warn!("[sidecar] Process {} didn't exit after SIGTERM, force killing", pid);
                #[cfg(unix)]
                {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
                return;
            }

            thread::sleep(Duration::from_millis(50));
        }
    });

    Ok(())
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Find the bun executable path
fn find_bun_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // First, try to find bundled bun
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        #[cfg(target_os = "macos")]
        {
            if let Some(contents_dir) = resource_dir.parent() {
                // externalBin places binaries in MacOS/ with platform suffix
                #[cfg(target_arch = "aarch64")]
                let macos_bun = contents_dir.join("MacOS").join("bun-aarch64-apple-darwin");
                #[cfg(target_arch = "x86_64")]
                let macos_bun = contents_dir.join("MacOS").join("bun-x86_64-apple-darwin");

                if macos_bun.exists() {
                    log::info!("Using bundled bun from MacOS: {:?}", macos_bun);
                    return Some(macos_bun);
                }

                // Also check without suffix (for backward compatibility)
                let macos_bun_simple = contents_dir.join("MacOS").join("bun");
                if macos_bun_simple.exists() {
                    log::info!("Using bundled bun from MacOS (simple): {:?}", macos_bun_simple);
                    return Some(macos_bun_simple);
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Windows: bun.exe is in the same directory as the main executable
            // resource_dir = .../MyAgents/resources (where server-dist.js is)
            // Bun should be at .../MyAgents/bun-x86_64-pc-windows-msvc.exe
            if let Some(app_dir) = resource_dir.parent() {
                let win_bun = app_dir.join("bun-x86_64-pc-windows-msvc.exe");
                if win_bun.exists() {
                    log::info!("Using bundled bun from app dir: {:?}", win_bun);
                    return Some(win_bun);
                }

                // Also check without suffix
                let win_bun_simple = app_dir.join("bun.exe");
                if win_bun_simple.exists() {
                    log::info!("Using bundled bun from app dir (simple): {:?}", win_bun_simple);
                    return Some(win_bun_simple);
                }
            }
        }

        // Check in resource_dir/binaries/ for development mode
        #[cfg(target_os = "windows")]
        let bundled_bun = resource_dir.join("binaries").join("bun.exe");
        #[cfg(not(target_os = "windows"))]
        let bundled_bun = resource_dir.join("binaries").join("bun");

        if bundled_bun.exists() {
            log::info!("Using bundled bun: {:?}", bundled_bun);
            return Some(bundled_bun);
        }

        #[cfg(target_os = "macos")]
        {
            #[cfg(target_arch = "aarch64")]
            let platform_bun = resource_dir.join("binaries").join("bun-aarch64-apple-darwin");
            #[cfg(target_arch = "x86_64")]
            let platform_bun = resource_dir.join("binaries").join("bun-x86_64-apple-darwin");

            if platform_bun.exists() {
                log::info!("Using bundled platform bun: {:?}", platform_bun);
                return Some(platform_bun);
            }
        }

        #[cfg(target_os = "windows")]
        {
            let platform_bun = resource_dir.join("binaries").join("bun-x86_64-pc-windows-msvc.exe");
            if platform_bun.exists() {
                log::info!("Using bundled platform bun: {:?}", platform_bun);
                return Some(platform_bun);
            }
        }
    }

    // Fallback: system locations
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            format!(
                "{}\\.bun\\bin\\bun.exe",
                std::env::var("USERPROFILE").unwrap_or_default()
            ),
            format!(
                "{}\\bun\\bin\\bun.exe",
                std::env::var("LOCALAPPDATA").unwrap_or_default()
            ),
            format!(
                "{}\\bun\\bun.exe",
                std::env::var("PROGRAMFILES").unwrap_or_default()
            ),
        ];

        for candidate in candidates {
            let path = PathBuf::from(&candidate);
            if path.exists() {
                log::info!("Using system bun: {:?}", path);
                return Some(path);
            }
        }

        // Try to find bun.exe in PATH
        if let Ok(path) = which::which("bun.exe") {
            log::info!("Using bun from PATH: {:?}", path);
            return Some(path);
        }
        if let Ok(path) = which::which("bun") {
            log::info!("Using bun from PATH: {:?}", path);
            return Some(path);
        }

        return None;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            &format!(
                "{}/.bun/bin/bun",
                std::env::var("HOME").unwrap_or_default()
            ),
            "bun",
        ];

        for candidate in candidates {
            let path = PathBuf::from(candidate);
            if path.exists() || which::which(candidate).is_ok() {
                log::info!("Using system bun: {:?}", path);
                return Some(path);
            }
        }

        which::which("bun").ok()
    }
}

/// Find the server script path
fn find_server_script<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    log::info!("[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)");

    #[cfg(not(debug_assertions))]
    if let Ok(resource_dir) = _app_handle.path().resource_dir() {
        let bundled_script = resource_dir.join("server-dist.js");
        if bundled_script.exists() {
            log::info!("Using bundled server script (bundled): {:?}", bundled_script);
            return Some(bundled_script);
        }

        // 2. Legacy check: Check for server/index.ts (Development / Legacy)
        let legacy_script = resource_dir.join("server").join("index.ts");
        if legacy_script.exists() {
             log::info!("Using bundled server script (legacy): {:?}", legacy_script);
             return Some(legacy_script);
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                log::info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                log::info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    log::error!("Server script not found in any location");
    None
}

/// Wait for a new sidecar to become healthy using TCP-level check
/// For initial startup, TCP check is sufficient and more reliable because:
/// - Bun starts listening on TCP port before HTTP handler is fully ready
/// - TCP check has been proven stable in production
/// Note: For REUSING an existing sidecar, use check_sidecar_http_health() instead
fn wait_for_health(port: u16) -> Result<(), String> {
    let delay = Duration::from_millis(HEALTH_CHECK_DELAY_MS);

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                log::info!("[sidecar] TCP health check passed after {} attempts on port {}", attempt, port);
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay);
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed TCP health check after {} attempts on port {}",
        HEALTH_CHECK_MAX_ATTEMPTS, port
    ))
}

/// Quick HTTP health check for existing sidecar (non-blocking style with short timeout)
/// Returns true if the sidecar HTTP server is responsive
fn check_sidecar_http_health(port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", port);

    // Short timeout for quick check - sidecar should respond immediately if healthy
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(HTTP_HEALTH_CHECK_TIMEOUT_MS))
        .no_proxy()
        .build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&health_url).send() {
        Ok(response) => response.status().is_success(),
        Err(e) => {
            log::warn!("[sidecar] HTTP health check failed on port {}: {}", port, e);
            false
        }
    }
}

// ============= Tab-based Multi-instance Commands =============

/// Start a Sidecar for a specific Tab
/// Each Tab gets its own dedicated Sidecar (1:1 relationship)
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Check if already running for this tab
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            log::info!("[sidecar] Tab {} already has running instance on port {}", tab_id, instance.port);
            return Ok(instance.port);
        }
    }

    // Remove stale instance if exists
    manager_guard.remove_instance(tab_id);

    // Find executables
    let bun_path = find_bun_executable(app_handle)
        .ok_or_else(|| "Bun executable not found".to_string())?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    log::info!(
        "[sidecar] Starting for tab {} on port {}, agent_dir: {:?}",
        tab_id, port, agent_dir
    );

    // Build command - 直接用 bun <script> 而非 bun run <script>（更稳定）
    // Add SIDECAR_MARKER for reliable process identification and cleanup
    let mut cmd = Command::new(&bun_path);
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);

    // Determine if this is a global sidecar and handle agent directory
    let is_global = agent_dir.is_none();
    let effective_agent_dir = if let Some(ref dir) = agent_dir {
        cmd.arg("--agent-dir").arg(dir);
        Some(dir.clone())
    } else {
        // Global sidecar: use temp directory
        let temp_dir = std::env::temp_dir().join(format!("myagents-global-{}", std::process::id()));
        log::info!("[sidecar] Creating temp agent directory: {:?}", temp_dir);

        // Create directory and fail early if unable to create
        std::fs::create_dir_all(&temp_dir).map_err(|e| {
            let err = format!(
                "[sidecar] Failed to create temp directory {:?}: {}. \
                 Check permissions on TEMP directory ({}). \
                 This directory is required for Global Sidecar to store runtime data.",
                temp_dir, e, std::env::temp_dir().display()
            );
            log::error!("{}", err);
            err
        })?;

        cmd.arg("--agent-dir").arg(&temp_dir);
        Some(temp_dir)
    };

    // Set working directory to script's parent directory
    // This is crucial for bun to find relative imports
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
        log::info!("[sidecar] Working directory set to: {:?}", script_dir);
    }

    // Inject proxy environment variables if configured
    if let Some(proxy_settings) = proxy_config::read_proxy_settings() {
        match proxy_config::get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                log::info!("[sidecar] Injecting proxy for Claude Agent SDK: {}", proxy_url);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                // Ensure localhost traffic doesn't go through proxy
                // Comprehensive NO_PROXY list for maximum compatibility
                cmd.env("NO_PROXY", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
                cmd.env("no_proxy", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
            }
            Err(e) => {
                // Invalid proxy configuration (bad protocol, port, etc.)
                // Log as error since user explicitly enabled proxy but config is invalid
                log::error!(
                    "[sidecar] Invalid proxy configuration: {}. \
                     Please check Settings > General > Network Proxy. \
                     Sidecar will start without proxy.",
                    e
                );
            }
        }
    } else {
        log::debug!("[sidecar] No proxy configured, using direct connection");
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: Hide console window for GUI app
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 关键诊断日志：打印当前可执行文件路径，确认运行的是正确版本
    log::info!("[sidecar] current_exe = {:?}", std::env::current_exe().ok());

    log::info!(
        "[sidecar] Spawning: bun={:?}, script={:?}, port={}, is_global={}",
        bun_path, script_path, port, is_global
    );

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("[sidecar] Failed to spawn: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    log::info!("[sidecar] Process spawned with pid: {:?}", child.id());

    // 启动线程捕获 stdout
    if let Some(stdout) = child.stdout.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                log::info!("[bun-out][{}] {}", tab_id_clone, line);
            }
        });
    }

    // 启动线程捕获 stderr（关键：这里会打印 Bun 的错误信息）
    if let Some(stderr) = child.stderr.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::error!("[bun-err][{}] {}", tab_id_clone, line);
            }
        });
    }

    // Brief wait to let stdout/stderr threads capture initial output
    // Reduced from 500ms to 50ms for faster startup
    thread::sleep(Duration::from_millis(50));
    if let Ok(Some(status)) = child.try_wait() {
        // Process exited immediately, wait a bit for stderr thread to capture output
        thread::sleep(Duration::from_millis(100));
        log::error!("[sidecar] Process exited immediately with status: {:?}", status);
        return Err(format!("Bun process exited immediately with status: {:?}", status));
    }

    // Create instance (not yet healthy)
    let instance = SidecarInstance {
        process: child,
        port,
        agent_dir: effective_agent_dir,
        healthy: false,
        is_global,
    };

    manager_guard.insert_instance(tab_id.to_string(), instance);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Wait for health
    match wait_for_health(port) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                instance.healthy = true;
            }
            Ok(port)
        }
        Err(e) => {
            // Health check failed - try to get process output for debugging
            log::error!("[sidecar] Health check failed: {}", e);
            
            // Try to get the instance and check if process is still running
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                // Check if process has exited
                match instance.process.try_wait() {
                    Ok(Some(status)) => {
                        log::error!("[sidecar] Process exited with status: {:?}", status);
                    }
                    Ok(None) => {
                        log::error!("[sidecar] Process still running but not healthy");
                    }
                    Err(wait_err) => {
                        log::error!("[sidecar] Failed to check process status: {}", wait_err);
                    }
                }
                
                // Try to read stderr if available
                if let Some(ref mut stderr) = instance.process.stderr.take() {
                    use std::io::Read;
                    let mut output = String::new();
                    if stderr.read_to_string(&mut output).is_ok() && !output.is_empty() {
                        log::error!("[sidecar] Process stderr: {}", output);
                    }
                }
            }
            
            // Remove the failed instance
            manager_guard.remove_instance(tab_id);
            
            Err(e)
        }
    }
}

/// Stop a Sidecar for a specific Tab
/// Each Tab has its own Sidecar, so stopping is straightforward
pub fn stop_tab_sidecar(manager: &ManagedSidecarManager, tab_id: &str) -> Result<(), String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if let Some(instance) = manager_guard.remove_instance(tab_id) {
        log::info!("[sidecar] Stopped instance for tab {} on port {}", tab_id, instance.port);
        // Instance is dropped here, killing the process
    } else {
        log::debug!("[sidecar] No instance found for tab {}", tab_id);
    }

    Ok(())
}

/// Get the server URL for a specific Tab
/// This function checks multiple sources:
/// 1. Direct Tab sidecar instances (Global Sidecar)
/// 2. Session-centric sidecars via session_activations
/// 3. Legacy instances for backward compatibility
pub fn get_tab_server_url(manager: &ManagedSidecarManager, tab_id: &str) -> Result<String, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            return Ok(format!("http://127.0.0.1:{}", instance.port));
        }
    }

    // Priority 2: Check session_activations to find the Session-centric sidecar
    let activation_session = manager_guard.session_activations.values()
        .find(|a| a.tab_id.as_deref() == Some(tab_id))
        .map(|a| (a.session_id.clone(), a.port));

    if let Some((session_id, port)) = activation_session {
        // Verify the sidecar is still healthy in Session-centric storage
        let is_healthy = manager_guard.sidecars.get_mut(&session_id)
            .map(|s| s.is_running())
            .unwrap_or(false)
            || manager_guard.instances.values_mut()
                .any(|i| i.port == port && i.is_running());

        if is_healthy {
            log::info!(
                "[sidecar] Tab {} using session {} sidecar on port {} (via session_activation)",
                tab_id, session_id, port
            );
            return Ok(format!("http://127.0.0.1:{}", port));
        }
    }

    Err(format!("No running sidecar for tab {}", tab_id))
}

/// Get status for a Tab's sidecar
/// This function checks multiple sources (same as get_tab_server_url)
pub fn get_tab_sidecar_status(manager: &ManagedSidecarManager, tab_id: &str) -> Result<SidecarStatus, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        return Ok(SidecarStatus {
            running: instance.is_running(),
            port: instance.port,
            agent_dir: instance.agent_dir.as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }

    // Priority 2: Check session_activations for Session-centric sidecar
    let activation_info = manager_guard.session_activations.values()
        .find(|a| a.tab_id.as_deref() == Some(tab_id))
        .map(|a| (a.session_id.clone(), a.port, a.workspace_path.clone()));

    if let Some((session_id, port, workspace_path)) = activation_info {
        // Check if the sidecar is healthy in Session-centric storage
        let is_running = manager_guard.sidecars.get_mut(&session_id)
            .map(|s| s.is_running())
            .unwrap_or(false)
            || manager_guard.instances.values_mut()
                .any(|i| i.port == port && i.is_running());

        return Ok(SidecarStatus {
            running: is_running,
            port,
            agent_dir: workspace_path,
        });
    }

    // No sidecar found
    Ok(SidecarStatus {
        running: false,
        port: 0,
        agent_dir: String::new(),
    })
}

/// Start the global sidecar (for Settings page)
pub fn start_global_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<u16, String> {
    start_tab_sidecar(app_handle, manager, GLOBAL_SIDECAR_ID, None)
}

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
}

/// Ensure a Session has a Sidecar running, adding the specified owner.
/// If the Session already has a healthy Sidecar, just adds the owner.
/// If no Sidecar exists, creates a new one with the owner.
///
/// Returns (port, is_new) where is_new is true if a new Sidecar was started.
///
/// # WARNING: Blocking Function
/// This function uses `reqwest::blocking::Client` internally (via `check_sidecar_http_health`)
/// which uses `block_on()`. Calling this function from within an async context (tokio runtime)
/// will cause a deadlock or panic.
///
/// When calling from async code, wrap in `tokio::task::spawn_blocking`:
/// ```ignore
/// let result = tokio::task::spawn_blocking(move || {
///     ensure_session_sidecar(&app_handle, &manager, &session_id, workspace_path, owner)
/// })
/// .await
/// .map_err(|e| format!("spawn_blocking failed: {}", e))?;
/// ```
pub fn ensure_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    log::info!("[sidecar] ensure_session_sidecar called for session: {}, owner: {:?}", session_id, owner);

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    log::debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        log::error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    log::debug!("[sidecar] Manager lock acquired");

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    let existing_sidecar_info: Option<u16> = {
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_running() {
                Some(sidecar.port)
            } else {
                // Sidecar exists but process not running - remove it
                log::info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                manager_guard.sidecars.remove(session_id);
                None
            }
        } else {
            None
        }
    };

    // If we found a running sidecar, verify HTTP health (with lock released)
    if let Some(port) = existing_sidecar_info {
        // Drop the lock before doing HTTP check to avoid blocking other operations
        drop(manager_guard);

        // Verify HTTP server is actually responsive (not just process alive)
        let http_healthy = check_sidecar_http_health(port);

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

        if http_healthy {
            // HTTP health check passed - try to reuse the sidecar if it still exists
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                // Double-check port hasn't changed (another thread might have replaced it)
                if sidecar.port == port && sidecar.is_running() {
                    log::info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    sidecar.add_owner(owner);
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                    });
                }
            }
            // Sidecar was removed or replaced during HTTP check - fall through to create new one
            log::info!(
                "[sidecar] Session {} Sidecar changed during HTTP check, will create new",
                session_id
            );
        } else {
            // HTTP health check failed - sidecar is unresponsive, remove it if still present
            log::warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard.sidecars.remove(session_id);
        }

        // Fall through to create new sidecar with the re-acquired lock
        // We need to call the creation code below, so we store the guard
        // and use a labeled block to handle the return
        return create_new_session_sidecar(
            app_handle, manager, session_id, workspace_path, owner, manager_guard
        );
    }

    // No existing sidecar found, create a new one with the original guard
    create_new_session_sidecar(
        app_handle, manager, session_id, workspace_path, owner, manager_guard
    )
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
fn create_new_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'_, SidecarManager>,
) -> Result<EnsureSidecarResult, String> {

    // Need to start a new Sidecar
    // First, find executables
    let bun_path = find_bun_executable(app_handle)
        .ok_or_else(|| "Bun executable not found".to_string())?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    log::info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id, port, owner
    );

    // Build command
    let mut cmd = Command::new(&bun_path);
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER)
        .arg("--agent-dir")
        .arg(workspace_path);

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Inject proxy environment variables if configured
    if let Some(proxy_settings) = proxy_config::read_proxy_settings() {
        match proxy_config::get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                log::info!("[sidecar] Injecting proxy for Claude Agent SDK: {}", proxy_url);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("NO_PROXY", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
                cmd.env("no_proxy", "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]");
            }
            Err(e) => {
                log::error!("[sidecar] Invalid proxy configuration: {}", e);
            }
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    // Capture stdout/stderr for logging
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                log::info!("[bun-out][session:{}] {}", session_id_for_log, line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::error!("[bun-err][session:{}] {}", session_id_for_log, line);
            }
        });
    }

    // Brief wait to check if process exits immediately
    thread::sleep(Duration::from_millis(50));
    if let Ok(Some(status)) = child.try_wait() {
        thread::sleep(Duration::from_millis(100));
        log::error!("[sidecar] SessionSidecar exited immediately with status: {:?}", status);
        return Err(format!("Sidecar process exited immediately with status: {:?}", status));
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        healthy: false,
        owners,
        created_at: std::time::Instant::now(),
    };

    manager_guard.sidecars.insert(session_id.to_string(), sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Wait for health
    match wait_for_health(port) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                sidecar.healthy = true;
            }
            log::info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id, port
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
            })
        }
        Err(e) => {
            log::error!("[sidecar] SessionSidecar health check failed: {}", e);
            // Remove the failed sidecar
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            manager_guard.sidecars.remove(session_id);
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    let (removed, stopped) = manager_guard.remove_session_owner(session_id, owner);

    if removed {
        if stopped {
            log::info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner, session_id
            );
        } else {
            log::info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner, session_id
            );
        }
        Ok(stopped)
    } else {
        log::debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id, owner
        );
        Ok(false)
    }
}

/// Get the port for a Session's Sidecar
pub fn get_session_sidecar_port(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u16>, String> {
    let manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.get_session_port(session_id))
}

// ============= Session-Centric Tauri Commands =============

/// Ensure a Session has a Sidecar running, adding the specified owner
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
) -> Result<EnsureSidecarResult, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    let workspace_path = PathBuf::from(&workspacePath);
    ensure_session_sidecar(&app_handle, &state, &sessionId, &workspace_path, owner)
}

/// Release an owner from a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_release_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    ownerType: String,
    ownerId: String,
) -> Result<bool, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        "background_completion" => SidecarOwner::BackgroundCompletion(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    release_session_sidecar(&state, &sessionId, &owner)
}

/// Get the port for a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_port(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u16>, String> {
    get_session_sidecar_port(&state, &sessionId)
}

/// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
/// This updates HashMap keys without stopping the Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_upgrade_session_id(
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    newSessionId: String,
) -> Result<bool, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.upgrade_session_id(&oldSessionId, &newSessionId))
}

// ============= Background Session Completion =============
// Keeps a Sidecar alive in the background while AI finishes responding,
// even after the Tab releases its ownership.

/// Background completion polling interval (2 seconds)
const BG_POLL_INTERVAL_SECS: u64 = 2;
/// Background completion safety timeout (60 minutes)
const BG_MAX_DURATION_SECS: u64 = 3600;

/// Result from start_background_completion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCompletionResult {
    pub started: bool,
    pub session_id: String,
}

/// Check if a Sidecar's session is currently in "running" state
/// by calling GET /api/session-state
fn check_sidecar_session_state(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/session-state", port);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build() {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&url).send() {
        Ok(response) if response.status().is_success() => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SessionStateResponse {
                session_state: String,
            }
            match response.json::<SessionStateResponse>() {
                Ok(state) => Some(state.session_state),
                Err(_) => None,
            }
        }
        _ => None,
    }
}

/// Start background completion for a session.
/// Adds a BackgroundCompletion owner and spawns a polling thread.
/// Returns { started: true } if AI is actively running, { started: false } if idle.
pub fn start_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<BackgroundCompletionResult, String> {
    let result_id = session_id.to_string();

    // Phase 1: Check if sidecar exists and get port (with lock)
    let port = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_running() {
                Some(sidecar.port)
            } else {
                None
            }
        } else {
            None
        }
    };

    let port = match port {
        Some(p) => p,
        None => {
            log::debug!("[bg-completion] No running sidecar for session {}", session_id);
            return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
        }
    };

    // Phase 2: Check session state (without lock - HTTP call)
    let state = check_sidecar_session_state(port);
    let is_running = state.as_deref() == Some("running");

    if !is_running {
        log::info!("[bg-completion] Session {} is not running (state: {:?}), no background completion needed", session_id, state);
        return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
    }

    // Phase 3: Add BackgroundCompletion owner (with lock)
    {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
            if sidecar.owners.contains(&bg_owner) {
                log::info!("[bg-completion] Session {} already has a BackgroundCompletion owner", session_id);
                return Ok(BackgroundCompletionResult { started: true, session_id: result_id });
            }
            sidecar.add_owner(bg_owner);
            log::info!("[bg-completion] Added BackgroundCompletion owner to session {} (port {})", session_id, port);
        } else {
            log::warn!("[bg-completion] Sidecar disappeared during state check for session {}", session_id);
            return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
        }
    }

    // Phase 4: Spawn polling thread
    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();

    thread::spawn(move || {
        poll_background_completion(
            &app_handle_clone,
            &manager_clone,
            &session_id_clone,
            port,
        );
    });

    Ok(BackgroundCompletionResult { started: true, session_id: result_id })
}

/// Polling loop that runs in a background thread.
/// Checks session state every BG_POLL_INTERVAL_SECS until AI finishes,
/// then removes the BackgroundCompletion owner (which may stop the Sidecar).
fn poll_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    port: u16,
) {
    log::info!("[bg-completion] Starting polling for session {} on port {}", session_id, port);
    let start_time = std::time::Instant::now();
    let max_duration = Duration::from_secs(BG_MAX_DURATION_SECS);
    let poll_interval = Duration::from_secs(BG_POLL_INTERVAL_SECS);
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut consecutive_http_failures: u32 = 0;
    const MAX_HTTP_FAILURES: u32 = 3;

    loop {
        thread::sleep(poll_interval);

        // Safety timeout
        if start_time.elapsed() > max_duration {
            log::warn!("[bg-completion] Session {} hit safety timeout ({} min), stopping", session_id, BG_MAX_DURATION_SECS / 60);
            break;
        }

        // Check owner still exists + sidecar process still alive (single lock acquisition)
        {
            let mut manager_guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match manager_guard.sidecars.get_mut(session_id) {
                Some(sidecar) => {
                    // Owner removed externally (e.g., user reconnected via cancelBackgroundCompletion)
                    if !sidecar.owners.contains(&bg_owner) {
                        log::info!("[bg-completion] BackgroundCompletion owner removed for session {} (user reconnected?), exiting poll", session_id);
                        return; // Don't remove owner - it's already gone
                    }
                    // Process died
                    if !sidecar.is_running() {
                        log::warn!("[bg-completion] Sidecar process died for session {}", session_id);
                        break;
                    }
                }
                None => {
                    log::info!("[bg-completion] Sidecar removed for session {}, exiting poll", session_id);
                    return; // Sidecar already gone, nothing to clean up
                }
            }
        }

        // Check session state via HTTP (lock released, no contention)
        match check_sidecar_session_state(port) {
            Some(ref state) if state == "running" => {
                consecutive_http_failures = 0;
                log::debug!("[bg-completion] Session {} still running, continuing poll", session_id);
                continue;
            }
            Some(ref state) => {
                log::info!("[bg-completion] Session {} finished (state: {})", session_id, state);
                break;
            }
            None => {
                consecutive_http_failures += 1;
                if consecutive_http_failures >= MAX_HTTP_FAILURES {
                    log::warn!(
                        "[bg-completion] Session {} HTTP unreachable {} consecutive times, giving up",
                        session_id, consecutive_http_failures
                    );
                    break;
                }
                log::warn!(
                    "[bg-completion] Session {} HTTP unreachable ({}/{}), retrying...",
                    session_id, consecutive_http_failures, MAX_HTTP_FAILURES
                );
                continue;
            }
        }
    }

    // Remove BackgroundCompletion owner
    let sidecar_stopped = match release_session_sidecar(manager, session_id, &bg_owner) {
        Ok(stopped) => stopped,
        Err(e) => {
            log::error!("[bg-completion] Failed to release owner for session {}: {}", session_id, e);
            false
        }
    };

    log::info!(
        "[bg-completion] Session {} background completion finished, sidecar_stopped: {}",
        session_id, sidecar_stopped
    );

    // Emit Tauri event to notify frontend
    let _ = app_handle.emit("session:background-complete", serde_json::json!({
        "sessionId": session_id,
        "sidecarStopped": sidecar_stopped,
    }));
}

/// Cancel background completion for a session (e.g., when user reconnects).
/// Simply removes the BackgroundCompletion owner; the polling thread will detect this and exit.
pub fn cancel_background_completion(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
        if sidecar.owners.contains(&bg_owner) {
            sidecar.owners.remove(&bg_owner);
            log::info!("[bg-completion] Cancelled background completion for session {}", session_id);
            Ok(true)
        } else {
            log::debug!("[bg-completion] No BackgroundCompletion owner to cancel for session {}", session_id);
            Ok(false)
        }
    } else {
        log::debug!("[bg-completion] No sidecar found to cancel background completion for session {}", session_id);
        Ok(false)
    }
}

/// Start background completion for a session
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_start_background_completion(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<BackgroundCompletionResult, String> {
    start_background_completion(&app_handle, &state, &sessionId)
}

/// Cancel background completion for a session (when user reconnects)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_cancel_background_completion(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    cancel_background_completion(&state, &sessionId)
}

/// Stop all sidecar instances and clean up child processes
/// This should be called when the app is closing
pub fn stop_all_sidecars(manager: &ManagedSidecarManager) -> Result<(), String> {
    log::info!("[sidecar] Stopping all sidecars and cleaning up child processes...");

    // 1. Stop all managed sidecar instances (kills bun sidecars via Drop)
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    manager_guard.stop_all();
    drop(manager_guard);

    // 2. Clean up any orphaned child processes (SDK and MCP)
    // This is necessary because SDK spawns child processes that don't die
    // when the parent bun sidecar is killed
    cleanup_child_processes();

    Ok(())
}

/// Clean up SDK and MCP child processes
/// Called on app shutdown to ensure no orphaned processes remain
#[cfg(unix)]
fn cleanup_child_processes() {
    // Clean up SDK child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

    // Clean up MCP child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("MCP", ".myagents/mcp/", true);
}

#[cfg(windows)]
fn cleanup_child_processes() {
    // Windows: Clean up SDK and MCP child processes using wmic + taskkill
    log::info!("[sidecar] Cleaning up child processes on Windows...");

    // Clean up SDK child processes
    kill_windows_processes_by_pattern("claude-agent-sdk");

    // Clean up MCP child processes
    kill_windows_processes_by_pattern(".myagents\\mcp\\");
}

#[cfg(windows)]
fn kill_windows_processes_by_pattern(pattern: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Use PowerShell Get-CimInstance (wmic is deprecated in Windows 10/11)
    // Fallback to wmic for older systems
    let ps_command = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | Select-Object -ExpandProperty ProcessId",
        pattern.replace("'", "''")  // Escape single quotes for PowerShell
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_command])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let pids: Vec<u32> = match output {
        Ok(ref o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect()
        }
        _ => {
            // Fallback to wmic for older Windows versions
            log::info!("[sidecar] PowerShell failed, falling back to wmic");
            Command::new("wmic")
                .args(["process", "where", &format!("commandline like '%{}%'", pattern), "get", "processid"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .skip(1)
                        .filter_map(|s| s.trim().parse::<u32>().ok())
                        .collect()
                })
                .unwrap_or_default()
        }
    };

    if pids.is_empty() {
        return;
    }

    let mut killed = 0;
    for pid in &pids {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW);
        if cmd.output().is_ok() {
            killed += 1;
        }
    }

    if killed > 0 {
        log::info!("[sidecar] Killed {} processes matching '{}'", killed, pattern);
    }
}

/// Check if any Windows processes exist matching the pattern
#[cfg(windows)]
fn has_windows_processes(pattern: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let ps_command = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | Select-Object -ExpandProperty ProcessId",
        pattern.replace("'", "''")
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_command])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            !String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect::<Vec<_>>()
                .is_empty()
        }
        _ => false,
    }
}

#[cfg(not(any(unix, windows)))]
fn cleanup_child_processes() {
    // No-op on other platforms
}

// ============= Legacy Compatibility Functions =============
// These wrap the new multi-instance API to support existing code

/// Legacy: Start sidecar (uses "__legacy__" as tab ID)
pub fn start_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
    config: LegacySidecarConfig,
) -> Result<u16, String> {
    // Use legacy tab ID
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Stop any existing legacy instance
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    // Start new instance
    start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(config.agent_dir))
}

/// Legacy: Stop sidecar
pub fn stop_sidecar(state: &ManagedSidecar) -> Result<(), String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    stop_tab_sidecar(state, LEGACY_TAB_ID)
}

/// Legacy: Get sidecar status
pub fn get_sidecar_status(state: &ManagedSidecar) -> Result<SidecarStatus, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    get_tab_sidecar_status(state, LEGACY_TAB_ID)
}

/// Legacy: Check if process is alive
pub fn check_process_alive(state: &ManagedSidecar) -> Result<bool, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
        Ok(instance.is_running())
    } else {
        Ok(false)
    }
}

/// Legacy: Restart sidecar
pub fn restart_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Get current config
    let agent_dir = {
        let manager_guard = state.lock().map_err(|e| e.to_string())?;
        manager_guard.get_instance(LEGACY_TAB_ID)
            .and_then(|i| i.agent_dir.clone())
    };
    
    // Stop and restart
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    if let Some(dir) = agent_dir {
        start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(dir))
    } else {
        Err("No previous agent_dir to restart with".to_string())
    }
}

/// Legacy: Ensure sidecar is running
pub fn ensure_sidecar_running<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";

    // Check if already running
    {
        let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
            if instance.is_running() {
                return Ok(instance.port);
            }
        }
    }

    // Need to restart
    restart_sidecar(app_handle, state)
}

// ============= Session Activation Tauri Commands =============

/// Get session activation status
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_activation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Option<SessionActivation> {
    let manager = state.lock().ok()?;
    manager.get_session_activation(&sessionId).cloned()
}

/// Activate a session (associate with Sidecar)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_activate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
    taskId: Option<String>,
    port: u16,
    workspacePath: String,
    isCronTask: bool,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.activate_session(sessionId, tabId, taskId, port, workspacePath, isCronTask);
    Ok(())
}

/// Deactivate a session
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_deactivate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.deactivate_session(&sessionId);
    Ok(())
}

/// Update session's tab association
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_update_session_tab(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.update_session_tab(&sessionId, tabId);
    Ok(())
}

/// Cron task execution payload - sent to Sidecar's /cron/execute-sync endpoint
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    pub prompt: String,
    /// Session ID for activation tracking (prevents Sidecar from being killed during cron execution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_first_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<ProviderEnv>,
    /// Run mode: "single_session" (keep context) or "new_session" (fresh each time)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Task execution interval in minutes (for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Current execution number (1-based, for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecuteResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
}

/// Execute a cron task synchronously via Sidecar HTTP API
/// This function ensures a Sidecar is running for the session and calls its /cron/execute-sync endpoint
pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
) -> Result<CronExecuteResponse, String> {
    log::info!(
        "[sidecar] execute_cron_task called for task {} in workspace {}",
        payload.task_id, workspace_path
    );

    // Require session_id for Session-centric Sidecar
    let session_id = payload.session_id.clone().ok_or_else(|| {
        let err = format!("[sidecar] execute_cron_task requires session_id for task {}", payload.task_id);
        log::error!("{}", err);
        err
    })?;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: about to call ensure_session_sidecar"
    }));

    // Ensure Sidecar is running for this session with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let app_handle_clone = app_handle.clone();
    let manager_clone = manager.clone();
    let session_id_clone = session_id.clone();
    let workspace_clone = workspace_path.to_string();
    let task_id_clone = payload.task_id.clone();
    let owner = SidecarOwner::CronTask(task_id_clone.clone());

    let result = tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(&workspace_clone);
        ensure_session_sidecar(&app_handle_clone, &manager_clone, &session_id_clone, &workspace, owner)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
    .map_err(|e| {
        log::error!("[sidecar] ensure_session_sidecar failed for task {}: {}", payload.task_id, e);
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": format!("execute_cron_task: ensure_session_sidecar FAILED: {}", e),
            "error": true
        }));
        e
    })?;

    let port = result.port;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: sidecar ready on port {}, isNew={}", port, result.is_new)
    }));

    log::info!(
        "[sidecar] Cron sidecar ready for task {} on port {} (isNew={})",
        payload.task_id, port, result.is_new
    );

    // Also record in session_activations for Session singleton tracking
    {
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: recording session activation"
        }));

        let mut manager_guard = manager.lock().map_err(|e| {
            let _ = app_handle.emit("cron:debug", serde_json::json!({
                "taskId": payload.task_id,
                "message": format!("execute_cron_task: mutex lock FAILED: {}", e),
                "error": true
            }));
            e.to_string()
        })?;

        manager_guard.activate_session(
            session_id.clone(),
            None,  // No tab_id for cron tasks
            Some(payload.task_id.clone()),  // Store task_id for Tab connection
            port,
            workspace_path.to_string(),
            true,  // is_cron_task = true
        );

        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: session activation recorded"
        }));

        log::info!(
            "[sidecar] Cron task {} activated session {} as cron (port {})",
            payload.task_id, session_id, port
        );
    }

    let url = format!("http://127.0.0.1:{}/cron/execute-sync", port);

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: about to send HTTP request to {}", url)
    }));

    log::info!(
        "[sidecar] Executing cron task {} via {}",
        payload.task_id, url
    );

    // Create HTTP client with generous timeout (cron tasks can take long)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(660)) // 11 minutes (slightly more than Sidecar's 10 min timeout)
        .tcp_nodelay(true)
        .no_proxy() // Disable proxy for localhost
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: HTTP client created, sending request..."
    }));

    // Send request to Sidecar
    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await;

    // Deactivate session after execution (regardless of success/failure)
    // Note: We keep the session activated between cron executions to protect Sidecar.
    // Only deactivate if the task is being stopped or completed.
    // For now, we keep it activated - the cron scheduler should deactivate when task stops.

    let response = response.map_err(|e| format!("[sidecar] HTTP request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[sidecar] Failed to read response body: {}", e))?;

    log::info!(
        "[sidecar] Cron task {} response: status={}, body={}",
        payload.task_id, status, body.chars().take(500).collect::<String>()
    );

    // Parse response
    let result: CronExecuteResponse = serde_json::from_str(&body)
        .map_err(|e| format!("[sidecar] Failed to parse response JSON: {} (body: {})", e, body))?;

    log::info!(
        "[sidecar] Cron task {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        payload.task_id, result.success, result.error, result.ai_requested_exit
    );

    Ok(result)
}

/// Tauri command to execute a cron task synchronously
/// This is called by the cron scheduler in Rust
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_execute_cron_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    workspacePath: String,
    taskId: String,
    sessionId: Option<String>,
    prompt: String,
    isFirstExecution: Option<bool>,
    aiCanExit: Option<bool>,
    permissionMode: Option<String>,
    model: Option<String>,
    providerEnv: Option<ProviderEnv>,
    runMode: Option<String>,
    intervalMinutes: Option<u32>,
    executionNumber: Option<u32>,
) -> Result<CronExecuteResponse, String> {
    let payload = CronExecutePayload {
        task_id: taskId.clone(),
        prompt,
        session_id: sessionId,
        is_first_execution: isFirstExecution,
        ai_can_exit: aiCanExit,
        permission_mode: permissionMode,
        model,
        provider_env: providerEnv,
        run_mode: runMode,
        interval_minutes: intervalMinutes,
        execution_number: executionNumber,
    };

    execute_cron_task(&app_handle, &state, &workspacePath, payload).await
}

