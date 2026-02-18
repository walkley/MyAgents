// Session Router — maps IM peers to Sidecar instances
// Handles: peer→Sidecar mapping, crash recovery, idle session collection, and HTTP client factory.
//
// Concurrency model:
//   Global semaphore + per-peer locks live OUTSIDE the router (in the processing loop).
//   The router lock is only held briefly for data operations (ensure_sidecar, record_response).
//   SSE streaming to Sidecars happens WITHOUT the router lock, enabling true per-peer parallelism.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::json;
use tauri::{AppHandle, Runtime};

use crate::sidecar::{
    ensure_session_sidecar, release_session_sidecar, ManagedSidecarManager, SidecarOwner,
};

use super::types::{ImMessage, ImSourceType, PeerSession};

/// Max concurrent AI requests across all peers
pub const GLOBAL_CONCURRENCY: usize = 8;
/// Idle session timeout (30 minutes)
const IDLE_TIMEOUT_SECS: u64 = 1800;
/// Max Sidecar restart attempts (reserved for future reconnect logic)
#[allow(dead_code)]
const MAX_RESTART_ATTEMPTS: u32 = 5;
/// Initial restart backoff (seconds)
#[allow(dead_code)]
const INITIAL_RESTART_BACKOFF_SECS: u64 = 1;
/// Max restart backoff (seconds)
#[allow(dead_code)]
const MAX_RESTART_BACKOFF_SECS: u64 = 30;
/// HTTP timeout for Sidecar API calls
const SIDECAR_HTTP_TIMEOUT_SECS: u64 = 300;

/// Error from Sidecar routing — distinguishes bufferable vs non-bufferable failures.
#[derive(Debug)]
pub enum RouteError {
    /// Sidecar setup failed (ensure_sidecar error)
    Setup(String),
    /// HTTP request failed (connection error, timeout) — message should be buffered
    Unavailable(String),
    /// Sidecar returned non-success HTTP status
    Response(u16, String),
}

impl RouteError {
    pub fn should_buffer(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Setup(e) => write!(f, "{}", e),
            Self::Unavailable(e) => write!(f, "Sidecar unavailable: {}", e),
            Self::Response(status, body) => write!(f, "Sidecar returned {}: {}", status, body),
        }
    }
}

pub struct SessionRouter {
    peer_sessions: HashMap<String, PeerSession>,
    default_workspace: PathBuf,
    http_client: Client,
}

/// Create an HTTP client configured for local Sidecar communication.
pub fn create_sidecar_http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(SIDECAR_HTTP_TIMEOUT_SECS))
        .no_proxy() // All requests are to local Sidecars (127.0.0.1)
        .build()
        .expect("Failed to create HTTP client")
}

/// HTTP client for SSE streaming (read_timeout as idle timeout, not overall timeout).
/// No overall timeout — the stream stays open until the turn completes.
/// read_timeout acts as idle timeout: if no bytes arrive within 60s, the connection drops.
/// Heartbeat from Sidecar is 15s, so 60s provides comfortable margin.
pub fn create_sidecar_stream_client() -> Client {
    Client::builder()
        .read_timeout(Duration::from_secs(60))
        .tcp_nodelay(true)
        .http1_only() // Force HTTP/1.1 for SSE compatibility
        .no_proxy()
        .build()
        .expect("Failed to create SSE stream client")
}

impl SessionRouter {
    pub fn new(default_workspace: PathBuf) -> Self {
        Self {
            peer_sessions: HashMap::new(),
            default_workspace,
            http_client: create_sidecar_http_client(),
        }
    }

    /// Generate session key from IM message (delegates to ImMessage::session_key)
    pub fn session_key(msg: &ImMessage) -> String {
        msg.session_key()
    }

    /// Ensure a Sidecar is running for the given session key.
    /// Called while holding the router lock (brief: health check ~500ms + spawn ~2s worst case).
    pub async fn ensure_sidecar<R: Runtime>(
        &mut self,
        session_key: &str,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<u16, String> {
        // Check existing peer session
        if let Some(ps) = self.peer_sessions.get(session_key) {
            if ps.sidecar_port > 0 {
                // Verify Sidecar is still healthy via HTTP
                if self.check_sidecar_health(ps.sidecar_port).await {
                    return Ok(ps.sidecar_port);
                }
                log::warn!(
                    "[im-router] Sidecar on port {} unhealthy for {}",
                    ps.sidecar_port,
                    session_key
                );
            }
        }

        // Preserve message_count from existing session (P2 fix)
        let prev_count = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.message_count)
            .unwrap_or(0);

        // Need to create or restart Sidecar
        let workspace = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.workspace_path.clone())
            .unwrap_or_else(|| self.default_workspace.clone());

