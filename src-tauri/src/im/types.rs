// IM Bot integration types (Rust side)

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Instant;

/// IM platform type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImPlatform {
    Telegram,
    Feishu,
}

impl std::fmt::Display for ImPlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Telegram => write!(f, "telegram"),
            Self::Feishu => write!(f, "feishu"),
        }
    }
}

/// IM Bot operational status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImStatus {
    Online,
    Connecting,
    Error,
    Stopped,
}

/// IM source type (private chat vs group)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImSourceType {
    Private,
    Group,
}

/// Attachment type determines processing path
#[derive(Debug, Clone)]
pub enum ImAttachmentType {
    /// SDK Vision (base64 image content block) — photo, static sticker
    Image,
    /// Copy to workspace + @path reference — voice, audio, video, document
    File,
}

/// Media attachment downloaded from Telegram
#[derive(Debug, Clone)]
pub struct ImAttachment {
    pub file_name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
    pub attachment_type: ImAttachmentType,
}

/// Incoming IM message (from adapter)
#[derive(Debug, Clone)]
pub struct ImMessage {
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
    pub platform: ImPlatform,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub attachments: Vec<ImAttachment>,
    pub media_group_id: Option<String>,
}

impl ImMessage {
    /// Canonical session key for routing (single source of truth for the format).
    pub fn session_key(&self) -> String {
        let source = match self.source_type {
            ImSourceType::Private => "private",
            ImSourceType::Group => "group",
        };
        format!("im:{}:{}:{}", self.platform, source, self.chat_id)
    }
}

/// IM Bot configuration (from frontend settings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConfig {
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    pub bot_token: String,
    pub allowed_users: Vec<String>,
    pub permission_mode: String,
    pub default_workspace_path: Option<String>,
    pub enabled: bool,
    // ===== Feishu-specific credentials =====
    #[serde(default)]
    pub feishu_app_id: Option<String>,
    #[serde(default)]
    pub feishu_app_secret: Option<String>,
    // ===== AI config =====
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default)]
    pub mcp_servers_json: Option<String>,
    /// Available providers for /provider command: [{id, name, primaryModel, baseUrl?, authType?, apiKey?}]
    #[serde(default)]
    pub available_providers_json: Option<String>,
    // ===== Heartbeat (v0.1.21) =====
    #[serde(default)]
    pub heartbeat_config: Option<HeartbeatConfig>,
}

fn default_platform() -> ImPlatform {
    ImPlatform::Telegram
}

impl Default for ImConfig {
    fn default() -> Self {
        Self {
            platform: ImPlatform::Telegram,
            bot_token: String::new(),
            allowed_users: Vec::new(),
            permission_mode: "plan".to_string(),
            default_workspace_path: None,
            enabled: false,
            feishu_app_id: None,
            feishu_app_secret: None,
            provider_id: None,
            model: None,
            provider_env_json: None,
            mcp_servers_json: None,
            available_providers_json: None,
            heartbeat_config: None,
        }
    }
}

/// Active session info for status display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImActiveSession {
    pub session_key: String,
    pub session_id: String,
    pub source_type: ImSourceType,
    pub workspace_path: String,
    pub message_count: u32,
    pub last_active: String,
}

/// IM Bot runtime status (returned to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBotStatus {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    /// Deep link URL for QR code (e.g. https://t.me/BotName?start=BIND_xxxx)
    pub bind_url: Option<String>,
    /// Plain bind code for platforms without deep links (e.g. Feishu)
    pub bind_code: Option<String>,
}

impl Default for ImBotStatus {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            bind_url: None,
            bind_code: None,
        }
    }
}

/// IM conversation summary (for listing in Desktop UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConversation {
    pub session_id: String,
    pub session_key: String,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub workspace_path: String,
    pub message_count: u32,
    pub last_active: String,
}

/// Per-peer session tracking in SessionRouter
#[derive(Debug)]
pub struct PeerSession {
    pub session_key: String,
    pub session_id: String,
    pub sidecar_port: u16,
    pub workspace_path: PathBuf,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub message_count: u32,
    pub last_active: Instant,
}

/// Buffered message (when Sidecar is unavailable)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BufferedMessage {
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    pub timestamp: String,
    pub retry_count: u32,
    /// Cached session key for efficient pop_for_session matching
    #[serde(default)]
    pub session_key: String,
}

