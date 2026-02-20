// IM Bot integration module
// Manages the Telegram Bot lifecycle, routing IM messages to AI Sidecars.

pub mod adapter;
pub mod buffer;
pub mod feishu;
pub mod health;
pub mod heartbeat;
pub mod router;
pub mod telegram;
pub mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::Client;
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use crate::{ulog_info, ulog_warn, ulog_error, ulog_debug};
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinSet;

use tokio::sync::mpsc;

use crate::sidecar::ManagedSidecarManager;

/// Approval callback from IM platform (button click or text command)
pub struct ApprovalCallback {
    pub request_id: String,
    pub decision: String,  // "allow_once" | "always_allow" | "deny"
    #[allow(dead_code)]
    pub user_id: String,
}

/// Pending approval waiting for user response
struct PendingApproval {
    sidecar_port: u16,
    chat_id: String,
    card_message_id: String,
    created_at: Instant,
}

type PendingApprovals = Arc<Mutex<HashMap<String, PendingApproval>>>;

use buffer::MessageBuffer;
use feishu::FeishuAdapter;
use health::HealthManager;
use router::{
    create_sidecar_stream_client, RouteError, SessionRouter, GLOBAL_CONCURRENCY,
};
use telegram::TelegramAdapter;
use types::{ImAttachmentType, ImBotStatus, ImConfig, ImConversation, ImMessage, ImPlatform, ImSourceType, ImStatus};

/// Platform-agnostic adapter enum — avoids dyn dispatch overhead.
pub(crate) enum AnyAdapter {
    Telegram(Arc<TelegramAdapter>),
    Feishu(Arc<FeishuAdapter>),
}

impl adapter::ImAdapter for AnyAdapter {
    async fn verify_connection(&self) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => a.verify_connection().await,
            Self::Feishu(a) => a.verify_connection().await,
        }
    }
    async fn register_commands(&self) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.register_commands().await,
            Self::Feishu(a) => a.register_commands().await,
        }
    }
    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        match self {
            Self::Telegram(a) => a.listen_loop(shutdown_rx).await,
            Self::Feishu(a) => a.listen_loop(shutdown_rx).await,
        }
    }
    async fn send_message(&self, chat_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Feishu(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
        }
    }
    async fn ack_received(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn ack_processing(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn ack_clear(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn send_typing(&self, chat_id: &str) {
        match self {
            Self::Telegram(a) => a.send_typing(chat_id).await,
            Self::Feishu(a) => a.send_typing(chat_id).await,
        }
    }
}

impl adapter::ImStreamAdapter for AnyAdapter {
    async fn send_message_returning_id(&self, chat_id: &str, text: &str) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Feishu(a) => a.send_message_returning_id(chat_id, text).await,
        }
    }
    async fn edit_message(&self, chat_id: &str, message_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
            Self::Feishu(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
        }
    }
    async fn delete_message(&self, chat_id: &str, message_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
        }
    }
    fn max_message_length(&self) -> usize {
        match self {
            Self::Telegram(a) => a.max_message_length(),
            Self::Feishu(a) => a.max_message_length(),
        }
    }
    async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_approval_card(chat_id, request_id, tool_name, tool_input).await.map_err(|e| e.to_string()),
            Self::Feishu(a) => a.send_approval_card(chat_id, request_id, tool_name, tool_input).await,
        }
    }
    async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.update_approval_status(chat_id, message_id, status).await.map_err(|e| e.to_string()),
            Self::Feishu(a) => a.update_approval_status(message_id, status).await,
        }
    }
}

/// Managed state for the IM Bot subsystem (multi-bot: bot_id → instance)
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// Running IM Bot instance
pub struct ImBotInstance {
    #[allow(dead_code)]
    bot_id: String,
    #[allow(dead_code)]
    platform: ImPlatform,
    shutdown_tx: watch::Sender<bool>,
    health: Arc<HealthManager>,
    pub(crate) router: Arc<Mutex<SessionRouter>>,
    buffer: Arc<Mutex<MessageBuffer>>,
    started_at: Instant,
    /// JoinHandle for the message processing loop (awaited during graceful shutdown)
    process_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the platform listen loop (long-poll / WebSocket)
    poll_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the approval callback handler
    approval_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the health persist loop
    health_handle: tokio::task::JoinHandle<()>,
    /// Random bind code for QR code binding flow
    bind_code: String,
    #[allow(dead_code)]
    config: ImConfig,
    // ===== Heartbeat (v0.1.21) =====
    /// Heartbeat runner background task handle
    heartbeat_handle: Option<tokio::task::JoinHandle<()>>,
    /// Channel to send wake signals to heartbeat runner
    pub heartbeat_wake_tx: Option<mpsc::Sender<types::WakeReason>>,
    /// Shared heartbeat config (for hot updates)
    heartbeat_config: Option<Arc<tokio::sync::RwLock<types::HeartbeatConfig>>>,
    /// Platform adapter (retained for graceful shutdown — e.g. dedup flush)
    adapter: Arc<AnyAdapter>,
    // ===== Hot-reloadable config =====
    pub(crate) current_model: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) current_provider_env: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub(crate) permission_mode: Arc<tokio::sync::RwLock<String>>,
    pub(crate) mcp_servers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) available_providers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) allowed_users: Arc<tokio::sync::RwLock<Vec<String>>>,
}