        // Reuse existing session_id (stable per peer) or generate new for first-time peers.
        // Bun receives --session-id and uses SDK resume to restore conversation history
        // after crash recovery, idle collection, or app restart.
        let session_id = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.session_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let owner = SidecarOwner::ImBot(session_key.to_string());

        // Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking
        let app_clone = app_handle.clone();
        let manager_clone = Arc::clone(manager);
        let sid = session_id.clone();
        let ws = workspace.clone();

        let result = tokio::task::spawn_blocking(move || {
            ensure_session_sidecar(&app_clone, &manager_clone, &sid, &ws, owner)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?
        .map_err(|e| format!("Failed to ensure Sidecar: {}", e))?;

        let port = result.port;
        log::info!(
            "[im-router] Sidecar ready for {} on port {} (workspace={})",
            session_key,
            port,
            workspace.display(),
        );

        // Parse source type and source_id from session_key
        let (source_type, source_id) = parse_session_key(session_key);

        // Update or create peer session (preserving message_count)
        self.peer_sessions.insert(
            session_key.to_string(),
            PeerSession {
                session_key: session_key.to_string(),
                session_id,
                sidecar_port: port,
                workspace_path: workspace,
                source_type,
                source_id,
                message_count: prev_count,
                last_active: Instant::now(),
            },
        );

        Ok(port)
    }

    /// Record a successful AI response — increment message_count and refresh activity.
    /// Note: session_id is NOT updated from the SSE response. The PeerSession.session_id
    /// is the Sidecar manager key (set at Sidecar creation time via --session-id).
    /// Overwriting it would cause a key mismatch on Sidecar restart.
    pub fn record_response(&mut self, session_key: &str, _session_id: Option<&str>) {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.message_count += 1;
            ps.last_active = Instant::now();
        }
    }

