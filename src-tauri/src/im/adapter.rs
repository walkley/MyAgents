/// Abstract IM channel adapter trait.
///
/// Each messaging platform (Telegram, Discord, Slack, ...) implements this
/// trait so that the core processing loop in `mod.rs` stays channel-agnostic.

/// Result alias with plain String error (channel-specific error types are
/// mapped to String at the impl boundary).
pub type AdapterResult<T> = Result<T, String>;

pub trait ImAdapter: Send + Sync + 'static {
    /// Verify the bot connection and return a human-readable identifier
    /// (e.g. Telegram bot username, Discord bot tag).
    fn verify_connection(
        &self,
    ) -> impl std::future::Future<Output = AdapterResult<String>> + Send;

    /// Register platform-specific commands (e.g. Telegram BotFather menu).
    /// No-op for platforms that don't support command registration.
    fn register_commands(
        &self,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Start the message receive loop (long-polling, WebSocket, etc.).
    /// Blocks until `shutdown_rx` signals `true`.
    fn listen_loop(
        &self,
        shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a text message to the given chat.
    fn send_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// React to indicate the message was received (e.g. 👀).
    fn ack_received(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// React to indicate processing has started (e.g. ⏳).
    fn ack_processing(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Clear acknowledgement reactions.
    fn ack_clear(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a "typing" / "processing" indicator to the chat.
    fn send_typing(
        &self,
        chat_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;
}

/// Extended adapter trait for platforms that support streaming draft messages.
/// Provides send_message_returning_id, edit_message, and delete_message
/// so the SSE stream loop can manage draft messages generically.
pub trait ImStreamAdapter: ImAdapter {
    /// Send a message and return its ID (for later edit/delete).
    fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Edit an existing message by ID.
    fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Delete a message by ID.
    fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Max message length for this platform (Telegram: 4096, Feishu: 30000).
    fn max_message_length(&self) -> usize;
}
