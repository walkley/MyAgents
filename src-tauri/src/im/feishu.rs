// Feishu (Lark) Bot adapter
// Handles WebSocket long connection, message sending/editing/deleting,
// tenant_access_token management, and event parsing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, Instant};

use prost::Message as ProstMessage;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use super::types::{ImConfig, ImMessage, ImPlatform, ImSourceType};
use crate::{proxy_config, ulog_info, ulog_warn, ulog_error, ulog_debug};

// ── Feishu WebSocket Protobuf Frame ──────────────────────────
// Matches the official larksuite/oapi-sdk-go Frame definition (pbbp2.pb.go).
// Feishu WS sends ONLY binary protobuf frames — text frames are never used.

#[derive(Clone, PartialEq, ProstMessage)]
struct WsFrame {
    #[prost(uint64, tag = 1)]
    seq_id: u64,
    #[prost(uint64, tag = 2)]
    log_id: u64,
    #[prost(int32, tag = 3)]
    service: i32,
    #[prost(int32, tag = 4)]
    method: i32, // 0 = control, 1 = data
    #[prost(message, repeated, tag = 5)]
    headers: Vec<WsHeader>,
    #[prost(string, optional, tag = 6)]
    payload_encoding: Option<String>,
    #[prost(string, optional, tag = 7)]
    payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = 8)]
    payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = 9)]
    log_id_new: Option<String>,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct WsHeader {
    #[prost(string, tag = 1)]
    key: String,
    #[prost(string, tag = 2)]
    value: String,
}

/// Frame method constants (from official SDK)
const FRAME_METHOD_CONTROL: i32 = 0;
const FRAME_METHOD_DATA: i32 = 1;

/// Dedup cache TTL (30 minutes)
const DEDUP_TTL: Duration = Duration::from_secs(30 * 60);
/// Max dedup cache size before forced cleanup
const DEDUP_MAX_SIZE: usize = 5000;

/// Feishu API base URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn/open-apis";
/// Token refresh margin (refresh when < 10 min remaining)
const TOKEN_REFRESH_MARGIN_SECS: u64 = 600;
/// Token validity period (Feishu tokens are valid for 2 hours)
const TOKEN_VALIDITY_SECS: u64 = 7200;
/// WebSocket reconnect initial backoff
const WS_INITIAL_BACKOFF_SECS: u64 = 1;
/// WebSocket reconnect max backoff
const WS_MAX_BACKOFF_SECS: u64 = 60;

/// Cached tenant access token
struct TokenCache {
    access_token: String,
    expires_at: Instant,
}

// ── Markdown → Feishu Post converter ─────────────────────────

/// List tracking state for nested lists
enum ListKind {
    Unordered,
    Ordered(u64), // current item number
}

