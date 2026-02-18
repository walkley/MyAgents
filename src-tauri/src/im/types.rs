// IM Bot integration types (Rust side)

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Instant;

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

/// Incoming IM message (from Telegram adapter)
#[derive(Debug, Clone)]
pub struct ImMessage {
    pub chat_id: String,
    pub message_id: i64,
    pub text: String,
    pub sender_id: i64,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
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
        format!("im:telegram:{}:{}", source, self.chat_id)
    }
}

/// IM Bot configuration (from frontend settings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConfig {
    pub bot_token: String,
    pub allowed_users: Vec<String>,
    pub permission_mode: String,
    pub default_workspace_path: Option<String>,
    pub enabled: bool,
    // ===== AI config (new) =====
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default)]
    pub mcp_servers_json: Option<String>,
    /// Available providers for /provider command: [{id, name, primaryModel, baseUrl?, authType?, apiKey?}]
    #[serde(default)]
    pub available_providers_json: Option<String>,
}

impl Default for ImConfig {
    fn default() -> Self {
        Self {
            bot_token: String::new(),
            allowed_users: Vec::new(),
            permission_mode: "plan".to_string(),
            default_workspace_path: None,
            enabled: false,
            model: None,
            provider_env_json: None,
            mcp_servers_json: None,
            available_providers_json: None,
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
    pub message_id: i64,
    pub text: String,
    pub sender_id: i64,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
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
            message_id: msg.message_id,
            text: msg.text.clone(),
            sender_id: msg.sender_id,
            sender_name: msg.sender_name.clone(),
            source_type: msg.source_type.clone(),
            timestamp: msg.timestamp.to_rfc3339(),
            retry_count: 0,
        }
    }

    /// Convert back to ImMessage for route_message() replay.
    /// Note: attachments are lost (binary data too large for JSON serialization).
    pub fn to_im_message(&self) -> ImMessage {
        ImMessage {
            chat_id: self.chat_id.clone(),
            message_id: self.message_id,
            text: self.text.clone(),
            sender_id: self.sender_id,
            sender_name: self.sender_name.clone(),
            source_type: self.source_type.clone(),
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