/// Create the managed IM Bot state (called during app setup)
pub fn create_im_bot_state() -> ManagedImBots {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Signal all running IM bots to shut down (sync, for use in app exit handlers).
/// Best-effort: uses try_lock to avoid blocking if mutex is held.
pub fn signal_all_bots_shutdown(im_state: &ManagedImBots) {
    if let Ok(bots) = im_state.try_lock() {
        for (bot_id, instance) in bots.iter() {
            log::info!("[im] Signaling shutdown for bot {}", bot_id);
            let _ = instance.shutdown_tx.send(true);
            instance.poll_handle.abort();
            instance.process_handle.abort();
            instance.approval_handle.abort();
            instance.health_handle.abort();
            if let Some(ref h) = instance.heartbeat_handle {
                h.abort();
            }
        }
    } else {
        log::warn!("[im] Could not acquire lock for shutdown signal, IM bots may linger");
    }
}

/// Start the IM Bot
pub async fn start_im_bot<R: Runtime>(
    app_handle: &AppHandle<R>,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
) -> Result<ImBotStatus, String> {
    let mut im_guard = im_state.lock().await;

    // Gracefully stop existing instance for this bot_id if running
    if let Some(instance) = im_guard.remove(&bot_id) {
        ulog_info!("[im] Stopping existing IM Bot {} before restart", bot_id);
        let _ = instance.shutdown_tx.send(true);
        instance.poll_handle.abort(); // Cancel in-flight long-poll immediately
        // Wait briefly for in-flight messages (shorter timeout for restart)
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            instance.process_handle,
        )
        .await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.approval_handle).await;
        if let Some(hb) = instance.heartbeat_handle {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), hb).await;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.health_handle).await;
        instance
            .router
            .lock()
            .await
            .release_all(sidecar_manager);
        instance.health.reset().await;
    }

    ulog_info!(
        "[im] Starting IM Bot {} (configured workspace: {:?})",
        bot_id,
        config.default_workspace_path,
    );

    // Migrate legacy files to per-bot paths on first start
    health::migrate_legacy_files(&bot_id);

    // Determine default workspace (filter empty strings from frontend)
    // Fallback chain: configured path → bundled mino → home dir
    let default_workspace = config
        .default_workspace_path
        .as_ref()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Try bundled mino workspace first
            dirs::home_dir()
                .map(|h| h.join(".myagents").join("projects").join("mino"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| {
                    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
                })
        });

    ulog_info!("[im] Resolved workspace: {}", default_workspace.display());

    // Initialize components (per-bot paths)
    let health_path = health::bot_health_path(&bot_id);
    let health = Arc::new(HealthManager::new(health_path));
    health.set_status(ImStatus::Connecting).await;

    let buffer_path = health::bot_buffer_path(&bot_id);
    let buffer = Arc::new(Mutex::new(MessageBuffer::load_from_disk(&buffer_path)));

    let router = {
        let mut r = SessionRouter::new(default_workspace);
        // Restore peer→session mapping from previous run's im_state.json
        let prev_sessions = health.get_state().await.active_sessions;
        r.restore_sessions(&prev_sessions);
        Arc::new(Mutex::new(r))
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Shared mutable whitelist — updated when a user binds via QR code
    let allowed_users = Arc::new(tokio::sync::RwLock::new(config.allowed_users.clone()));

    // Shared mutable model — updated by /model command from Telegram
    let current_model = Arc::new(tokio::sync::RwLock::new(config.model.clone()));

    // Generate bind code for QR code binding flow
    let bind_code = format!("BIND_{}", &uuid::Uuid::new_v4().to_string()[..8]);

    // Create approval channel for permission request callbacks
    let (approval_tx, mut approval_rx) = mpsc::channel::<ApprovalCallback>(32);
    let pending_approvals: PendingApprovals = Arc::new(Mutex::new(HashMap::new()));

    // Create platform adapter (implements ImAdapter + ImStreamAdapter traits)
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel(256);
    let msg_tx_for_reinjection = msg_tx.clone(); // For media group merge re-injection
    let adapter: Arc<AnyAdapter> = match config.platform {
        ImPlatform::Telegram => Arc::new(AnyAdapter::Telegram(Arc::new(TelegramAdapter::new(
            &config,
            msg_tx,
            Arc::clone(&allowed_users),
            approval_tx.clone(),
        )))),
        ImPlatform::Feishu => {
            let dedup_path = Some(health::bot_dedup_path(&bot_id));
            Arc::new(AnyAdapter::Feishu(Arc::new(FeishuAdapter::new(
                &config,
                msg_tx,
                Arc::clone(&allowed_users),
                approval_tx.clone(),
                dedup_path,
            ))))
        }
    };

    // Verify bot connection via ImAdapter + ImStreamAdapter traits
    use adapter::ImAdapter;
    use adapter::ImStreamAdapter;
    match adapter.verify_connection().await {
        Ok(display_name) => {
            ulog_info!("[im] Bot verified: {}", display_name);
            // Store bot display name. Telegram returns "@username", Feishu returns plain name.
            let username = display_name.strip_prefix('@')
                .map(|s| s.to_string())
                .unwrap_or(display_name);
            health.set_bot_username(Some(username)).await;
            health.set_status(ImStatus::Online).await;
            health.set_error(None).await;
        }
        Err(e) => {
            let err_msg = format!("Bot connection verification failed: {}", e);
            ulog_error!("[im] {}", err_msg);
            health.set_status(ImStatus::Error).await;
            health.set_error(Some(err_msg.clone())).await;
            let _ = health.persist().await;
            return Err(err_msg);
        }
    }

    // Register platform commands via ImAdapter trait
    if let Err(e) = adapter.register_commands().await {
        ulog_warn!("[im] Failed to register bot commands: {}", e);
    }

    // Start health persist loop
    let health_handle = health.start_persist_loop(shutdown_rx.clone());

    // Start Telegram long-poll loop
    let adapter_clone = Arc::clone(&adapter);
    let poll_shutdown_rx = shutdown_rx.clone();
    let poll_handle = tokio::spawn(async move {
        adapter_clone.listen_loop(poll_shutdown_rx).await;
    });

    // Start approval callback handler
    let pending_approvals_for_handler = Arc::clone(&pending_approvals);
    let adapter_for_approval = Arc::clone(&adapter);
    let approval_client = Client::new();
    let mut approval_shutdown_rx = shutdown_rx.clone();
    let approval_handle = tokio::spawn(async move {
        loop {
            let cb = tokio::select! {
                msg = approval_rx.recv() => match msg {
                    Some(cb) => cb,
                    None => break, // Channel closed
                },
                _ = approval_shutdown_rx.changed() => {
                    if *approval_shutdown_rx.borrow() { break; }
                    continue;
                }
            };

            let pending = pending_approvals_for_handler.lock().await.remove(&cb.request_id);
            if let Some(p) = pending {
                // POST decision to Sidecar
                let url = format!("http://127.0.0.1:{}/api/im/permission-response", p.sidecar_port);
                let result = approval_client
                    .post(&url)
                    .json(&json!({
                        "requestId": cb.request_id,
                        "decision": cb.decision,
                    }))
                    .send()
                    .await;
                match result {
                    Ok(resp) if resp.status().is_success() => {
                        ulog_info!("[im] Approval forwarded: rid={}, decision={}", &cb.request_id[..cb.request_id.len().min(16)], cb.decision);
                    }
                    Ok(resp) => {
                        ulog_error!("[im] Approval forward failed: HTTP {}", resp.status());
                    }
                    Err(e) => {
                        ulog_error!("[im] Approval forward error: {}", e);
                    }
                }
                // Update card to show result (skip if card send had failed)
                if !p.card_message_id.is_empty() {
                    let status_text = if cb.decision == "deny" { "denied" } else { "approved" };
                    let _ = adapter_for_approval.update_approval_status(
                        &p.chat_id,
                        &p.card_message_id,
                        status_text,
                    ).await;
                }
            } else {
                ulog_warn!("[im] Approval callback for unknown request_id: {}", &cb.request_id[..cb.request_id.len().min(16)]);
            }
        }
        ulog_info!("[im] Approval handler exited");
    });

    // Start message processing loop
    //
    // Concurrency model:
    //   Commands are handled inline (fast, no I/O to Sidecar).
    //   Regular messages are spawned as per-message tasks via JoinSet.
    //
    //   Lock ordering (per task):
    //     1. Per-peer lock — serializes requests to the same Sidecar (required because
    //        /api/im/chat uses a single imStreamCallback; concurrent requests would conflict).
    //     2. Global semaphore — limits total concurrent Sidecar I/O across all peers.
    //        Acquired AFTER the peer lock so queued same-peer tasks don't hold permits
    //        while waiting, which would starve other peers.
    //     3. Router lock — held briefly for data ops (ensure_sidecar, record_response),
    //        never during the HTTP POST itself.
    let router_clone = Arc::clone(&router);
    let buffer_clone = Arc::clone(&buffer);
    let health_clone = Arc::clone(&health);
    let adapter_for_reply = Arc::clone(&adapter);
    let app_clone = app_handle.clone();
    let manager_clone = Arc::clone(sidecar_manager);
    let permission_mode = Arc::new(tokio::sync::RwLock::new(config.permission_mode.clone()));
    // Parse provider env from config (for per-message forwarding to Sidecar)
    // Wrapped in RwLock so /provider command can update it at runtime
    let provider_env: Option<serde_json::Value> = config
        .provider_env_json
        .as_ref()
        .and_then(|json_str| serde_json::from_str(json_str).ok());
    let current_provider_env = Arc::new(tokio::sync::RwLock::new(provider_env));
    // Available providers list (for /provider command menu) — hot-reloadable
    let available_providers_json = Arc::new(tokio::sync::RwLock::new(config.available_providers_json.clone()));
    // MCP servers JSON — hot-reloadable
    let mcp_servers_json = Arc::new(tokio::sync::RwLock::new(config.mcp_servers_json.clone()));
    let bind_code_for_loop = bind_code.clone();
    let bot_id_for_loop = bot_id.clone();
    let allowed_users_for_loop = Arc::clone(&allowed_users);
    let current_model_for_loop = Arc::clone(&current_model);
    let current_provider_env_for_loop = Arc::clone(&current_provider_env);
    let available_providers_for_loop = Arc::clone(&available_providers_json);
    let permission_mode_for_loop = Arc::clone(&permission_mode);
    let mcp_servers_json_for_loop = Arc::clone(&mcp_servers_json);
    let pending_approvals_for_loop = Arc::clone(&pending_approvals);
    let approval_tx_for_loop = approval_tx.clone();
    let mut process_shutdown_rx = shutdown_rx.clone();

    // Concurrency primitives (live outside the router for lock-free access)
    let global_semaphore = Arc::new(Semaphore::new(GLOBAL_CONCURRENCY));
    let peer_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stream_client = create_sidecar_stream_client();

    let process_handle = tokio::spawn(async move {
        let mut in_flight: JoinSet<()> = JoinSet::new();

        // Media group buffering (Telegram albums)
        struct MediaGroupEntry {
            messages: Vec<ImMessage>,
            first_received: Instant,
        }
        let mut media_groups: HashMap<String, MediaGroupEntry> = HashMap::new();
        const MEDIA_GROUP_TIMEOUT: Duration = Duration::from_millis(500);
        const MEDIA_GROUP_CHECK_INTERVAL: Duration = Duration::from_millis(100);

        /// Merge buffered media group messages into one combined message
        fn merge_media_group(mut messages: Vec<ImMessage>) -> ImMessage {
            messages.sort_by_key(|m| m.message_id.parse::<i64>().unwrap_or(0));
            let mut base = messages.remove(0);
            // Use first non-empty text as caption
            if base.text.is_empty() {
                if let Some(msg_with_text) = messages.iter().find(|m| !m.text.is_empty()) {
                    base.text = msg_with_text.text.clone();
                }
            }
            // Merge all attachments
            for msg in messages {
                base.attachments.extend(msg.attachments);
            }
            base.media_group_id = None; // Already merged
            base
        }

        /// Process attachments: save File types to workspace, encode Image types to base64.
        /// This is async to use non-blocking file I/O.
        async fn process_attachments(
            msg: &mut ImMessage,
            workspace_path: &std::path::Path,
        ) -> Vec<serde_json::Value> {
            /// Maximum image size for base64 encoding (10 MB)
            const MAX_IMAGE_ENCODE_SIZE: usize = 10 * 1024 * 1024;

            let mut file_refs: Vec<String> = Vec::new();
            let mut image_payloads: Vec<serde_json::Value> = Vec::new();

            for attachment in &msg.attachments {
                match attachment.attachment_type {
                    ImAttachmentType::File => {
                        let target_dir = workspace_path.join("myagents_files");
                        if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
                            ulog_error!("[im] Failed to create myagents_files dir: {}", e);
                            continue;
                        }
                        let target_path = target_dir.join(&attachment.file_name);
                        let final_path = auto_rename_path(&target_path);
                        if let Err(e) = tokio::fs::write(&final_path, &attachment.data).await {
                            ulog_error!("[im] Failed to save file: {}", e);
                            continue;
                        }
                        let relative = format!(
                            "myagents_files/{}",
                            final_path.file_name().unwrap().to_string_lossy()
                        );
                        file_refs.push(format!("@{}", relative));
                        ulog_info!(
                            "[im] Saved file attachment: {} ({} bytes)",
                            relative,
                            attachment.data.len()
                        );
                    }
                    ImAttachmentType::Image => {
                        if attachment.data.len() > MAX_IMAGE_ENCODE_SIZE {
                            ulog_warn!(
                                "[im] Image too large for base64 encoding: {} ({} bytes, max {})",
                                attachment.file_name,
                                attachment.data.len(),
                                MAX_IMAGE_ENCODE_SIZE
                            );
                            continue;
                        }
                        use base64::Engine;
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(&attachment.data);
                        image_payloads.push(json!({
                            "name": attachment.file_name,
                            "mimeType": attachment.mime_type,
                            "data": b64,
                        }));
                        ulog_info!(
                            "[im] Encoded image attachment: {} ({} bytes)",
                            attachment.file_name,
                            attachment.data.len()
                        );
                    }
                }
            }

            // Append @path references to message text
            if !file_refs.is_empty() {
                let refs_text = file_refs.join(" ");
                if msg.text.is_empty() {
                    msg.text = refs_text;
                } else {
                    msg.text = format!("{}\n{}", msg.text, refs_text);
                }
            }

            image_payloads
        }

        loop {
            // Determine flush timeout for media groups
            let flush_timeout = if media_groups.is_empty() {
                Duration::from_secs(3600)
            } else {
                MEDIA_GROUP_CHECK_INTERVAL
            };

            tokio::select! {
                Some(msg) = msg_rx.recv() => {
                    // Buffer media group messages
                    if let Some(ref group_id) = msg.media_group_id {
                        media_groups
                            .entry(group_id.clone())
                            .or_insert_with(|| MediaGroupEntry {
                                messages: Vec::new(),
                                first_received: Instant::now(),
                            })
                            .messages
                            .push(msg);
                        continue;
                    }
                    let session_key = SessionRouter::session_key(&msg);
                    let chat_id = msg.chat_id.clone();
                    let message_id = msg.message_id.clone();
                    let text = msg.text.trim().to_string();

                    // ── Bot command dispatch (inline — fast, no Sidecar I/O) ──

                    // QR code binding: /start BIND_xxxx
                    // Bind code handling: Telegram uses "/start BIND_xxx", Feishu uses plain "BIND_xxx"
                    let is_telegram_bind = text.starts_with("/start BIND_");
                    let is_feishu_bind = text.starts_with("BIND_") && msg.platform == ImPlatform::Feishu;
                    if is_telegram_bind || is_feishu_bind {
                        // If sender is already bound, silently ignore stale BIND_ messages
                        // (Feishu may re-deliver old messages after bot restart clears dedup cache)
                        let already_bound = {
                            let users = allowed_users_for_loop.read().await;
                            users.contains(&msg.sender_id)
                        };
                        if already_bound {
                            ulog_debug!("[im] Ignoring stale BIND message from already-bound user {}", msg.sender_id);
                            continue;
                        }

                        let code = if is_telegram_bind {
                            text.strip_prefix("/start ").unwrap_or("")
                        } else {
                            text.as_str()
                        };
                        if code == bind_code_for_loop {
                            // Valid bind — add user to whitelist
                            let user_id_str = msg.sender_id.clone();
                            let display = msg.sender_name.clone().unwrap_or_else(|| user_id_str.clone());

                            {
                                let mut users = allowed_users_for_loop.write().await;
                                if !users.contains(&user_id_str) {
                                    users.push(user_id_str.clone());
                                    ulog_info!("[im] User bound via QR: {} ({})", display, user_id_str);
                                }
                            }

                            // Persist to config.json directly (doesn't rely on frontend being mounted)
                            {
                                let bid = bot_id_for_loop.clone();
                                let uid = user_id_str.clone();
                                tokio::task::spawn_blocking(move || {
                                    persist_bound_user_to_config(&bid, &uid);
                                });
                            }

                            let reply = format!("✅ 绑定成功！你好 {}，现在可以直接和我聊天了。", display);
                            let _ = adapter_for_reply.send_message(&chat_id, &reply).await;

                            // Emit Tauri event so frontend can update UI (toast, refresh list)
                            let _ = app_clone.emit(
                                "im:user-bound",
                                serde_json::json!({
                                    "botId": bot_id_for_loop,
                                    "userId": user_id_str,
                                    "username": msg.sender_name,
                                }),
                            );
                        } else {
                            let _ = adapter_for_reply.send_message(
                                &chat_id,
                                "❌ 绑定码无效或已过期，请在 MyAgents 设置中重新获取二维码。",
                            ).await;
                        }
                        continue;
                    }

                    // Handle plain /start (first-time interaction, not a bind)
                    if text == "/start" {
                        let _ = adapter_for_reply.send_message(
                            &chat_id,
                            "👋 你好！我是 MyAgents Bot。\n\n\
                             可用命令：\n\
                             /new — 开始新对话\n\
                             /workspace <路径> — 切换工作区\n\
                             /model — 查看或切换 AI 模型\n\
                             /provider — 查看或切换 AI 供应商\n\
                             /status — 查看状态\n\n\
                             直接发消息即可开始对话。",
                        ).await;
                        continue;
                    }

                    if text == "/new" {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let result = router_clone
                            .lock()
                            .await
                            .reset_session(&session_key, &app_clone, &manager_clone)
                            .await;
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        match result {
                            Ok(new_id) => {
                                let reply = format!("✅ 已创建新对话 ({})", &new_id[..8.min(new_id.len())]);
                                let _ = adapter_for_reply.send_message(&chat_id, &reply).await;
                            }
                            Err(e) => {
                                let _ = adapter_for_reply.send_message(&chat_id, &format!("❌ 创建失败: {}", e)).await;
                            }
                        }
                        continue;
                    }

                    if text.starts_with("/workspace") {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let path_arg = text.strip_prefix("/workspace").unwrap_or("").trim();
                        let reply = if path_arg.is_empty() {
                            // Show current workspace
                            let router = router_clone.lock().await;
                            let sessions = router.active_sessions();
                            let current = sessions.iter().find(|s| s.session_key == session_key);
                            match current {
                                Some(s) => format!("📁 当前工作区: {}", s.workspace_path),
                                None => "📁 尚未绑定工作区（发送消息后自动绑定默认工作区）".to_string(),
                            }
                        } else {
                            // Switch workspace
                            match router_clone
                                .lock()
                                .await
                                .switch_workspace(&session_key, path_arg, &app_clone, &manager_clone)
                                .await
                            {
                                Ok(_) => format!("✅ 已切换工作区: {}", path_arg),
                                Err(e) => format!("❌ 切换失败: {}", e),
                            }
                        };
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        let _ = adapter_for_reply.send_message(&chat_id, &reply).await;
                        continue;
                    }

                    if text == "/status" {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let router = router_clone.lock().await;
                        let sessions = router.active_sessions();
                        let current = sessions.iter().find(|s| s.session_key == session_key);
                        let reply = match current {
                            Some(s) => format!(
                                "📊 Session 状态\n\n工作区: {}\n消息数: {}\n会话: {}",
                                s.workspace_path, s.message_count, &session_key
                            ),
                            None => format!(
                                "📊 Session 状态\n\n当前无活跃 Session\n会话键: {}",
                                session_key
                            ),
                        };
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        let _ = adapter_for_reply.send_message(&chat_id, &reply).await;
                        continue;
                    }

                    // /model — show or switch AI model
                    if text.starts_with("/model") {
                        let arg = text.strip_prefix("/model").unwrap_or("").trim().to_string();
                        if arg.is_empty() {
                            let current = current_model_for_loop.read().await;
                            let display = current.as_deref().unwrap_or("claude-sonnet-4-6 (默认)");
                            let help = format!(
                                "📊 当前模型: {}\n\n可用快捷名:\n\
                                 • sonnet → claude-sonnet-4-6\n\
                                 • opus → claude-opus-4-6\n\
                                 • haiku → claude-haiku-4-5\n\n\
                                 用法: /model <名称>",
                                display,
                            );
                            let _ = adapter_for_reply.send_message(&chat_id, &help).await;
                        } else {
                            let model_id = match arg.to_lowercase().as_str() {
                                "sonnet" => "claude-sonnet-4-6".to_string(),
                                "opus" => "claude-opus-4-6".to_string(),
                                "haiku" => "claude-haiku-4-5".to_string(),
                                other => other.to_string(),
                            };
                            // Update shared model state
                            {
                                let mut model_guard = current_model_for_loop.write().await;
                                *model_guard = Some(model_id.clone());
                            }
                            // If peer has an active Sidecar, sync model via API
                            let router = router_clone.lock().await;
                            let sessions = router.active_sessions();
                            if let Some(s) = sessions.iter().find(|s| s.session_key == session_key) {
                                // Parse port from peer sessions (need to check via ensure_sidecar route)
                                // Active sessions don't expose port directly, so use the http client
                                // We'll sync on next message via ensure_sidecar + sync_ai_config pattern
                                drop(router);
                                // Attempt to sync if we can find the port
                                // For now, the model will be picked up when session restarts
                                ulog_info!("[im] /model: set to {} (session={})", model_id, s.session_key);
                            }
                            let _ = adapter_for_reply.send_message(
                                &chat_id,
                                &format!("✅ 模型已切换为: {}", model_id),
                            ).await;
                        }
                        continue;
                    }

                    // /provider — show or switch AI provider
                    if text.starts_with("/provider") {
                        let arg = text.strip_prefix("/provider").unwrap_or("").trim().to_string();

                        // Parse available providers from config (hot-reloadable)
                        let providers: Vec<serde_json::Value> = {
                            let ap = available_providers_for_loop.read().await;
                            ap.as_ref()
                                .and_then(|json| serde_json::from_str(json).ok())
                                .unwrap_or_default()
                        };

                        if arg.is_empty() {
                            // Show current provider + available list
                            let current_env = current_provider_env_for_loop.read().await;
                            let current_name = if current_env.is_none() {
                                "Anthropic (订阅) [默认]".to_string()
                            } else {
                                // Find name by matching baseUrl
                                let base_url = current_env.as_ref()
                                    .and_then(|v| v["baseUrl"].as_str());
                                providers.iter()
                                    .find(|p| p["baseUrl"].as_str() == base_url)
                                    .and_then(|p| p["name"].as_str())
                                    .unwrap_or("自定义")
                                    .to_string()
                            };

                            let mut menu = format!("📡 当前供应商: {}\n\n可用供应商:\n", current_name);
                            for (i, p) in providers.iter().enumerate() {
                                let name = p["name"].as_str().unwrap_or("?");
                                let id = p["id"].as_str().unwrap_or("?");
                                menu.push_str(&format!("{}. {} ({})\n", i + 1, name, id));
                            }
                            menu.push_str("\n用法: /provider <序号或ID>");

                            let _ = adapter_for_reply.send_message(&chat_id, &menu).await;
                        } else {
                            // Switch provider by index (1-based) or ID
                            let target = if let Ok(idx) = arg.parse::<usize>() {
                                providers.get(idx.saturating_sub(1)).cloned()
                            } else {
                                providers.iter()
                                    .find(|p| p["id"].as_str().map(|s| s == arg).unwrap_or(false))
                                    .cloned()
                            };

                            match target {
                                Some(provider) => {
                                    let name = provider["name"].as_str().unwrap_or("?");
                                    let primary_model = provider["primaryModel"].as_str().unwrap_or("");
                                    let provider_id = provider["id"].as_str().unwrap_or("");

                                    // Subscription provider → clear provider env
                                    if provider_id.contains("sub") {
                                        *current_provider_env_for_loop.write().await = None;
                                    } else {
                                        // Build new provider env from stored info
                                        let new_env = serde_json::json!({
                                            "baseUrl": provider["baseUrl"],
                                            "apiKey": provider["apiKey"],
                                            "authType": provider["authType"],
                                        });
                                        *current_provider_env_for_loop.write().await = Some(new_env);
                                    }

                                    // Also switch model to the provider's primary model
                                    if !primary_model.is_empty() {
                                        *current_model_for_loop.write().await = Some(primary_model.to_string());
                                    }

                                    let _ = adapter_for_reply.send_message(
                                        &chat_id,
                                        &format!("✅ 已切换供应商: {}\n模型: {}", name, primary_model),
                                    ).await;
                                }
                                None => {
                                    let _ = adapter_for_reply.send_message(
                                        &chat_id,
                                        "❌ 未找到该供应商，请使用 /provider 查看可用列表",
                                    ).await;
                                }
                            }
                        }
                        continue;
                    }

                    // ── Text-based approval commands (fallback for platforms without card callbacks) ──
                    let approval_decision = match text.as_str() {
                        "允许" | "同意" | "approve" => Some("allow_once"),
                        "始终允许" | "始终同意" | "always approve" => Some("always_allow"),
                        "拒绝" | "deny" => Some("deny"),
                        _ => None,
                    };
                    if let Some(decision) = approval_decision {
                        // Find the most recent pending approval for this chat
                        let pending_rid = {
                            let guard = pending_approvals_for_loop.lock().await;
                            guard.iter()
                                .find(|(_, p)| p.chat_id == chat_id)
                                .map(|(rid, _)| rid.clone())
                        };
                        if let Some(request_id) = pending_rid {
                            ulog_info!("[im] Text approval command: decision={}, rid={}", decision, &request_id[..request_id.len().min(16)]);
                            let _ = approval_tx_for_loop.send(ApprovalCallback {
                                request_id,
                                decision: decision.to_string(),
                                user_id: msg.sender_id.clone(),
                            }).await;
                            continue;
                        }
                        // No pending approval — fall through to regular message handling
                    }

                    // ── Regular message → spawn concurrent task ──────────
                    ulog_info!(
                        "[im] Routing message from {} to Sidecar (session_key={}, {} chars)",
                        msg.sender_name.as_deref().unwrap_or("?"),
                        session_key,
                        text.len(),
                    );

                    // Clone shared state for the spawned task
                    let task_router = Arc::clone(&router_clone);
                    let task_adapter = Arc::clone(&adapter_for_reply);
                    let task_app = app_clone.clone();
                    let task_manager = Arc::clone(&manager_clone);
                    let task_buffer = Arc::clone(&buffer_clone);
                    let task_health = Arc::clone(&health_clone);
                    let task_perm = permission_mode_for_loop.read().await.clone();
                    let task_provider_env = Arc::clone(&current_provider_env_for_loop);
                    let task_model = Arc::clone(&current_model_for_loop);
                    let task_mcp_json = mcp_servers_json_for_loop.read().await.clone();
                    let task_stream_client = stream_client.clone();
                    let task_sem = Arc::clone(&global_semaphore);
                    let task_locks = Arc::clone(&peer_locks);
                    let task_pending_approvals = Arc::clone(&pending_approvals_for_loop);
                    let task_bot_id = bot_id_for_loop.clone();

                    in_flight.spawn(async move {
                        // 1. Acquire per-peer lock FIRST (serialize requests to same Sidecar).
                        let peer_lock = {
                            let mut locks = task_locks.lock().await;
                            locks
                                .entry(session_key.clone())
                                .or_insert_with(|| Arc::new(Mutex::new(())))
                                .clone()
                        };
                        let _peer_guard = peer_lock.lock().await;

                        // 2. Acquire global semaphore (rate limit across all peers)
                        let _permit = match task_sem.clone().acquire_owned().await {
                            Ok(p) => p,
                            Err(_) => {
                                ulog_error!("[im] Semaphore closed");
                                return;
                            }
                        };

                        // 3. ACK + typing indicator
                        task_adapter.ack_processing(&chat_id, &message_id).await;
                        task_adapter.send_typing(&chat_id).await;

                        // 4. Ensure Sidecar is running (brief router lock)
                        let (port, is_new_sidecar) = match task_router
                            .lock()
                            .await
                            .ensure_sidecar(&session_key, &task_app, &task_manager)
                            .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                let _ = task_adapter
                                    .send_message(&chat_id, &format!("⚠️ {}", e))
                                    .await;
                                return;
                            }
                        };

                        // 4b. Sync AI config to newly created Sidecar
                        if is_new_sidecar {
                            let model = task_model.read().await.clone();
                            task_router
                                .lock()
                                .await
                                .sync_ai_config(
                                    port,
                                    model.as_deref(),
                                    task_mcp_json.as_deref(),
                                )
                                .await;
                        }

                        // 4c. Process attachments (File → save to workspace, Image → base64)
                        let mut msg = msg; // make mutable for attachment processing
                        let workspace_path = {
                            let router = task_router.lock().await;
                            router
                                .peer_session_workspace(&session_key)
                                .unwrap_or_else(|| router.default_workspace().clone())
                        };
                        let image_payloads = if !msg.attachments.is_empty() {
                            process_attachments(&mut msg, &workspace_path).await
                        } else {
                            Vec::new()
                        };

                        // 5. SSE stream: route message + stream response to Telegram
                        let penv = task_provider_env.read().await.clone();
                        let images = if image_payloads.is_empty() {
                            None
                        } else {
                            Some(&image_payloads)
                        };
                        let session_id = match stream_to_im(
                            &task_stream_client,
                            port,
                            &msg,
                            task_adapter.as_ref(),
                            &chat_id,
                            &task_perm,
                            penv.as_ref(),
                            images,
                            &task_pending_approvals,
                            Some(&task_bot_id),
                        )
                        .await
                        {
                            Ok(sid) => {
                                ulog_info!(
                                    "[im] Stream complete for {} (session={})",
                                    session_key,
                                    sid.as_deref().unwrap_or("?"),
                                );
                                sid
                            }
                            Err(e) => {
                                ulog_error!("[im] Stream error for {}: {}", session_key, e);
                                if e.should_buffer() {
                                    task_buffer.lock().await.push(&msg);
                                }
                                // SSE "error" events are handled inside stream_to_telegram,
                                // but early failures (connection refused, non-200 status) need
                                // explicit notification here.
                                let _ = task_adapter
                                    .send_message(&chat_id, &format!("⚠️ 处理消息时出错: {}", e))
                                    .await;
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                return;
                            }
                        };

                        // 6. Clear ACK reaction
                        task_adapter.ack_clear(&chat_id, &message_id).await;

                        // 7. Update session state
                        task_router
                            .lock()
                            .await
                            .record_response(&session_key, session_id.as_deref());

                        // Update health
                        task_health
                            .set_last_message_at(chrono::Utc::now().to_rfc3339())
                            .await;
                        task_health
                            .set_active_sessions(
                                task_router.lock().await.active_sessions(),
                            )
                            .await;

                        // 8. Buffer replay (same session only — per-peer lock is held)
                        let mut replayed = 0u32;
                        loop {
                            let maybe = task_buffer.lock().await.pop_for_session(&session_key);
                            match maybe {
                                Some(buffered) => {
                                    let buf_chat_id = buffered.chat_id.clone();
                                    let buf_msg = buffered.to_im_message();
                                    match stream_to_im(
                                        &task_stream_client,
                                        port,
                                        &buf_msg,
                                        task_adapter.as_ref(),
                                        &buf_chat_id,
                                        &task_perm,
                                        penv.as_ref(),
                                        None, // buffered messages don't preserve attachments
                                        &task_pending_approvals,
                                        Some(&task_bot_id),
                                    )
                                    .await
                                    {
                                        Ok(buf_sid) => {
                                            task_router
                                                .lock()
                                                .await
                                                .record_response(
                                                    &session_key,
                                                    buf_sid.as_deref(),
                                                );
                                            replayed += 1;
                                        }
                                        Err(e) => {
                                            if e.should_buffer() {
                                                task_buffer.lock().await.push(&buf_msg);
                                            }
                                            break;
                                        }
                                    }
                                }
                                None => break,
                            }
                        }
                        if replayed > 0 {
                            ulog_info!("[im] Replayed {} buffered messages", replayed);
                        }

                        // Update buffer count in health
                        task_health
                            .set_buffered_messages(task_buffer.lock().await.len())
                            .await;

                        // Cleanup: release guards, then remove stale peer_lock entry
                        drop(_permit);
                        drop(_peer_guard);
                        drop(peer_lock);
                        {
                            let mut locks = task_locks.lock().await;
                            if let Some(lock_arc) = locks.get(&session_key) {
                                if Arc::strong_count(lock_arc) == 1 {
                                    locks.remove(&session_key);
                                }
                            }
                        }
                    });
                }
                // Drain completed tasks (handle panics)
                Some(result) = in_flight.join_next(), if !in_flight.is_empty() => {
                    if let Err(e) = result {
                        ulog_error!("[im] Message task panicked: {}", e);
                    }
                }
                // Flush expired media groups
                _ = tokio::time::sleep(flush_timeout) => {
                    let expired_keys: Vec<String> = media_groups
                        .iter()
                        .filter(|(_, entry)| entry.first_received.elapsed() >= MEDIA_GROUP_TIMEOUT)
                        .map(|(k, _)| k.clone())
                        .collect();

                    for group_id in expired_keys {
                        if let Some(entry) = media_groups.remove(&group_id) {
                            let merged = merge_media_group(entry.messages);
                            ulog_info!(
                                "[im] Flushed media group {} ({} attachments)",
                                group_id,
                                merged.attachments.len(),
                            );
                            // Re-inject merged message into the channel
                            if msg_tx_for_reinjection.send(merged).await.is_err() {
                                ulog_error!("[im] Failed to re-inject merged media group");
                            }
                        }
                    }
                }
                _ = process_shutdown_rx.changed() => {
                    if *process_shutdown_rx.borrow() {
                        ulog_info!(
                            "[im] Processing loop shutting down, waiting for {} in-flight task(s)",
                            in_flight.len(),
                        );
                        // Drain remaining in-flight tasks before exiting
                        while let Some(result) = in_flight.join_next().await {
                            if let Err(e) = result {
                                ulog_error!("[im] Task panicked during shutdown: {}", e);
                            }
                        }
                        break;
                    }
                }
            }
        }
    });

    // Start idle session collector
    let router_for_idle = Arc::clone(&router);
    let manager_for_idle = Arc::clone(sidecar_manager);
    let mut idle_shutdown_rx = shutdown_rx.clone();

    let _idle_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    router_for_idle.lock().await.collect_idle_sessions(&manager_for_idle);
                }
                _ = idle_shutdown_rx.changed() => {
                    if *idle_shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    let started_at = Instant::now();

    // Build status (include bind URL for QR code flow / bind code for text bind)
    let bot_username_for_url = health.get_state().await.bot_username.clone();
    let (bind_url, bind_code_for_status) = match config.platform {
        ImPlatform::Telegram => {
            let url = bot_username_for_url
                .as_ref()
                .map(|u| format!("https://t.me/{}?start={}", u, bind_code));
            (url, None)
        }
        ImPlatform::Feishu => (None, Some(bind_code.clone())),
    };

    let status = ImBotStatus {
        bot_username: bot_username_for_url.clone(),
        status: ImStatus::Online,
        uptime_seconds: 0,
        last_message_at: None,
        active_sessions: Vec::new(),
        error_message: None,
        restart_count: 0,
        buffered_messages: buffer.lock().await.len(),
        bind_url,
        bind_code: bind_code_for_status,
    };

    // ===== Heartbeat Runner (v0.1.21) =====
    let (heartbeat_handle, heartbeat_wake_tx, heartbeat_config_arc) = {
        let hb_config = config.heartbeat_config.clone().unwrap_or_default();
        let hb_bot_label = bot_username_for_url.clone().unwrap_or_else(|| bot_id.to_string());
        let (runner, config_arc) = heartbeat::HeartbeatRunner::new(
            hb_config,
            hb_bot_label,
            Arc::clone(&current_model),
            Arc::clone(&mcp_servers_json),
        );
        let (wake_tx, wake_rx) = mpsc::channel::<types::WakeReason>(64);

        let hb_shutdown_rx = shutdown_rx.clone();
        let hb_router = Arc::clone(&router);
        let hb_sidecar = Arc::clone(sidecar_manager);
        let hb_adapter = Arc::clone(&adapter);
        let hb_app = app_handle.clone();

        let handle = tokio::spawn(async move {
            runner.run_loop(
                hb_shutdown_rx,
                wake_rx,
                hb_router,
                hb_sidecar,
                hb_adapter,
                hb_app,
            ).await;
        });

        ulog_info!("[im] Heartbeat runner spawned for bot {}", bot_id);
        (Some(handle), Some(wake_tx), Some(config_arc))
    };

    // Store instance
    let instance_platform = config.platform.clone();
    im_guard.insert(bot_id.clone(), ImBotInstance {
        bot_id,
        platform: instance_platform,
        shutdown_tx,
        health: Arc::clone(&health),
        router,
        buffer,
        started_at,
        process_handle,
        poll_handle,
        approval_handle,
        health_handle,
        bind_code,
        config,
        heartbeat_handle,
        heartbeat_wake_tx,
        heartbeat_config: heartbeat_config_arc,
        adapter: Arc::clone(&adapter),
        // Hot-reloadable config (Arc clones shared with processing loop)
        current_model,
        current_provider_env,
        permission_mode,
        mcp_servers_json,
        available_providers_json,
        allowed_users,
    });

    Ok(status)
}