    /// Check if Sidecar is healthy via HTTP
    async fn check_sidecar_health(&self, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{}/health", port);
        match self
            .http_client
            .get(&url)
            .timeout(Duration::from_millis(500))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    /// Handle /new command — reset session for a peer.
    /// Upgrades the Sidecar Manager key so the running Sidecar can be found by the new session_id.
    pub async fn reset_session<R: Runtime>(
        &mut self,
        session_key: &str,
        _app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<String, String> {
        if let Some(ps) = self.peer_sessions.get(session_key) {
            let old_session_id = ps.session_id.clone();
            let url = format!("http://127.0.0.1:{}/api/im/session/new", ps.sidecar_port);
            let resp = self
                .http_client
                .post(&url)
                .json(&json!({}))
                .send()
                .await
                .map_err(|e| format!("Reset session error: {}", e))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                let new_session_id = body["sessionId"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();

                // Upgrade Sidecar Manager key: old_session_id → new_session_id
                // So ensure_sidecar can find the running Sidecar by the new key
                {
                    let mut mgr = manager.lock().unwrap();
                    mgr.upgrade_session_id(&old_session_id, &new_session_id);
                }

                // Update peer session
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.session_id = new_session_id.clone();
                    ps.message_count = 0;
                    ps.last_active = Instant::now();
                }

                return Ok(new_session_id);
            }
        }

        // No existing session — just return a new ID
        Ok(uuid::Uuid::new_v4().to_string())
    }

    /// Handle /workspace command — switch workspace for a peer
    pub async fn switch_workspace<R: Runtime>(
        &mut self,
        session_key: &str,
        workspace_path: &str,
        _app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<String, String> {
        // Release current Sidecar
        if let Some(ps) = self.peer_sessions.remove(session_key) {
            let owner = SidecarOwner::ImBot(session_key.to_string());
            let _ = release_session_sidecar(manager, &ps.session_id, &owner);
        }

        // The next message will auto-create a new Sidecar with the new workspace
        // For now, update the default workspace for this peer
        let new_workspace = PathBuf::from(workspace_path);

        // Parse source type and source_id from session_key
        let (source_type, source_id) = parse_session_key(session_key);

        let new_session_id = uuid::Uuid::new_v4().to_string();

        self.peer_sessions.insert(
            session_key.to_string(),
            PeerSession {
                session_key: session_key.to_string(),
                session_id: new_session_id.clone(),
                sidecar_port: 0, // Will be assigned on next message
                workspace_path: new_workspace,
                source_type,
                source_id,
                message_count: 0,
                last_active: Instant::now(),
            },
        );

        Ok(new_session_id)
    }

    /// Collect idle sessions that haven't been active for IDLE_TIMEOUT_SECS.
    /// Releases the Sidecar process but preserves the PeerSession (with port=0)
    /// so that the stable session_id can be reused for resume on next message.
    pub fn collect_idle_sessions(&mut self, manager: &ManagedSidecarManager) {
        let now = Instant::now();
        let idle_keys: Vec<String> = self
            .peer_sessions
            .iter()
            .filter(|(_, ps)| {
                ps.sidecar_port > 0
                    && now.duration_since(ps.last_active).as_secs() >= IDLE_TIMEOUT_SECS
            })
            .map(|(k, _)| k.clone())
            .collect();

        for key in idle_keys {
            if let Some(ps) = self.peer_sessions.get_mut(&key) {
                log::info!(
                    "[im-router] Collecting idle session {} (inactive for {}s, preserving session_id={})",
                    key,
                    now.duration_since(ps.last_active).as_secs(),
                    &ps.session_id,
                );
                let owner = SidecarOwner::ImBot(key.clone());
                let _ = release_session_sidecar(manager, &ps.session_id, &owner);
                ps.sidecar_port = 0; // Sidecar released, but session preserved for resume
            }
        }
    }

    /// Get active peer session info (for health state)
    pub fn active_sessions(&self) -> Vec<super::types::ImActiveSession> {
        self.peer_sessions
            .values()
            .map(|ps| super::types::ImActiveSession {
                session_key: ps.session_key.clone(),
                session_id: ps.session_id.clone(),
                source_type: ps.source_type.clone(),
                workspace_path: ps.workspace_path.display().to_string(),
                message_count: ps.message_count,
                last_active: chrono::Utc::now().to_rfc3339(), // Approximate
            })
            .collect()
    }

    /// Restore peer sessions from persisted health state (startup recovery).
    /// Sidecar ports are set to 0 — the first message will trigger re-creation.
    ///
    /// Session IDs are restored from persisted state so Bun can resume the conversation
    /// via --session-id → SDK resume. This preserves IM conversation history across app restarts.
    ///
    /// Workspace is always set to the current `default_workspace` (from settings),
    /// NOT the persisted value. This ensures workspace changes take effect on restart.
    pub fn restore_sessions(&mut self, sessions: &[super::types::ImActiveSession]) {
        for s in sessions {
            let (source_type, source_id) = parse_session_key(&s.session_key);
            self.peer_sessions.insert(
                s.session_key.clone(),
                PeerSession {
                    session_key: s.session_key.clone(),
                    session_id: s.session_id.clone(), // Restore original session_id for resume
                    sidecar_port: 0, // Sidecar not running yet; ensure_sidecar will start it
                    workspace_path: self.default_workspace.clone(),
                    source_type,
                    source_id,
                    message_count: s.message_count,
                    last_active: Instant::now(),
                },
            );
        }
        if !sessions.is_empty() {
            log::info!(
                "[im-router] Restored {} peer session(s) from previous run (workspace={})",
                sessions.len(),
                self.default_workspace.display(),
            );
        }
    }

    /// Release all sessions (shutdown)
    pub fn release_all(&mut self, manager: &ManagedSidecarManager) {
        let keys: Vec<String> = self.peer_sessions.keys().cloned().collect();
        for key in keys {
            if let Some(ps) = self.peer_sessions.remove(&key) {
                let owner = SidecarOwner::ImBot(key);
                let _ = release_session_sidecar(manager, &ps.session_id, &owner);
            }
        }
    }
}

/// Parse session key into (source_type, source_id)
pub fn parse_session_key(session_key: &str) -> (ImSourceType, String) {
    // Format: im:telegram:{private|group}:{id}
    let parts: Vec<&str> = session_key.split(':').collect();
    if parts.len() >= 4 {
        let source_type = match parts[2] {
            "group" => ImSourceType::Group,
            _ => ImSourceType::Private,
        };
        let source_id = parts[3..].join(":");
        (source_type, source_id)
    } else {
        (ImSourceType::Private, session_key.to_string())
    }
}