/// Convert Markdown text to Feishu Post rich-text format.
/// Returns a serde_json::Value with the structure: {"zh_cn": {"content": [[...], ...]}}
fn markdown_to_feishu_post(md: &str) -> Value {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(md, opts);

    let mut paragraphs: Vec<Vec<Value>> = Vec::new();
    let mut current_line: Vec<Value> = Vec::new();
    let mut styles: Vec<String> = Vec::new();
    let mut link_url: Option<String> = None;
    let mut in_code_block = false;
    let mut code_block_buf = String::new();
    let mut list_stack: Vec<ListKind> = Vec::new();
    let mut item_prefix: Option<String> = None;
    let mut in_blockquote = false;

    for event in parser {
        match event {
            Event::Start(Tag::Strong) => {
                styles.push("bold".to_string());
            }
            Event::End(TagEnd::Strong) => {
                styles.retain(|s| s != "bold");
            }
            Event::Start(Tag::Emphasis) => {
                styles.push("italic".to_string());
            }
            Event::End(TagEnd::Emphasis) => {
                styles.retain(|s| s != "italic");
            }
            Event::Start(Tag::Strikethrough) => {
                styles.push("strikethrough".to_string());
            }
            Event::End(TagEnd::Strikethrough) => {
                styles.retain(|s| s != "strikethrough");
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link_url = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                link_url = None;
            }
            Event::Start(Tag::Heading { .. }) => {
                // Flush any pending line
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                styles.push("bold".to_string());
            }
            Event::End(TagEnd::Heading(_)) => {
                styles.retain(|s| s != "bold");
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::Paragraph) => {
                // Nothing special needed
            }
            Event::End(TagEnd::Paragraph) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::BlockQuote(_)) => {
                in_blockquote = true;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                in_blockquote = false;
            }
            Event::Start(Tag::List(start)) => {
                match start {
                    Some(n) => list_stack.push(ListKind::Ordered(n)),
                    None => list_stack.push(ListKind::Unordered),
                }
            }
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
            }
            Event::Start(Tag::Item) => {
                // Generate prefix based on current list context
                let indent = "  ".repeat(list_stack.len().saturating_sub(1));
                let bq = if in_blockquote { "│ " } else { "" };
                if let Some(list_kind) = list_stack.last_mut() {
                    match list_kind {
                        ListKind::Unordered => {
                            item_prefix = Some(format!("{}{}• ", bq, indent));
                        }
                        ListKind::Ordered(n) => {
                            item_prefix = Some(format!("{}{}{}. ", bq, indent, n));
                            *n += 1;
                        }
                    }
                }
            }
            Event::End(TagEnd::Item) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                in_code_block = true;
                code_block_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                // Each line of code block becomes a separate paragraph
                let buf = std::mem::take(&mut code_block_buf);
                for line in buf.lines() {
                    paragraphs.push(vec![json!({"tag": "text", "text": line})]);
                }
            }
            Event::Text(text) => {
                if in_code_block {
                    code_block_buf.push_str(&text);
                    continue;
                }

                let text_str = text.to_string();

                // Handle blockquote prefix
                let display_text = if in_blockquote && current_line.is_empty() && item_prefix.is_none() {
                    format!("│ {}", text_str)
                } else {
                    text_str
                };

                // Prepend item prefix if any
                let final_text = if let Some(prefix) = item_prefix.take() {
                    format!("{}{}", prefix, display_text)
                } else {
                    display_text
                };

                if let Some(ref url) = link_url {
                    // Link element
                    current_line.push(json!({
                        "tag": "a",
                        "text": final_text,
                        "href": url,
                    }));
                } else if !styles.is_empty() {
                    // Styled text
                    current_line.push(json!({
                        "tag": "text",
                        "text": final_text,
                        "style": styles.clone(),
                    }));
                } else {
                    // Plain text
                    current_line.push(json!({
                        "tag": "text",
                        "text": final_text,
                    }));
                }
            }
            Event::Code(code) => {
                // Inline code: preserve backticks as plain text
                let text = format!("`{}`", code);
                if let Some(prefix) = item_prefix.take() {
                    current_line.push(json!({"tag": "text", "text": format!("{}{}", prefix, text)}));
                } else {
                    current_line.push(json!({"tag": "text", "text": text}));
                }
            }
            Event::SoftBreak => {
                // Flush current line as a paragraph
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::HardBreak => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
            }
            Event::Rule => {
                if !current_line.is_empty() {
                    paragraphs.push(std::mem::take(&mut current_line));
                }
                paragraphs.push(vec![json!({"tag": "text", "text": "───────"})]);
            }
            _ => {}
        }
    }

    // Flush any remaining content
    if !current_line.is_empty() {
        paragraphs.push(current_line);
    }

    // If no content was parsed, return a single empty paragraph
    if paragraphs.is_empty() {
        paragraphs.push(vec![json!({"tag": "text", "text": md})]);
    }

    json!({
        "zh_cn": {
            "content": paragraphs
        }
    })
}

/// Feishu Bot API adapter
pub struct FeishuAdapter {
    app_id: String,
    app_secret: String,
    client: Client,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
    /// Serializes token refresh to prevent concurrent refreshes
    token_refresh_lock: Arc<tokio::sync::Mutex<()>>,
    msg_tx: mpsc::Sender<ImMessage>,
    allowed_users: Arc<RwLock<Vec<String>>>,
    bot_name: Arc<RwLock<Option<String>>>,
    /// Message dedup cache: message_id → timestamp (30min TTL)
    dedup_cache: Arc<Mutex<HashMap<String, Instant>>>,
}