/// Stop the IM Bot
pub async fn stop_im_bot(
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: &str,
) -> Result<(), String> {
    let mut im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.remove(bot_id) {
        ulog_info!("[im] Stopping IM Bot {}...", bot_id);

        // Signal shutdown to all loops
        let _ = instance.shutdown_tx.send(true);

        // Abort poll_handle to cancel in-flight long-poll HTTP request immediately.
        // Without this, the old getUpdates request hangs for up to 30s on Telegram servers,
        // causing 409 Conflict errors if the bot is restarted quickly.
        instance.poll_handle.abort();

        // Wait for in-flight messages to finish (graceful: up to 10s)
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            instance.process_handle,
        )
        .await
        {
            Ok(_) => ulog_info!("[im] Processing loop exited gracefully"),
            Err(_) => ulog_warn!("[im] Processing loop did not exit within 10s, proceeding with shutdown"),
        }

        // Wait for auxiliary tasks to finish (short timeout — already signaled via shutdown_tx)
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.approval_handle).await;
        if let Some(hb) = instance.heartbeat_handle {
            // Heartbeat runner may be mid-HTTP-call; wait before releasing Sidecars
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), hb).await;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.health_handle).await;

        // Persist remaining buffered messages to disk
        if let Err(e) = instance.buffer.lock().await.save_to_disk() {
            ulog_warn!("[im] Failed to persist buffer on shutdown: {}", e);
        }

        // Flush dedup cache to disk (Feishu only — ensures last entries survive restart)
        if let AnyAdapter::Feishu(ref feishu) = *instance.adapter {
            feishu.flush_dedup_cache().await;
        }

        // Persist active sessions in health state before releasing Sidecars
        instance
            .health
            .set_active_sessions(instance.router.lock().await.active_sessions())
            .await;

        // Release all Sidecar sessions
        instance
            .router
            .lock()
            .await
            .release_all(sidecar_manager);

        // Final health state: mark as Stopped and persist
        instance.health.set_status(ImStatus::Stopped).await;
        let _ = instance.health.persist().await;

        ulog_info!("[im] IM Bot stopped");
    } else {
        ulog_debug!("[im] IM Bot was not running");
    }

    Ok(())
}

