// IM Bot integration module
// Manages the Telegram Bot lifecycle, routing IM messages to AI Sidecars.

pub mod adapter;
pub mod buffer;
pub mod health;
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
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinSet;

use crate::sidecar::ManagedSidecarManager;

use buffer::MessageBuffer;
use health::HealthManager;
use router::{
    create_sidecar_stream_client, RouteError, SessionRouter, GLOBAL_CONCURRENCY,
};
use telegram::TelegramAdapter;
use types::{ImBotStatus, ImConfig, ImConversation, ImMessage, ImSourceType, ImStatus};

/// Managed state for the IM Bot subsystem
pub type ManagedImBot = Arc<Mutex<Option<ImBotInstance>>>;

/// Running IM Bot instance
pub struct ImBotInstance {
    shutdown_tx: watch::Sender<bool>,
    health: Arc<HealthManager>,
    router: Arc<Mutex<SessionRouter>>,
    buffer: Arc<Mutex<MessageBuffer>>,
    started_at: Instant,
    /// JoinHandle for the message processing loop (awaited during graceful shutdown)
    process_handle: tokio::task::JoinHandle<()>,
    /// Random bind code for QR code binding flow
    bind_code: String,
    #[allow(dead_code)]
    config: ImConfig,
}

/// Create the managed IM Bot state (called during app setup)
pub fn create_im_bot_state() -> ManagedImBot {
    Arc::new(Mutex::new(None))
}