impl FeishuAdapter {
    pub fn new(
        config: &ImConfig,
        msg_tx: mpsc::Sender<ImMessage>,
        allowed_users: Arc<RwLock<Vec<String>>>,
    ) -> Self {
        let client_builder = Client::builder()
            .timeout(Duration::from_secs(30));
        let client = proxy_config::build_client_with_proxy(client_builder)
            .unwrap_or_else(|e| {
                ulog_warn!("[feishu] Failed to build client with proxy: {}, falling back to direct", e);
                Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .expect("Failed to create HTTP client")
            });

        Self {
            app_id: config.feishu_app_id.clone().unwrap_or_default(),
            app_secret: config.feishu_app_secret.clone().unwrap_or_default(),
            client,
            token_cache: Arc::new(RwLock::new(None)),
            token_refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            msg_tx,
            allowed_users,
            bot_name: Arc::new(RwLock::new(None)),
            dedup_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // ===== Token management =====

    /// Get a valid tenant access token, refreshing if expired.
    async fn get_token(&self) -> Result<String, String> {
        // Check cache first
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if Instant::now() < tc.expires_at {
                    return Ok(tc.access_token.clone());
                }
            }
        }

        // Refresh token
        self.refresh_token().await
    }

    /// Request a new tenant_access_token from Feishu.
    /// Uses a Mutex to prevent concurrent refresh requests (race condition).
    async fn refresh_token(&self) -> Result<String, String> {
        let _guard = self.token_refresh_lock.lock().await;

        // Double-check: another caller may have refreshed while we waited for the lock
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if Instant::now() < tc.expires_at {
                    return Ok(tc.access_token.clone());
                }
            }
        }

        let url = format!("{}/auth/v3/tenant_access_token/internal", FEISHU_API_BASE);
        let body = json!({
            "app_id": self.app_id,
            "app_secret": self.app_secret,
        });

        let resp = self.client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Token request failed: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Token request HTTP {}: {}", status, text));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Token response parse error: {}", e))?;

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            return Err(format!(
                "Token request error code {}: {}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }

        let token = json["tenant_access_token"]
            .as_str()
            .ok_or_else(|| "No tenant_access_token in response".to_string())?
            .to_string();

        let expire = json["expire"].as_u64().unwrap_or(TOKEN_VALIDITY_SECS);
        let expires_at = Instant::now() + Duration::from_secs(expire.saturating_sub(TOKEN_REFRESH_MARGIN_SECS));

        // Update cache
        {
            let mut cache = self.token_cache.write().await;
            *cache = Some(TokenCache {
                access_token: token.clone(),
                expires_at,
            });
        }

        ulog_info!("[feishu] Token refreshed, expires in {}s", expire);
        Ok(token)
    }

    /// Make an authenticated API call, auto-retrying on 401 (token expired).
    async fn api_call(&self, method: &str, url: &str, body: Option<&Value>) -> Result<Value, String> {
        let mut retries = 0;

        loop {
            let token = self.get_token().await?;

            let mut req = match method {
                "GET" => self.client.get(url),
                "PUT" => self.client.put(url),
                "DELETE" => self.client.delete(url),
                "PATCH" => self.client.patch(url),
                _ => self.client.post(url),
            };

            req = req.header("Authorization", format!("Bearer {}", token));

            if let Some(b) = body {
                req = req.json(b);
            }

            let resp = req.send().await
                .map_err(|e| format!("Feishu API error: {}", e))?;

            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();

            // Handle 401 — refresh token and retry once
            if status.as_u16() == 401 && retries == 0 {
                ulog_warn!("[feishu] Got 401, refreshing token and retrying");
                // Invalidate cache
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            let json: Value = serde_json::from_str(&text)
                .map_err(|e| format!("API response parse error: {}", e))?;

            let code = json["code"].as_i64().unwrap_or(-1);
            if code == 0 {
                return Ok(json);
            }

            // Token invalid error codes
            if (code == 99991663 || code == 99991661) && retries == 0 {
                ulog_warn!("[feishu] Token invalid (code {}), refreshing", code);
                {
                    let mut cache = self.token_cache.write().await;
                    *cache = None;
                }
                retries += 1;
                continue;
            }

            return Err(format!(
                "Feishu API error code {}: {}",
                code,
                json["msg"].as_str().unwrap_or("unknown")
            ));
        }
    }

    // ===== Bot info =====

    /// Get bot info to verify credentials.
    async fn get_bot_info(&self) -> Result<String, String> {
        let url = format!("{}/bot/v3/info", FEISHU_API_BASE);
        let resp = self.api_call("GET", &url, None).await?;

        let bot = &resp["bot"];
        let name = bot["app_name"].as_str().unwrap_or("Feishu Bot");
        *self.bot_name.write().await = Some(name.to_string());
        Ok(name.to_string())
    }

    // ===== Message operations =====

    /// Send a rich-text (post) message and return the message_id.
    /// Automatically converts Markdown to Feishu Post format.
    pub async fn send_text_message(&self, chat_id: &str, text: &str) -> Result<Option<String>, String> {
        let url = format!("{}/im/v1/messages?receive_id_type=chat_id", FEISHU_API_BASE);
        let post_content = markdown_to_feishu_post(text);
        let content = serde_json::to_string(&post_content).unwrap_or_default();
        let body = json!({
            "receive_id": chat_id,
            "msg_type": "post",
            "content": content,
        });

        let resp = self.api_call("POST", &url, Some(&body)).await?;
        let msg_id = resp["data"]["message_id"].as_str().map(String::from);
        Ok(msg_id)
    }

    /// Edit an existing message with rich-text (post) content.
    /// Uses PUT (not PATCH — PATCH is for message cards only).
    /// Automatically converts Markdown to Feishu Post format.
    pub async fn edit_text_message(&self, message_id: &str, text: &str) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        let post_content = markdown_to_feishu_post(text);
        let content = serde_json::to_string(&post_content).unwrap_or_default();
        let body = json!({
            "msg_type": "post",
            "content": content,
        });

        self.api_call("PUT", &url, Some(&body)).await?;
        Ok(())
    }

    /// Delete a message.
    pub async fn delete_text_message(&self, message_id: &str) -> Result<(), String> {
        let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);
        self.api_call("DELETE", &url, None).await?;
        Ok(())
    }

    // ===== WebSocket long connection =====

    /// Get WebSocket endpoint URL from Feishu.
    /// Unlike other Feishu APIs that use Bearer token, this endpoint requires
    /// AppID + AppSecret directly in the request body (matching official SDK behavior).
    async fn get_ws_endpoint(&self) -> Result<String, String> {
        let url = "https://open.feishu.cn/callback/ws/endpoint";

        // The WS endpoint uses direct app credentials, NOT Bearer token.
        // This matches the official larksuite/oapi-sdk-go implementation.
        let body = json!({
            "AppID": self.app_id,
            "AppSecret": self.app_secret,
        });

        let resp = self.client
            .post(url)
            .header("locale", "zh")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("WS endpoint request failed: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(format!("WS endpoint HTTP {}: {}", status, text));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("WS endpoint response parse error: {}", e))?;

        let code = json["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = json["msg"].as_str().unwrap_or("unknown");
            return Err(format!("WS endpoint error code {}: {}", code, msg));
        }

        // The response contains a URL field with the WSS endpoint
        let ws_url = json["data"]["URL"].as_str()
            .or_else(|| json["data"]["url"].as_str())
            .ok_or_else(|| format!("No WebSocket URL in response: {}", json))?
            .to_string();

        // Append client_config query params
        let client_config = json["data"]["ClientConfig"].as_object()
            .or_else(|| json["data"]["client_config"].as_object());

        let final_url = if let Some(config) = client_config {
            // Some Feishu responses include reconnect count etc. in client_config
            let _ = config; // Use if needed
            ws_url
        } else {
            ws_url
        };

        Ok(final_url)
    }

    /// Parse a Feishu IM event into an ImMessage.
    fn parse_im_event(&self, event: &Value) -> Option<ImMessage> {
        let header = event.get("header")?;
        let event_type = header["event_type"].as_str()?;

        if event_type != "im.message.receive_v1" {
            return None;
        }

        let event_data = event.get("event")?;
        let message = event_data.get("message")?;
        let sender = event_data.get("sender")?;

        let chat_id = message["chat_id"].as_str()?.to_string();
        let message_id = message["message_id"].as_str()?.to_string();
        let msg_type = message["message_type"].as_str()?;

        // Only handle text messages for MVP
        if msg_type != "text" {
            ulog_debug!("[feishu] Ignoring non-text message type: {}", msg_type);
            return None;
        }

        let content_str = message["content"].as_str()?;
        let content: Value = serde_json::from_str(content_str).ok()?;
        let text = content["text"].as_str().unwrap_or("").to_string();

        let sender_id = sender["sender_id"]["open_id"].as_str()
            .unwrap_or("")
            .to_string();

        // Sender type: "user" for users
        let sender_type = sender["sender_type"].as_str().unwrap_or("user");
        if sender_type != "user" {
            return None; // Ignore bot's own messages
        }

        // Determine source type from chat_type
        let chat_type = message["chat_type"].as_str().unwrap_or("p2p");
        let source_type = match chat_type {
            "group" => ImSourceType::Group,
            _ => ImSourceType::Private, // "p2p" or default
        };

        Some(ImMessage {
            chat_id,
            message_id,
            text,
            sender_id,
            sender_name: None, // Feishu events don't always include display name
            source_type,
            platform: ImPlatform::Feishu,
            timestamp: chrono::Utc::now(),
            attachments: Vec::new(),
            media_group_id: None,
        })
    }

    /// Check if a user is in the whitelist.
    async fn is_allowed(&self, sender_id: &str) -> bool {
        let allowed = self.allowed_users.read().await;
        if allowed.is_empty() {
            return false; // Empty whitelist = reject all
        }
        allowed.iter().any(|u| u == sender_id)
    }

    /// Get a header value from a protobuf frame by key.
    fn get_frame_header<'a>(frame: &'a WsFrame, key: &str) -> Option<&'a str> {
        frame.headers.iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    /// Build a protobuf pong frame in response to a ping frame.
    fn build_pong_frame(ping_frame: &WsFrame) -> Vec<u8> {
        let mut pong = WsFrame {
            seq_id: ping_frame.seq_id,
            log_id: ping_frame.log_id,
            service: ping_frame.service,
            method: FRAME_METHOD_CONTROL,
            headers: vec![
                WsHeader { key: "type".to_string(), value: "pong".to_string() },
            ],
            payload_encoding: None,
            payload_type: None,
            payload: None,
            log_id_new: ping_frame.log_id_new.clone(),
        };
        // Copy non-type headers from ping
        for h in &ping_frame.headers {
            if h.key != "type" {
                pong.headers.push(h.clone());
            }
        }
        pong.encode_to_vec()
    }

    /// WebSocket listen loop with reconnection.
    /// Feishu WS sends ONLY binary protobuf frames — text frames are ignored.
    pub async fn ws_listen_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        let mut backoff_secs = WS_INITIAL_BACKOFF_SECS;

        loop {
            if *shutdown_rx.borrow() {
                ulog_info!("[feishu] Shutdown signal, exiting WS loop");
                break;
            }

            // Get WebSocket endpoint
            let ws_url = match self.get_ws_endpoint().await {
                Ok(url) => {
                    backoff_secs = WS_INITIAL_BACKOFF_SECS;
                    url
                }
                Err(e) => {
                    ulog_error!("[feishu] Failed to get WS endpoint: {}", e);
                    tokio::select! {
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        _ = shutdown_rx.changed() => {
                            if *shutdown_rx.borrow() { break; }
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
                    continue;
                }
            };

            ulog_info!("[feishu] Connecting to WebSocket: {}...", &ws_url[..ws_url.len().min(80)]);

            // Connect
            let ws_stream = match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((stream, _)) => {
                    ulog_info!("[feishu] WebSocket connected");
                    backoff_secs = WS_INITIAL_BACKOFF_SECS;
                    stream
                }
                Err(e) => {
                    ulog_error!("[feishu] WebSocket connection failed: {}", e);
                    tokio::select! {
                        _ = sleep(Duration::from_secs(backoff_secs)) => {}
                        _ = shutdown_rx.changed() => {
                            if *shutdown_rx.borrow() { break; }
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
                    continue;
                }
            };

            let (mut ws_write, mut ws_read) = futures::StreamExt::split(ws_stream);

            // Read messages — Feishu uses ONLY binary protobuf frames
            loop {
                tokio::select! {
                    msg = futures::StreamExt::next(&mut ws_read) => {
                        match msg {
                            Some(Ok(WsMessage::Binary(data))) => {
                                // Decode protobuf frame
                                let frame = match WsFrame::decode(data.as_ref()) {
                                    Ok(f) => f,
                                    Err(e) => {
                                        ulog_warn!("[feishu] Failed to decode protobuf frame: {}", e);
                                        continue;
                                    }
                                };

                                let msg_type = Self::get_frame_header(&frame, "type").unwrap_or("");

                                match frame.method {
                                    FRAME_METHOD_CONTROL => {
                                        // Control frame: handle ping/pong
                                        if msg_type == "ping" {
                                            let pong_data = Self::build_pong_frame(&frame);
                                            if let Err(e) = ws_write.send(WsMessage::Binary(pong_data.into())).await {
                                                ulog_warn!("[feishu] Failed to send pong: {}", e);
                                            }
                                        }
                                        // "pong" — ignore (shouldn't receive from server)
                                    }
                                    FRAME_METHOD_DATA => {
                                        // Data frame: extract payload and process event
                                        if msg_type != "event" {
                                            ulog_debug!("[feishu] Ignoring data frame type: {}", msg_type);
                                            continue;
                                        }

                                        // Check for fragmentation (sum = total parts, seq = part index)
                                        let sum: usize = Self::get_frame_header(&frame, "sum")
                                            .and_then(|v| v.parse().ok())
                                            .unwrap_or(1);
                                        if sum > 1 {
                                            // Fragmented message — skip for MVP
                                            ulog_warn!("[feishu] Fragmented message (sum={}), skipping", sum);
                                            continue;
                                        }

                                        if let Some(payload_bytes) = &frame.payload {
                                            // Payload is JSON bytes containing the event data
                                            let payload_str = match std::str::from_utf8(payload_bytes) {
                                                Ok(s) => s,
                                                Err(e) => {
                                                    ulog_warn!("[feishu] Invalid UTF-8 in payload: {}", e);
                                                    continue;
                                                }
                                            };
                                            self.handle_event_payload(payload_str).await;
                                        }
                                    }
                                    _ => {
                                        ulog_debug!("[feishu] Unknown frame method: {}", frame.method);
                                    }
                                }
                            }
                            Some(Ok(WsMessage::Ping(data))) => {
                                // WebSocket-level ping (unlikely for Feishu, but handle it)
                                let _ = ws_write.send(WsMessage::Pong(data)).await;
                            }
                            Some(Ok(WsMessage::Close(_))) => {
                                ulog_info!("[feishu] WebSocket closed by server");
                                break;
                            }
                            Some(Err(e)) => {
                                ulog_warn!("[feishu] WebSocket error: {}", e);
                                break;
                            }
                            None => {
                                ulog_info!("[feishu] WebSocket stream ended");
                                break;
                            }
                            _ => {} // Text, Pong, Frame — Feishu doesn't use these
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            ulog_info!("[feishu] Shutdown signal, closing WebSocket");
                            let _ = ws_write.send(WsMessage::Close(None)).await;
                            return;
                        }
                    }
                }
            }

            // Disconnected — reconnect with backoff
            ulog_info!(
                "[feishu] Reconnecting in {}s...",
                backoff_secs
            );
            tokio::select! {
                _ = sleep(Duration::from_secs(backoff_secs)) => {}
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() { break; }
                }
            }
            backoff_secs = (backoff_secs * 2).min(WS_MAX_BACKOFF_SECS);
        }

        ulog_info!("[feishu] WS listen loop exited");
    }

    /// Handle event payload extracted from a protobuf data frame.
    /// The payload is a JSON string containing the Feishu event data.
    async fn handle_event_payload(&self, payload_str: &str) {
        // The payload can be either:
        // 1. Direct event JSON with "header" at top level
        // 2. Wrapped format: { "type": "event", "data": "<stringified JSON>" }
        let json: Value = match serde_json::from_str(payload_str) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[feishu] Failed to parse event payload JSON: {}", e);
                return;
            }
        };

        // Extract the actual event object
        let event: Value = if json.get("header").is_some() {
            // Direct event format
            json
        } else if let Some(data) = json.get("data") {
            // Wrapped format: data is a JSON string
            if let Some(data_str) = data.as_str() {
                match serde_json::from_str(data_str) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        ulog_warn!("[feishu] Failed to parse nested data string: {}", e);
                        return;
                    }
                }
            } else if data.is_object() && data.get("header").is_some() {
                data.clone()
            } else {
                ulog_debug!("[feishu] Unrecognized event payload structure");
                return;
            }
        } else {
            ulog_debug!("[feishu] No header or data in event payload");
            return;
        };

        if let Some(msg) = self.parse_im_event(&event) {
            // Dedup check: skip if message_id was seen within TTL
            {
                let mut cache = self.dedup_cache.lock().await;
                let now = Instant::now();
                // Periodic cleanup: remove expired entries (every 100 inserts or when exceeding max)
                if cache.len() > DEDUP_MAX_SIZE || cache.len() % 100 == 0 {
                    cache.retain(|_, ts| now.duration_since(*ts) < DEDUP_TTL);
                }
                if let Some(prev) = cache.get(&msg.message_id) {
                    if now.duration_since(*prev) < DEDUP_TTL {
                        ulog_debug!("[feishu] Dedup: skipping duplicate message {}", msg.message_id);
                        return;
                    }
                }
                cache.insert(msg.message_id.clone(), now);
            }

            // Check bind code (plain text BIND_xxx in private chat)
            let is_bind_request = msg.text.starts_with("BIND_")
                && msg.source_type == ImSourceType::Private;

            if !is_bind_request && !self.is_allowed(&msg.sender_id).await {
                ulog_debug!("[feishu] Rejected message from non-whitelisted user: {}", msg.sender_id);
                return;
            }

            ulog_info!(
                "[feishu] Dispatching message from {} (chat {}): {} chars",
                msg.sender_id,
                msg.chat_id,
                msg.text.len(),
            );

            if self.msg_tx.send(msg).await.is_err() {
                ulog_error!("[feishu] Message channel closed");
            }
        }
    }
}