impl BufferedMessage {
    pub fn from_im_message(msg: &ImMessage) -> Self {
        Self {
            session_key: msg.session_key(),
            chat_id: msg.chat_id.clone(),
            message_id: msg.message_id.clone(),
            text: msg.text.clone(),
            sender_id: msg.sender_id.clone(),
            sender_name: msg.sender_name.clone(),
            source_type: msg.source_type.clone(),
            platform: msg.platform.clone(),
            timestamp: msg.timestamp.to_rfc3339(),
            retry_count: 0,
        }
    }

    /// Convert back to ImMessage for route_message() replay.
    /// Note: attachments are lost (binary data too large for JSON serialization).
    pub fn to_im_message(&self) -> ImMessage {
        ImMessage {
            chat_id: self.chat_id.clone(),
            message_id: self.message_id.clone(),
            text: self.text.clone(),
            sender_id: self.sender_id.clone(),
            sender_name: self.sender_name.clone(),
            source_type: self.source_type.clone(),
            platform: self.platform.clone(),
            timestamp: chrono::DateTime::parse_from_rfc3339(&self.timestamp)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
            attachments: Vec::new(),
            media_group_id: None,
        }
    }
}

/// Persistent message buffer (serializable for disk persistence)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBufferData {
    pub messages: VecDeque<BufferedMessage>,
}

impl Default for MessageBufferData {
    fn default() -> Self {
        Self {
            messages: VecDeque::new(),
        }
    }
}

/// Health state for persistence (written to im_state.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImHealthState {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub last_persisted: String,
}

impl Default for ImHealthState {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            last_persisted: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// ===== Heartbeat types (v0.1.21) =====

/// Heartbeat configuration for periodic autonomous checks.
/// The actual checklist content lives in HEARTBEAT.md in the workspace root,
/// not in this config — the config only controls timing and behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatConfig {
    /// Enable/disable heartbeat (default: true)
    #[serde(default = "default_hb_enabled")]
    pub enabled: bool,
    /// Interval in minutes between checks (default: 30, min: 5)
    #[serde(default = "default_hb_interval")]
    pub interval_minutes: u32,
    /// Active hours window
    #[serde(default)]
    pub active_hours: Option<ActiveHours>,
    /// Max chars for HEARTBEAT_OK detection (default: 300)
    #[serde(default)]
    pub ack_max_chars: Option<u32>,
}

fn default_hb_enabled() -> bool {
    true
}

fn default_hb_interval() -> u32 {
    30
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_minutes: 30,
            active_hours: None,
            ack_max_chars: None,
        }
    }
}

/// Active hours window for heartbeat scheduling
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHours {
    /// Start time in HH:MM format (inclusive)
    pub start: String,
    /// End time in HH:MM format (exclusive)
    pub end: String,
    /// IANA timezone name (e.g. "Asia/Shanghai")
    pub timezone: String,
}

/// Reason for heartbeat wake-up
#[derive(Debug, Clone)]
pub enum WakeReason {
    /// Regular interval tick
    Interval,
    /// Cron task completed — high priority, skips active hours check
    CronComplete { task_id: String, summary: String },
    /// Manual/external trigger — high priority
    Manual,
}

impl WakeReason {
    /// High-priority wakes skip active hours and empty-prompt checks
    pub fn is_high_priority(&self) -> bool {
        !matches!(self, WakeReason::Interval)
    }
}

/// Telegram API error types
#[derive(Debug)]
pub enum TelegramError {
    /// Network timeout during API call
    NetworkTimeout,
    /// Rate limited by Telegram (retry after N seconds)
    RateLimited(u64),
    /// Markdown parsing failed (should retry as plain text)
    MarkdownParseError,
    /// Message content didn't change (safe to ignore)
    MessageNotModified,
    /// Message exceeds 4096 char limit
    MessageTooLong,
    /// Group thread no longer exists
    ThreadNotFound,
    /// Bot was kicked from group
    BotKicked,
    /// Bot token is invalid
    TokenUnauthorized,
    /// Other API error
    Other(String),
}

impl std::fmt::Display for TelegramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NetworkTimeout => write!(f, "Network timeout"),
            Self::RateLimited(secs) => write!(f, "Rate limited, retry after {}s", secs),
            Self::MarkdownParseError => write!(f, "Markdown parse error"),
            Self::MessageNotModified => write!(f, "Message not modified"),
            Self::MessageTooLong => write!(f, "Message too long"),
            Self::ThreadNotFound => write!(f, "Thread not found"),
            Self::BotKicked => write!(f, "Bot kicked from group"),
            Self::TokenUnauthorized => write!(f, "Token unauthorized"),
            Self::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for TelegramError {}