/// Get current IM Bot status for a specific bot
pub async fn get_im_bot_status(im_state: &ManagedImBots, bot_id: &str) -> ImBotStatus {
    let im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.get(bot_id) {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status.bot_username.as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
        };

        ImBotStatus {
            bot_username: status.bot_username,
            status: status.status,
            uptime_seconds: status.uptime_seconds,
            last_message_at: status.last_message_at,
            active_sessions: status.active_sessions,
            error_message: status.error_message,
            restart_count: status.restart_count,
            buffered_messages: status.buffered_messages,
            bind_url,
            bind_code: bind_code_opt,
        }
    } else {
        ImBotStatus::default()
    }
}

/// Get status of all running bots
pub async fn get_all_bots_status(im_state: &ManagedImBots) -> HashMap<String, ImBotStatus> {
    let im_guard = im_state.lock().await;
    let mut result = HashMap::new();

    for (bot_id, instance) in im_guard.iter() {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status.bot_username.as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
        };

        result.insert(bot_id.clone(), ImBotStatus {
            bot_username: status.bot_username,
            status: status.status,
            uptime_seconds: status.uptime_seconds,
            last_message_at: status.last_message_at,
            active_sessions: status.active_sessions,
            error_message: status.error_message,
            restart_count: status.restart_count,
            buffered_messages: status.buffered_messages,
            bind_url,
            bind_code: bind_code_opt,
        });
    }

    result
}