// ── ImAdapter trait implementation ─────────────────────────

impl super::adapter::ImAdapter for FeishuAdapter {
    async fn verify_connection(&self) -> super::adapter::AdapterResult<String> {
        let name = self.get_bot_info().await?;
        Ok(name)
    }

    async fn register_commands(&self) -> super::adapter::AdapterResult<()> {
        // Feishu doesn't have BotFather-style command registration
        Ok(())
    }

    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        self.ws_listen_loop(shutdown_rx).await;
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> super::adapter::AdapterResult<()> {
        self.send_text_message(chat_id, text).await.map(|_| ())
    }

    async fn ack_received(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP (no emoji reaction equivalent)
    }

    async fn ack_processing(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP
    }

    async fn ack_clear(&self, _chat_id: &str, _message_id: &str) {
        // No-op for Feishu MVP
    }

    async fn send_typing(&self, _chat_id: &str) {
        // No-op for Feishu (no typing indicator API)
    }
}

// ── ImStreamAdapter trait implementation ─────────────────────────

impl super::adapter::ImStreamAdapter for FeishuAdapter {
    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<Option<String>> {
        self.send_text_message(chat_id, text).await
    }

    async fn edit_message(
        &self,
        _chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.edit_text_message(message_id, text).await
    }

    async fn delete_message(
        &self,
        _chat_id: &str,
        message_id: &str,
    ) -> super::adapter::AdapterResult<()> {
        self.delete_text_message(message_id).await
    }

    fn max_message_length(&self) -> usize {
        30000
    }
}
