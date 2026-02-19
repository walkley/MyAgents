// Heartbeat Runner for IM Bot
// Periodically checks a user-defined checklist and pushes results to IM.
// Supports active hours, instant wake (from cron completion), and dedup.

use std::sync::Arc;
use std::time::Duration;

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use crate::sidecar::ManagedSidecarManager;
use crate::{ulog_info, ulog_warn, ulog_debug};

use super::adapter::ImAdapter;
use super::router::SessionRouter;
use super::types::{ActiveHours, HeartbeatConfig, WakeReason};
use super::AnyAdapter;

/// Response from Bun /api/im/heartbeat endpoint
#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    status: String,       // "silent" | "content" | "error"
    text: Option<String>,
    #[allow(dead_code)]
    reason: Option<String>,
}

/// Heartbeat prompt sent to Bun
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatRequest {
    prompt: String,
    source: String,
    source_id: String,
    ack_max_chars: u32,
    is_high_priority: bool,
}

/// HeartbeatRunner manages the periodic heartbeat loop for an IM Bot.
pub struct HeartbeatRunner {
    config: Arc<RwLock<HeartbeatConfig>>,
    last_push_text: Arc<Mutex<Option<String>>>,
    http_client: reqwest::Client,
    executing: Arc<Mutex<bool>>,
}