// ===== SSE Stream → IM Draft ====

/// Consume Sidecar SSE stream, managing draft message lifecycle for any IM platform.
/// Each text block → independent IM message (streamed draft edits).
/// Returns sessionId on success.
async fn stream_to_im<A: adapter::ImStreamAdapter>(
    client: &Client,
    port: u16,
    msg: &ImMessage,
    adapter: &A,
    chat_id: &str,
    permission_mode: &str,
    provider_env: Option<&serde_json::Value>,
    images: Option<&Vec<serde_json::Value>>,
    pending_approvals: &PendingApprovals,
    bot_id: Option<&str>,
) -> Result<Option<String>, RouteError> {
    // Build request body (same as original route_to_sidecar)
    let source = match (&msg.platform, &msg.source_type) {
        (ImPlatform::Telegram, ImSourceType::Private) => "telegram_private",
        (ImPlatform::Telegram, ImSourceType::Group) => "telegram_group",
        (ImPlatform::Feishu, ImSourceType::Private) => "feishu_private",
        (ImPlatform::Feishu, ImSourceType::Group) => "feishu_group",
    };
    let mut body = json!({
        "message": msg.text,
        "source": source,
        "sourceId": msg.chat_id,
        "senderName": msg.sender_name,
        "permissionMode": permission_mode,
    });
    if let Some(env) = provider_env {
        body["providerEnv"] = env.clone();
    }
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            body["images"] = json!(imgs);
        }
    }
    if let Some(bid) = bot_id {
        body["botId"] = json!(bid);
    }
    let url = format!("http://127.0.0.1:{}/api/im/chat", port);
    ulog_info!("[im-stream] POST {} (SSE)", url);

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| RouteError::Unavailable(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return Err(RouteError::Response(status, error_text));
    }

    // === SSE stream consumption + multi-draft management ===
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();

    // Current text block state (reset on each block-end)
    let mut block_text = String::new();
    let mut draft_id: Option<String> = None;
    let mut last_edit = Instant::now();
    let mut any_text_sent = false;

    // Response-level placeholder state:
    // - placeholder_id: message ID of "🤖 生成中..." sent when first block is non-text
    // - first_content_sent: true once user has seen any content (placeholder or real text)
    let mut placeholder_id: Option<String> = None;
    let mut first_content_sent = false;

    let mut session_id: Option<String> = None;
    const THROTTLE: Duration = Duration::from_millis(1000);

    while let Some(chunk_result) = byte_stream.next().await {
        let chunk = chunk_result
            .map_err(|e| RouteError::Unavailable(format!("SSE stream error: {}", e)))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find("\n\n") {
            let event_str: String = buffer.drain(..pos).collect();
            buffer.drain(..2); // consume the "\n\n" delimiter

            // Skip heartbeat comments
            if event_str.starts_with(':') {
                continue;
            }

            let data = extract_sse_data(&event_str);
            if data.is_empty() {
                continue;
            }

            let json_val: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            match json_val["type"].as_str().unwrap_or("") {
                "partial" => {
                    if let Some(text) = json_val["text"].as_str() {
                        block_text = text.to_string();

                        // First meaningful text in this block → create or adopt draft
                        // Skip whitespace-only blocks (API spacer blocks before thinking)
                        if draft_id.is_none() && !block_text.trim().is_empty() {
                            if let Some(pid) = placeholder_id.take() {
                                // Adopt the placeholder as draft → edit with real content
                                draft_id = Some(pid);
                                let display = format_draft_text(&block_text, adapter.max_message_length());
                                if let Err(e) = adapter.edit_message(chat_id, draft_id.as_ref().unwrap(), &display).await {
                                    ulog_warn!("[im] Placeholder→draft edit failed: {}", e);
                                }
                                last_edit = Instant::now();
                            } else {
                                // No placeholder — send real content directly as draft
                                let display = format_draft_text(&block_text, adapter.max_message_length());
                                match adapter.send_message_returning_id(chat_id, &display).await {
                                    Ok(Some(id)) => {
                                        draft_id = Some(id);
                                        last_edit = Instant::now();
                                    }
                                    _ => {} // draft creation failed; block-end will send_message directly
                                }
                            }
                            first_content_sent = true;
                        }

                        // Throttled edit (≥1s interval)
                        if let Some(ref did) = draft_id {
                            if last_edit.elapsed() >= THROTTLE {
                                let display = format_draft_text(&block_text, adapter.max_message_length());
                                if let Err(e) = adapter.edit_message(chat_id, did, &display).await {
                                    ulog_warn!("[im] Draft edit failed: {}", e);
                                }
                                last_edit = Instant::now();
                            }
                        }
                    }
                }
                "activity" => {
                    // Non-text block started (thinking, tool_use).
                    // If user hasn't seen any content yet, send a placeholder.
                    if !first_content_sent {
                        match adapter.send_message_returning_id(chat_id, "🤖 生成中...").await {
                            Ok(Some(id)) => {
                                placeholder_id = Some(id);
                            }
                            _ => {} // placeholder failed; text blocks will create their own message
                        }
                        first_content_sent = true;
                    }
                }
                "block-end" => {
                    let final_text = json_val["text"]
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| block_text.clone());
                    // Skip whitespace-only blocks (API spacer blocks emitted before thinking)
                    if final_text.trim().is_empty() {
                        // Delete orphaned draft if one was created
                        if let Some(ref did) = draft_id {
                            let _ = adapter.delete_message(chat_id, did).await;
                        }
                    } else {
                        finalize_block(adapter, chat_id, draft_id.clone(), &final_text).await;
                        any_text_sent = true;
                    }
                    // Reset current block state
                    block_text.clear();
                    draft_id = None;
                }
                "complete" => {
                    session_id = json_val["sessionId"].as_str().map(String::from);
                    // Flush any remaining block text (skip whitespace-only)
                    if !block_text.trim().is_empty() {
                        finalize_block(adapter, chat_id, draft_id.clone(), &block_text).await;
                        any_text_sent = true;
                    } else if let Some(ref did) = draft_id {
                        let _ = adapter.delete_message(chat_id, did).await;
                    }
                    if !any_text_sent {
                        // Clean up orphaned placeholder (e.g. only thinking/tool_use, no text output)
                        if let Some(ref pid) = placeholder_id {
                            let _ = adapter.delete_message(chat_id, pid).await;
                        }
                        let _ = adapter.send_message(chat_id, "(No response)").await;
                    }
                    return Ok(session_id);
                }
                "permission-request" => {
                    let request_id = json_val["requestId"].as_str().unwrap_or("").to_string();
                    let tool_name = json_val["toolName"].as_str().unwrap_or("unknown").to_string();
                    let tool_input = json_val["input"].as_str().unwrap_or("").to_string();

                    ulog_info!(
                        "[im-stream] Permission request: tool={}, rid={}",
                        tool_name,
                        &request_id[..request_id.len().min(16)]
                    );

                    // Send interactive approval card/keyboard
                    let card_msg_id = match adapter.send_approval_card(chat_id, &request_id, &tool_name, &tool_input).await {
                        Ok(Some(mid)) => mid,
                        Ok(None) => {
                            ulog_warn!("[im-stream] Approval card sent but no message ID returned");
                            String::new()
                        }
                        Err(e) => {
                            ulog_error!("[im-stream] Failed to send approval card: {}", e);
                            String::new()
                        }
                    };
                    // Always insert pending approval so text fallback ("允许"/"拒绝") works
                    {
                        let mut guard = pending_approvals.lock().await;
                        // Cleanup expired entries (Sidecar auto-denies after 10 min)
                        let now = Instant::now();
                        guard.retain(|_, p| now.duration_since(p.created_at) < Duration::from_secs(15 * 60));
                        guard.insert(request_id, PendingApproval {
                            sidecar_port: port,
                            chat_id: chat_id.to_string(),
                            card_message_id: card_msg_id,
                            created_at: now,
                        });
                    }
                    // SSE stream naturally pauses here — canUseTool Promise is blocking
                }
                "error" => {
                    let error = json_val["error"]
                        .as_str()
                        .unwrap_or("Unknown error");
                    // Delete current draft and placeholder if they exist
                    if let Some(ref did) = draft_id {
                        let _ = adapter.delete_message(chat_id, did).await;
                    }
                    if let Some(ref pid) = placeholder_id {
                        let _ = adapter.delete_message(chat_id, pid).await;
                    }
                    let _ = adapter
                        .send_message(chat_id, &format!("⚠️ {}", error))
                        .await;
                    return Err(RouteError::Response(500, error.to_string()));
                }
                _ => {} // Ignore unknown types
            }
        }
    }

    // Stream disconnected unexpectedly → flush any remaining text (skip whitespace-only)
    if !block_text.trim().is_empty() {
        finalize_block(adapter, chat_id, draft_id.clone(), &block_text).await;
        any_text_sent = true;
    } else if let Some(ref did) = draft_id {
        let _ = adapter.delete_message(chat_id, did).await;
    }
    if !any_text_sent {
        if let Some(ref pid) = placeholder_id {
            let _ = adapter.delete_message(chat_id, pid).await;
        }
        let _ = adapter.send_message(chat_id, "(No response)").await;
    }
    Ok(session_id)
}