/// Start the IM Bot
pub async fn start_im_bot<R: Runtime>(
    app_handle: &AppHandle<R>,
    im_state: &ManagedImBot,
    sidecar_manager: &ManagedSidecarManager,
    config: ImConfig,
) -> Result<ImBotStatus, String> {
    let mut im_guard = im_state.lock().await;

    // Gracefully stop existing instance if running
    if let Some(instance) = im_guard.take() {
        log::info!("[im] Stopping existing IM Bot before restart");
        let _ = instance.shutdown_tx.send(true);
        // Wait briefly for in-flight messages (shorter timeout for restart)
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            instance.process_handle,
        )
        .await;
        instance
            .router
            .lock()
            .await
            .release_all(sidecar_manager);
        instance.health.reset().await;
    }

    log::info!(
        "[im] Starting IM Bot (configured workspace: {:?})",
        config.default_workspace_path,
    );

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

    log::info!("[im] Resolved workspace: {}", default_workspace.display());

    // Initialize components
    let health_path = health::default_health_path();
    let health = Arc::new(HealthManager::new(health_path));
    health.set_status(ImStatus::Connecting).await;

    let buffer_path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("im_buffer.json");
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

    // Create Telegram adapter (implements ImAdapter trait)
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel(256);
    let adapter: Arc<TelegramAdapter> = Arc::new(TelegramAdapter::new(
        &config,
        msg_tx,
        Arc::clone(&allowed_users),
    ));

    // Verify bot connection via ImAdapter trait
    use adapter::ImAdapter;
    match adapter.verify_connection().await {
        Ok(display_name) => {
            log::info!("[im] Bot verified: {}", display_name);
            // Extract username from display_name (format: "@username")
            let username = display_name.strip_prefix('@').map(|s| s.to_string());
            health.set_bot_username(username).await;
            health.set_status(ImStatus::Online).await;
            health.set_error(None).await;
        }
        Err(e) => {
            let err_msg = format!("Bot connection verification failed: {}", e);
            log::error!("[im] {}", err_msg);
            health.set_status(ImStatus::Error).await;
            health.set_error(Some(err_msg.clone())).await;
            let _ = health.persist().await;
            return Err(err_msg);
        }
    }

    // Register platform commands via ImAdapter trait
    if let Err(e) = adapter.register_commands().await {
        log::warn!("[im] Failed to register bot commands: {}", e);
    }

    // Start health persist loop
    let _health_handle = health.start_persist_loop(shutdown_rx.clone());

    // Start Telegram long-poll loop
    let adapter_clone = Arc::clone(&adapter);
    let poll_shutdown_rx = shutdown_rx.clone();
    let _poll_handle = tokio::spawn(async move {
        adapter_clone.listen_loop(poll_shutdown_rx).await;
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
    let permission_mode = config.permission_mode.clone();
    // Parse provider env from config (for per-message forwarding to Sidecar)
    let provider_env: Option<serde_json::Value> = config
        .provider_env_json
        .as_ref()
        .and_then(|json_str| serde_json::from_str(json_str).ok());
    let bind_code_for_loop = bind_code.clone();
    let allowed_users_for_loop = Arc::clone(&allowed_users);
    let current_model_for_loop = Arc::clone(&current_model);
    let mcp_servers_json_for_loop = config.mcp_servers_json.clone();
    let mut process_shutdown_rx = shutdown_rx.clone();

    // Concurrency primitives (live outside the router for lock-free access)
    let global_semaphore = Arc::new(Semaphore::new(GLOBAL_CONCURRENCY));
    let peer_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stream_client = create_sidecar_stream_client();

    let process_handle = tokio::spawn(async move {
        let mut in_flight: JoinSet<()> = JoinSet::new();

        loop {
            tokio::select! {
                Some(msg) = msg_rx.recv() => {
                    let session_key = SessionRouter::session_key(&msg);
                    let chat_id = msg.chat_id.clone();
                    let message_id = msg.message_id;
                    let text = msg.text.trim().to_string();

                    // ── Bot command dispatch (inline — fast, no Sidecar I/O) ──

                    // QR code binding: /start BIND_xxxx
                    if text.starts_with("/start BIND_") {
                        let code = text.strip_prefix("/start ").unwrap_or("");
                        if code == bind_code_for_loop {
                            // Valid bind — add user to whitelist
                            let user_id_str = msg.sender_id.to_string();
                            let display = msg.sender_name.clone().unwrap_or_else(|| user_id_str.clone());

                            {
                                let mut users = allowed_users_for_loop.write().await;
                                if !users.contains(&user_id_str) {
                                    users.push(user_id_str.clone());
                                    log::info!("[im] User bound via QR: {} ({})", display, user_id_str);
                                }
                            }

                            let reply = format!("✅ 绑定成功！你好 {}，现在可以直接和我聊天了。", display);
                            let _ = adapter_for_reply.send_message(&chat_id, &reply).await;

                            // Emit Tauri event so frontend can persist the new user to config
                            let _ = app_clone.emit(
                                "im:user-bound",
                                serde_json::json!({
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
                             /status — 查看状态\n\n\
                             直接发消息即可开始对话。",
                        ).await;
                        continue;
                    }

                    if text == "/new" {
                        adapter_for_reply.ack_processing(&chat_id, message_id).await;
                        let result = router_clone
                            .lock()
                            .await
                            .reset_session(&session_key, &app_clone, &manager_clone)
                            .await;
                        adapter_for_reply.ack_clear(&chat_id, message_id).await;
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
                        adapter_for_reply.ack_processing(&chat_id, message_id).await;
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
                        adapter_for_reply.ack_clear(&chat_id, message_id).await;
                        let _ = adapter_for_reply.send_message(&chat_id, &reply).await;
                        continue;
                    }

                    if text == "/status" {
                        adapter_for_reply.ack_processing(&chat_id, message_id).await;
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
                        adapter_for_reply.ack_clear(&chat_id, message_id).await;
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
                                log::info!("[im] /model: set to {} (session={})", model_id, s.session_key);
                            }
                            let _ = adapter_for_reply.send_message(
                                &chat_id,
                                &format!("✅ 模型已切换为: {}", model_id),
                            ).await;
                        }
                        continue;
                    }

                    // ── Regular message → spawn concurrent task ──────────
                    log::info!(
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
                    let task_perm = permission_mode.clone();
                    let task_provider_env = provider_env.clone();
                    let task_model = Arc::clone(&current_model_for_loop);
                    let task_mcp_json = mcp_servers_json_for_loop.clone();
                    let task_stream_client = stream_client.clone();
                    let task_sem = Arc::clone(&global_semaphore);
                    let task_locks = Arc::clone(&peer_locks);

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
                                log::error!("[im] Semaphore closed");
                                return;
                            }
                        };

                        // 3. ACK + typing indicator
                        task_adapter.ack_processing(&chat_id, message_id).await;
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
                                task_adapter.ack_clear(&chat_id, message_id).await;
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

                        // 5. SSE stream: route message + stream response to Telegram
                        let session_id = match stream_to_telegram(
                            &task_stream_client,
                            port,
                            &msg,
                            &task_adapter,
                            &chat_id,
                            &task_perm,
                            task_provider_env.as_ref(),
                        )
                        .await
                        {
                            Ok(sid) => {
                                log::info!(
                                    "[im] Stream complete for {} (session={})",
                                    session_key,
                                    sid.as_deref().unwrap_or("?"),
                                );
                                sid
                            }
                            Err(e) => {
                                log::error!("[im] Stream error for {}: {}", session_key, e);
                                if e.should_buffer() {
                                    task_buffer.lock().await.push(&msg);
                                }
                                // SSE "error" events are handled inside stream_to_telegram,
                                // but early failures (connection refused, non-200 status) need
                                // explicit notification here.
                                let _ = task_adapter
                                    .send_message(&chat_id, &format!("⚠️ 处理消息时出错: {}", e))
                                    .await;
                                task_adapter.ack_clear(&chat_id, message_id).await;
                                return;
                            }
                        };

                        // 6. Clear ACK reaction
                        task_adapter.ack_clear(&chat_id, message_id).await;

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
                                    match stream_to_telegram(
                                        &task_stream_client,
                                        port,
                                        &buf_msg,
                                        &task_adapter,
                                        &buf_chat_id,
                                        &task_perm,
                                        task_provider_env.as_ref(),
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
                            log::info!("[im] Replayed {} buffered messages", replayed);
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
                        log::error!("[im] Message task panicked: {}", e);
                    }
                }
                _ = process_shutdown_rx.changed() => {
                    if *process_shutdown_rx.borrow() {
                        log::info!(
                            "[im] Processing loop shutting down, waiting for {} in-flight task(s)",
                            in_flight.len(),
                        );
                        // Drain remaining in-flight tasks before exiting
                        while let Some(result) = in_flight.join_next().await {
                            if let Err(e) = result {
                                log::error!("[im] Task panicked during shutdown: {}", e);
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

    // Build status (include bind URL for QR code flow)
    let bot_username_for_url = health.get_state().await.bot_username.clone();
    let bind_url = bot_username_for_url
        .as_ref()
        .map(|u| format!("https://t.me/{}?start={}", u, bind_code));

    let status = ImBotStatus {
        bot_username: bot_username_for_url,
        status: ImStatus::Online,
        uptime_seconds: 0,
        last_message_at: None,
        active_sessions: Vec::new(),
        error_message: None,
        restart_count: 0,
        buffered_messages: buffer.lock().await.len(),
        bind_url,
    };

    // Store instance
    *im_guard = Some(ImBotInstance {
        shutdown_tx,
        health: Arc::clone(&health),
        router,
        buffer,
        started_at,
        process_handle,
        bind_code,
        config,
    });

    Ok(status)
}

/// Stop the IM Bot
pub async fn stop_im_bot(
    im_state: &ManagedImBot,
    sidecar_manager: &ManagedSidecarManager,
) -> Result<(), String> {
    let mut im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.take() {
        log::info!("[im] Stopping IM Bot...");

        // Signal shutdown to all loops
        let _ = instance.shutdown_tx.send(true);

        // Wait for in-flight messages to finish (graceful: up to 10s)
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            instance.process_handle,
        )
        .await
        {
            Ok(_) => log::info!("[im] Processing loop exited gracefully"),
            Err(_) => log::warn!("[im] Processing loop did not exit within 10s, proceeding with shutdown"),
        }

        // Persist remaining buffered messages to disk
        if let Err(e) = instance.buffer.lock().await.save_to_disk() {
            log::warn!("[im] Failed to persist buffer on shutdown: {}", e);
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

        log::info!("[im] IM Bot stopped");
    } else {
        log::debug!("[im] IM Bot was not running");
    }

    Ok(())
}

/// Get current IM Bot status
pub async fn get_im_bot_status(im_state: &ManagedImBot) -> ImBotStatus {
    let im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.as_ref() {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let bind_url = status
            .bot_username
            .as_ref()
            .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));

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
        }
    } else {
        ImBotStatus::default()
    }
}

// ===== SSE Stream → Telegram Draft ====

/// Consume Sidecar SSE stream, managing Telegram draft message lifecycle.
/// Each text block → independent Telegram message (streamed draft edits).
/// Returns sessionId on success.
async fn stream_to_telegram(
    client: &Client,
    port: u16,
    msg: &ImMessage,
    adapter: &TelegramAdapter,
    chat_id: &str,
    permission_mode: &str,
    provider_env: Option<&serde_json::Value>,
) -> Result<Option<String>, RouteError> {
    // Build request body (same as original route_to_sidecar)
    let source = match msg.source_type {
        ImSourceType::Private => "telegram_private",
        ImSourceType::Group => "telegram_group",
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
    let url = format!("http://127.0.0.1:{}/api/im/chat", port);
    log::info!("[im-stream] POST {} (SSE)", url);

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
    let mut draft_id: Option<i64> = None;
    let mut last_edit = Instant::now();
    let mut any_text_sent = false;

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

                        // First text received → send draft message
                        if draft_id.is_none() && !block_text.is_empty() {
                            match adapter.send_message(chat_id, "🤖 生成中...").await {
                                Ok(Some(id)) => {
                                    draft_id = Some(id);
                                    last_edit = Instant::now();
                                }
                                _ => {} // draft creation failed; block-end will send_message directly
                            }
                        }

                        // Throttled edit (≥1s interval)
                        if let Some(did) = draft_id {
                            if last_edit.elapsed() >= THROTTLE {
                                let display = format_draft_text(&block_text);
                                let _ = adapter.edit_message(chat_id, did, &display).await;
                                last_edit = Instant::now();
                            }
                        }
                    }
                }
                "block-end" => {
                    let final_text = json_val["text"]
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| block_text.clone());
                    finalize_block(adapter, chat_id, draft_id, &final_text).await;
                    any_text_sent = true;
                    // Reset current block state
                    block_text.clear();
                    draft_id = None;
                }
                "complete" => {
                    session_id = json_val["sessionId"].as_str().map(String::from);
                    // Flush any remaining block text
                    if !block_text.is_empty() {
                        finalize_block(adapter, chat_id, draft_id, &block_text).await;
                        any_text_sent = true;
                    }
                    if !any_text_sent {
                        let _ = adapter.send_message(chat_id, "(No response)").await;
                    }
                    return Ok(session_id);
                }
                "error" => {
                    let error = json_val["error"]
                        .as_str()
                        .unwrap_or("Unknown error");
                    // Delete current draft if exists
                    if let Some(did) = draft_id {
                        let _ = adapter.delete_message(chat_id, did).await;
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

    // Stream disconnected unexpectedly → flush any remaining text
    if !block_text.is_empty() {
        finalize_block(adapter, chat_id, draft_id, &block_text).await;
        any_text_sent = true;
    }
    if !any_text_sent {
        let _ = adapter.send_message(chat_id, "(No response)").await;
    }
    Ok(session_id)
}

/// Finalize a text block's draft message.
/// Telegram's message limit is 4096 UTF-16 code units; we use char count as a
/// close approximation (exact for BMP characters which cover CJK + ASCII).
async fn finalize_block(
    adapter: &TelegramAdapter,
    chat_id: &str,
    draft_id: Option<i64>,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    if let Some(did) = draft_id {
        if text.chars().count() <= 4096 {
            let _ = adapter.edit_message(chat_id, did, text).await;
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

/// Format draft display text (truncate + generating indicator).
fn format_draft_text(text: &str) -> String {
    if text.chars().count() > 4000 {
        // Find a safe char boundary at ~4000 chars
        let truncate_at = text
            .char_indices()
            .nth(4000)
            .map(|(i, _)| i)
            .unwrap_or(text.len());
        format!("{}...\n\n_⏳ 生成中_", &text[..truncate_at])
    } else {
        format!("{}\n\n_⏳ 生成中_", text)
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

// ===== Auto-start on app launch =====

/// Config shape from ~/.myagents/config.json (only what we need)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    im_bot_config: Option<ImConfig>,
}

/// Auto-start the IM Bot if it was previously enabled.
/// Called from Tauri `setup` with a short delay to let the app initialize.
pub fn schedule_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize (Sidecar manager, etc.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let config = match read_im_config_from_disk() {
            Some(c) if c.enabled && !c.bot_token.is_empty() => c,
            _ => return,
        };

        log::info!("[im] Auto-starting IM Bot (previously enabled)...");

        use tauri::Manager;
        let im_state = app_handle.state::<ManagedImBot>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        match start_im_bot(&app_handle, &im_state, &sidecar_manager, config).await {
            Ok(_) => log::info!("[im] Auto-start succeeded"),
            Err(e) => log::warn!("[im] Auto-start failed: {}", e),
        }
    });
}

/// Read IM bot config from ~/.myagents/config.json
fn read_im_config_from_disk() -> Option<ImConfig> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".myagents").join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let app_config: PartialAppConfig = serde_json::from_str(&content).ok()?;
    app_config.im_bot_config
}

// ===== Tauri Commands =====

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_start_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBot>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botToken: String,
    allowedUsers: Vec<String>,
    permissionMode: String,
    workspacePath: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    mcpServersJson: Option<String>,
) -> Result<ImBotStatus, String> {
    let config = ImConfig {
        bot_token: botToken,
        allowed_users: allowedUsers,
        permission_mode: permissionMode,
        default_workspace_path: Some(workspacePath),
        enabled: true,
        model,
        provider_env_json: providerEnvJson,
        mcp_servers_json: mcpServersJson,
    };

    start_im_bot(
        &app_handle,
        &imState,
        &sidecarManager,
        config,
    )
    .await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_stop_im_bot(
    imState: tauri::State<'_, ManagedImBot>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
) -> Result<(), String> {
    stop_im_bot(&imState, &sidecarManager).await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_bot_status(
    imState: tauri::State<'_, ManagedImBot>,
) -> Result<ImBotStatus, String> {
    Ok(get_im_bot_status(&imState).await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_conversations(
    imState: tauri::State<'_, ManagedImBot>,
) -> Result<Vec<ImConversation>, String> {
    let im_guard = imState.lock().await;

    if let Some(instance) = im_guard.as_ref() {
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