impl HeartbeatRunner {
    /// Create a new HeartbeatRunner.
    /// Returns (runner, wake_sender) — caller keeps wake_sender for external wake signals.
    pub fn new(config: HeartbeatConfig) -> (Self, Arc<RwLock<HeartbeatConfig>>) {
        let config = Arc::new(RwLock::new(config));
        let runner = Self {
            config: Arc::clone(&config),
            last_push_text: Arc::new(Mutex::new(None)),
            http_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(330)) // 5.5 min (heartbeat timeout is 5 min)
                .build()
                .unwrap_or_default(),
            executing: Arc::new(Mutex::new(false)),
        };
        (runner, config)
    }

    /// Main heartbeat loop. Runs until shutdown signal.
    pub(crate) async fn run_loop<R: Runtime>(
        self,
        mut shutdown_rx: watch::Receiver<bool>,
        mut wake_rx: mpsc::Receiver<WakeReason>,
        router: Arc<Mutex<SessionRouter>>,
        sidecar_manager: ManagedSidecarManager,
        adapter: Arc<AnyAdapter>,
        app_handle: AppHandle<R>,
    ) {
        let initial_interval = {
            let cfg = self.config.read().await;
            Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
        };
        let mut interval = tokio::time::interval(initial_interval);
        // Skip the first immediate tick
        interval.tick().await;

        ulog_info!(
            "[heartbeat] Runner started (interval={}min)",
            initial_interval.as_secs() / 60
        );

        loop {
            // Check if interval needs updating
            {
                let cfg = self.config.read().await;
                let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                if desired != interval.period() {
                    ulog_info!(
                        "[heartbeat] Interval changed to {}min",
                        desired.as_secs() / 60
                    );
                    interval = tokio::time::interval(desired);
                    interval.tick().await; // skip immediate tick
                }
            }

            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        ulog_info!("[heartbeat] Shutdown signal received, exiting");
                        break;
                    }
                }
                _ = interval.tick() => {
                    self.run_once(
                        WakeReason::Interval,
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                    ).await;
                }
                Some(reason) = wake_rx.recv() => {
                    // Coalesce: drain any additional wake signals within 250ms window
                    let mut reasons = vec![reason];
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    while let Ok(r) = wake_rx.try_recv() {
                        reasons.push(r);
                    }

                    // Use highest-priority reason
                    let best_reason = reasons.into_iter()
                        .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                        .unwrap_or(WakeReason::Interval);

                    self.run_once(
                        best_reason,
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                    ).await;

                    // Reset interval timer after wake to avoid rapid fire
                    interval.reset();
                }
            }
        }

        ulog_info!("[heartbeat] Runner stopped");
    }

    /// Execute a single heartbeat cycle.
    async fn run_once<R: Runtime>(
        &self,
        reason: WakeReason,
        router: &Arc<Mutex<SessionRouter>>,
        _sidecar_manager: &ManagedSidecarManager,
        adapter: &Arc<AnyAdapter>,
        _app_handle: &AppHandle<R>,
    ) {
        let config = self.config.read().await.clone();
        let is_high_priority = reason.is_high_priority();

        // Gate 1: Enabled check
        if !config.enabled {
            ulog_debug!("[heartbeat] Skipped: disabled");
            return;
        }

        // Gate 2: Active hours (high-priority wakes skip this)
        if !is_high_priority {
            if let Some(ref active_hours) = config.active_hours {
                if !is_in_active_hours(active_hours) {
                    ulog_debug!("[heartbeat] Skipped: outside active hours");
                    return;
                }
            }
        }

        // Gate 3: Concurrent execution guard
        {
            let mut executing = self.executing.lock().await;
            if *executing {
                ulog_debug!("[heartbeat] Skipped: previous heartbeat still executing");
                return;
            }
            *executing = true;
        }

        // Build heartbeat prompt — a FIXED template.
        // The actual checklist lives in HEARTBEAT.md in the workspace root.
        // AI reads the file itself via tool use; we don't inject file content here.
        // System events (cron completion, etc.) are appended by the Bun endpoint
        // via drainSystemEvents() to avoid duplication.
        let now_text = chrono::Local::now().format("%Y-%m-%d %H:%M (%Z)").to_string();
        let prompt = format!(
            "This is a heartbeat from the system.\n\
             Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.\n\
             Do not infer or repeat old tasks from prior chats.\n\
             If there is nothing that needs attention, reply exactly: HEARTBEAT_OK\n\
             If something needs attention, do NOT include \"HEARTBEAT_OK\"\n\
             \n\
             Current time: {}",
            now_text
        );

        // Find a Sidecar port to call
        let (port, source, source_id) = {
            let router_guard = router.lock().await;
            match router_guard.find_any_active_session() {
                Some((p, src, sid)) => (p, src, sid),
                None => {
                    ulog_warn!("[heartbeat] No active session found, skipping");
                    *self.executing.lock().await = false;
                    return;
                }
            }
        };

        let ack_max_chars = config.ack_max_chars.unwrap_or(300);

        // Call Bun heartbeat endpoint
        let request = HeartbeatRequest {
            prompt,
            source: source.clone(),
            source_id: source_id.clone(),
            ack_max_chars,
            is_high_priority,
        };

        let url = format!("http://127.0.0.1:{}/api/im/heartbeat", port);
        ulog_debug!("[heartbeat] Calling {} (reason={:?})", url, reason_label(&reason));

        let result = match self.http_client.post(&url).json(&request).send().await {
            Ok(resp) => {
                match resp.json::<HeartbeatResponse>().await {
                    Ok(r) => r,
                    Err(e) => {
                        ulog_warn!("[heartbeat] Failed to parse response: {}", e);
                        *self.executing.lock().await = false;
                        return;
                    }
                }
            }
            Err(e) => {
                ulog_warn!("[heartbeat] HTTP call failed: {}", e);
                *self.executing.lock().await = false;
                return;
            }
        };

        // Handle response
        match result.status.as_str() {
            "silent" => {
                ulog_debug!("[heartbeat] AI responded HEARTBEAT_OK (silent)");
            }
            "content" => {
                if let Some(text) = &result.text {
                    // Dedup check
                    let mut last_push = self.last_push_text.lock().await;
                    if last_push.as_deref() == Some(text.as_str()) {
                        ulog_debug!("[heartbeat] Dedup suppressed (same content as last push)");
                    } else {
                        // Extract chat_id from source_id for sending
                        ulog_info!("[heartbeat] Pushing content to IM (len={})", text.len());
                        if let Err(e) = adapter.send_message(&source_id, text).await {
                            ulog_warn!("[heartbeat] Failed to send IM message: {}", e);
                        }
                        *last_push = Some(text.clone());
                    }
                }
            }
            "error" => {
                ulog_warn!("[heartbeat] Heartbeat returned error: {:?}", result.text);
            }
            other => {
                ulog_warn!("[heartbeat] Unknown status: {}", other);
            }
        }

        *self.executing.lock().await = false;
    }
}

/// Check if current time is within the active hours window.
fn is_in_active_hours(hours: &ActiveHours) -> bool {
    // Parse timezone
    let tz: chrono_tz::Tz = match hours.timezone.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!("[heartbeat] Invalid timezone '{}', assuming active", hours.timezone);
            return true;
        }
    };

    let now = chrono::Utc::now().with_timezone(&tz);
    let now_minutes = now.hour() * 60 + now.minute();

    let start_minutes = parse_hhmm(&hours.start).unwrap_or(0);
    let end_minutes = parse_hhmm(&hours.end).unwrap_or(24 * 60);

    if start_minutes <= end_minutes {
        // Normal window: e.g. 09:00-22:00
        now_minutes >= start_minutes && now_minutes < end_minutes
    } else {
        // Cross-midnight window: e.g. 22:00-06:00
        now_minutes >= start_minutes || now_minutes < end_minutes
    }
}

/// Parse "HH:MM" to total minutes since midnight.
fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    Some(h * 60 + m)
}

fn reason_label(reason: &WakeReason) -> &str {
    match reason {
        WakeReason::Interval => "interval",
        WakeReason::CronComplete { .. } => "cron_complete",
        WakeReason::Manual => "manual",
    }
}