/// Finalize a text block's draft message.
/// Uses adapter.max_message_length() to determine the platform's limit.
async fn finalize_block<A: adapter::ImStreamAdapter>(
    adapter: &A,
    chat_id: &str,
    draft_id: Option<String>,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    let max_len = adapter.max_message_length();
    if let Some(ref did) = draft_id {
        if text.chars().count() <= max_len {
            if let Err(e) = adapter.edit_message(chat_id, did, text).await {
                ulog_warn!("[im] Finalize edit failed: {}, sending as new message", e);
                let _ = adapter.send_message(chat_id, text).await;
            }
        } else {
            // Too long for edit: delete draft → send_message (auto-splits)
            let _ = adapter.delete_message(chat_id, did).await;
            let _ = adapter.send_message(chat_id, text).await;
        }
    } else {
        // No draft created (very fast response) → send directly
        let _ = adapter.send_message(chat_id, text).await;
    }
}

/// Format draft display text (truncate if needed for platform limit).
/// `max_len` is the platform's message limit (e.g. 4096 for Telegram, 30000 for Feishu).
fn format_draft_text(text: &str, max_len: usize) -> String {
    // Reserve a small margin for the "..." truncation indicator
    let limit = max_len.saturating_sub(10);
    if text.chars().count() > limit {
        let truncate_at = text
            .char_indices()
            .nth(limit)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        format!("{}...", &text[..truncate_at])
    } else {
        text.to_string()
    }
}

/// Extract `data:` payload from SSE event string.
fn extract_sse_data(event_str: &str) -> String {
    event_str
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| {
            line.strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
                .unwrap_or("")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Generate a non-conflicting file path by appending _1, _2, etc.
fn auto_rename_path(path: &std::path::Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(path);
    for i in 1..100 {
        let new_name = format!("{}_{}{}", stem, i, ext);
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path;
        }
    }
    path.to_path_buf()
}

// ===== Auto-start on app launch =====

/// Config shape from ~/.myagents/config.json (only what we need)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    /// Legacy single-bot config (for migration)
    im_bot_config: Option<PartialBotEntry>,
    /// Multi-bot configs (v0.1.19+)
    im_bot_configs: Option<Vec<PartialBotEntry>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBotEntry {
    id: Option<String>,
    #[serde(flatten)]
    config: ImConfig,
}

/// Auto-start all enabled IM Bots.
/// Called from Tauri `setup` with a short delay to let the app initialize.
pub fn schedule_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize (Sidecar manager, etc.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let configs = read_im_configs_from_disk();
        if configs.is_empty() {
            return;
        }

        use tauri::Manager;
        let im_state = app_handle.state::<ManagedImBots>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for (bot_id, config) in configs {
            let has_credentials = match config.platform {
                ImPlatform::Telegram => !config.bot_token.is_empty(),
                ImPlatform::Feishu => {
                    config.feishu_app_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                        && config.feishu_app_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                }
            };
            if config.enabled && has_credentials {
                ulog_info!("[im] Auto-starting bot: {}", bot_id);
                match start_im_bot(&app_handle, &im_state, &sidecar_manager, bot_id.clone(), config).await {
                    Ok(_) => ulog_info!("[im] Auto-start succeeded for bot {}", bot_id),
                    Err(e) => ulog_warn!("[im] Auto-start failed for bot {}: {}", bot_id, e),
                }
            }
        }
    });
}

/// Read IM bot configs from ~/.myagents/config.json
/// Returns (bot_id, config) pairs for all enabled bots.
///
/// Recovery chain (mirrors frontend safeLoadJson):
///   1. config.json — current version
///   2. config.json.bak — previous known-good version
///   3. config.json.tmp — in-progress write
fn read_im_configs_from_disk() -> Vec<(String, ImConfig)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(".myagents");
    let main_path = config_dir.join("config.json");

    // Try main → .bak → .tmp (same order as frontend safeLoadJson)
    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let app_config: PartialAppConfig = match serde_json::from_str(&content) {
            Ok(c) => c,
            Err(e) => {
                let label = ["main", "bak", "tmp"][i];
                ulog_warn!("[im] Config {} file corrupted, trying next: {}", label, e);
                continue;
            }
        };

        if i > 0 {
            ulog_warn!("[im] Recovered config from {} file", ["main", "bak", "tmp"][i]);
        }

        return parse_bot_entries(app_config);
    }

    Vec::new()
}

/// Extract (bot_id, config) pairs from parsed config.
fn parse_bot_entries(app_config: PartialAppConfig) -> Vec<(String, ImConfig)> {
    // Prefer multi-bot configs, fall back to legacy single-bot
    if let Some(bots) = app_config.im_bot_configs {
        bots.into_iter()
            .map(|entry| {
                let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                (id, entry.config)
            })
            .collect()
    } else if let Some(entry) = app_config.im_bot_config {
        let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        vec![(id, entry.config)]
    } else {
        Vec::new()
    }
}

/// Persist a newly bound user to `~/.myagents/config.json`.
///
/// This runs directly from the Rust bind handler so the user is saved to disk
/// regardless of whether the frontend UI is mounted. Uses the same atomic write
/// pattern as the frontend `safeWriteJson` (write .tmp → backup .bak → rename).
fn persist_bound_user_to_config(bot_id: &str, user_id: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            ulog_warn!("[im] Cannot persist bound user: home dir not found");
            return;
        }
    };
    let config_path = home.join(".myagents").join("config.json");
    let tmp_path = config_path.with_extension("json.tmp.rust");
    let bak_path = config_path.with_extension("json.bak");

    // Read current config as generic JSON to preserve all fields
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            ulog_warn!("[im] Cannot read config.json to persist bound user: {}", e);
            return;
        }
    };
    let mut config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            ulog_warn!("[im] Cannot parse config.json to persist bound user: {}", e);
            return;
        }
    };

    // Find the bot entry and add user to allowedUsers
    let modified = if let Some(bots) = config.get_mut("imBotConfigs").and_then(|v| v.as_array_mut()) {
        if let Some(bot) = bots.iter_mut().find(|b| b.get("id").and_then(|v| v.as_str()) == Some(bot_id)) {
            let users = bot.get_mut("allowedUsers")
                .and_then(|v| v.as_array_mut());
            match users {
                Some(arr) => {
                    let user_val = serde_json::Value::String(user_id.to_string());
                    if !arr.contains(&user_val) {
                        arr.push(user_val);
                        true
                    } else {
                        false // already present
                    }
                }
                None => {
                    // allowedUsers field missing or not an array — create it
                    bot["allowedUsers"] = serde_json::json!([user_id]);
                    true
                }
            }
        } else {
            ulog_warn!("[im] Bot {} not found in config.json, cannot persist bound user", bot_id);
            false
        }
    } else {
        ulog_warn!("[im] No imBotConfigs in config.json, cannot persist bound user");
        false
    };

    if !modified {
        return;
    }

    // Atomic write: .tmp → backup .bak → rename .tmp → main
    let new_content = match serde_json::to_string_pretty(&config) {
        Ok(c) => c,
        Err(e) => {
            ulog_warn!("[im] Cannot serialize config for bound user: {}", e);
            return;
        }
    };

    if let Err(e) = std::fs::write(&tmp_path, &new_content) {
        ulog_warn!("[im] Cannot write tmp config for bound user: {}", e);
        return;
    }

    // Backup current → .bak (best-effort)
    if config_path.exists() {
        let _ = std::fs::rename(&config_path, &bak_path);
    }

    // Rename .tmp → main
    if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
        ulog_warn!("[im] Cannot rename tmp config for bound user: {}", e);
        // Rollback: .bak → main
        if bak_path.exists() && !config_path.exists() {
            let _ = std::fs::rename(&bak_path, &config_path);
        }
        return;
    }

    ulog_info!("[im] Persisted bound user {} for bot {} to config.json", user_id, bot_id);
}

// ===== Tauri Commands =====

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_start_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
    botToken: String,
    allowedUsers: Vec<String>,
    permissionMode: String,
    workspacePath: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    mcpServersJson: Option<String>,
    availableProvidersJson: Option<String>,
    platform: Option<String>,
    feishuAppId: Option<String>,
    feishuAppSecret: Option<String>,
    heartbeatConfigJson: Option<String>,
) -> Result<ImBotStatus, String> {
    let im_platform = match platform.as_deref() {
        Some("feishu") => ImPlatform::Feishu,
        _ => ImPlatform::Telegram,
    };
    let heartbeat_config = heartbeatConfigJson
        .as_deref()
        .filter(|s| !s.is_empty() && *s != "null")
        .and_then(|s| serde_json::from_str::<types::HeartbeatConfig>(s).ok());
    let config = ImConfig {
        platform: im_platform,
        bot_token: botToken,
        allowed_users: allowedUsers,
        permission_mode: permissionMode,
        default_workspace_path: Some(workspacePath),
        enabled: true,
        feishu_app_id: feishuAppId,
        feishu_app_secret: feishuAppSecret,
        model,
        provider_env_json: providerEnvJson,
        mcp_servers_json: mcpServersJson,
        available_providers_json: availableProvidersJson,
        heartbeat_config,
    };

    start_im_bot(
        &app_handle,
        &imState,
        &sidecarManager,
        botId,
        config,
    )
    .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_stop_im_bot(
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
) -> Result<(), String> {
    stop_im_bot(&imState, &sidecarManager, &botId).await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_bot_status(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<ImBotStatus, String> {
    Ok(get_im_bot_status(&imState, &botId).await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_all_bots_status(
    imState: tauri::State<'_, ManagedImBots>,
) -> Result<HashMap<String, ImBotStatus>, String> {
    Ok(get_all_bots_status(&imState).await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_conversations(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<Vec<ImConversation>, String> {
    let im_guard = imState.lock().await;

    if let Some(instance) = im_guard.get(&botId) {
        let sessions = instance.router.lock().await.active_sessions();
        let conversations: Vec<ImConversation> = sessions
            .iter()
            .map(|s| {
                let (source_type, source_id) = router::parse_session_key(&s.session_key);

                ImConversation {
                    session_id: String::new(), // Could be fetched from PeerSession
                    session_key: s.session_key.clone(),
                    source_type,
                    source_id,
                    workspace_path: s.workspace_path.clone(),
                    message_count: s.message_count,
                    last_active: s.last_active.clone(),
                }
            })
            .collect();
        Ok(conversations)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_heartbeat_config(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    heartbeatConfigJson: String,
) -> Result<(), String> {
    let new_config: types::HeartbeatConfig = serde_json::from_str(&heartbeatConfigJson)
        .map_err(|e| format!("Invalid heartbeat config JSON: {}", e))?;

    let im_guard = imState.lock().await;
    if let Some(instance) = im_guard.get(&botId) {
        if let Some(ref config_arc) = instance.heartbeat_config {
            let mut cfg = config_arc.write().await;
            *cfg = new_config;
            ulog_info!("[im] Heartbeat config updated for bot {}", botId);
            Ok(())
        } else {
            Err(format!("Bot {} has no heartbeat runner", botId))
        }
    } else {
        Err(format!("Bot {} not found", botId))
    }
}

/// Hot-update AI config (model + provider env + available providers) for a running bot.
/// Model is synced to all active Sidecars via POST /api/model/set (SDK hot-switch).
/// Provider env is updated in memory — next message automatically uses the new value.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_im_bot_ai_config(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    availableProvidersJson: Option<String>,
) -> Result<(), String> {
    let (router, current_model, current_provider_env, available_providers) = {
        let bots = imState.lock().await;
        let inst = bots.get(&botId).ok_or("Bot not found or not running")?;
        (
            Arc::clone(&inst.router),
            Arc::clone(&inst.current_model),
            Arc::clone(&inst.current_provider_env),
            Arc::clone(&inst.available_providers_json),
        )
    };

    // Selective update: None = don't change, Some("") = clear, Some(json) = set.
    // This allows model-only updates without wiping provider config.
    if let Some(ref m) = model {
        *current_model.write().await = if m.is_empty() { None } else { Some(m.clone()) };
    }
    if let Some(ref s) = providerEnvJson {
        if s.is_empty() {
            *current_provider_env.write().await = None;
        } else {
            let penv = serde_json::from_str(s).ok();
            *current_provider_env.write().await = penv;
        }
    }
    if let Some(ref s) = availableProvidersJson {
        if s.is_empty() {
            *available_providers.write().await = None;
        } else {
            *available_providers.write().await = Some(s.clone());
        }
    }

    // Sync model to all active Sidecars (SDK hot-switch, no session restart needed)
    if model.is_some() {
        let router = router.lock().await;
        for port in router.active_sidecar_ports() {
            router.sync_ai_config(port, model.as_deref(), None).await;
        }
    }

    ulog_info!("[im] AI config hot-updated for bot {}", botId);
    Ok(())
}

/// Hot-update permission mode for a running bot.
/// Permission mode is read from memory on each message — update takes effect immediately.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_im_bot_permission_mode(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    permissionMode: String,
) -> Result<(), String> {
    let perm = {
        let bots = imState.lock().await;
        let inst = bots.get(&botId).ok_or("Bot not found or not running")?;
        Arc::clone(&inst.permission_mode)
    };
    *perm.write().await = permissionMode;
    ulog_info!("[im] Permission mode hot-updated for bot {}", botId);
    Ok(())
}

/// Hot-update MCP servers for a running bot.
/// Syncs to all active Sidecars via POST /api/mcp/set — Sidecar internally handles
/// abort+resume (or deferred restart if a turn is in progress).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_im_bot_mcp_servers(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    mcpServersJson: Option<String>,
) -> Result<(), String> {
    let (router, mcp_servers) = {
        let bots = imState.lock().await;
        let inst = bots.get(&botId).ok_or("Bot not found or not running")?;
        (Arc::clone(&inst.router), Arc::clone(&inst.mcp_servers_json))
    };

    *mcp_servers.write().await = mcpServersJson.clone();

    // Sync to all active Sidecars — setMcpServers() handles abort+resume internally
    let router = router.lock().await;
    for port in router.active_sidecar_ports() {
        router.sync_ai_config(port, None, mcpServersJson.as_deref()).await;
    }

    ulog_info!("[im] MCP servers hot-updated for bot {}", botId);
    Ok(())
}

/// Hot-update allowed users whitelist for a running bot.
/// The adapter shares the same Arc — change takes effect immediately on next message auth check.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_im_bot_allowed_users(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    allowedUsers: Vec<String>,
) -> Result<(), String> {
    let users = {
        let bots = imState.lock().await;
        let inst = bots.get(&botId).ok_or("Bot not found or not running")?;
        Arc::clone(&inst.allowed_users)
    };
    *users.write().await = allowedUsers;
    ulog_info!("[im] Allowed users hot-updated for bot {}", botId);
    Ok(())
}

/// Hot-update default workspace for a running bot.
/// Only affects new sessions — existing sessions keep their current workspace.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_im_bot_workspace(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    workspacePath: String,
) -> Result<(), String> {
    let router = {
        let bots = imState.lock().await;
        let inst = bots.get(&botId).ok_or("Bot not found or not running")?;
        Arc::clone(&inst.router)
    };
    router.lock().await.set_default_workspace(PathBuf::from(&workspacePath));
    ulog_info!("[im] Workspace hot-updated for bot {}: {}", botId, workspacePath);
    Ok(())
}
