// IM Bot integration types (shared between frontend, backend, and Rust)

/**
 * Message source identifier
 */
export type MessageSource = 'desktop' | 'telegram_private' | 'telegram_group';

/**
 * Metadata attached to each message indicating its origin
 */
export interface MessageMetadata {
  source: MessageSource;
  sourceId?: string;      // Telegram chat_id
  senderName?: string;    // Telegram username
}

/**
 * IM Bot operational status
 */
export type ImStatus = 'online' | 'connecting' | 'error' | 'stopped';

/**
 * IM source type (private chat vs group)
 */
export type ImSourceType = 'private' | 'group';

/**
 * IM Bot configuration (stored in AppConfig)
 */
export interface ImBotConfig {
  botToken: string;
  allowedUsers: string[];       // Telegram user_id or username
  permissionMode: string;       // 'plan' | 'auto' | 'fullAgency'
  defaultWorkspacePath?: string;
  enabled: boolean;
}

/**
 * Active IM session info (for status display)
 */
export interface ImActiveSession {
  sessionKey: string;         // e.g. "im:telegram:private:12345"
  sessionId: string;          // SDK session ID (for resume after restart)
  sourceType: ImSourceType;
  workspacePath: string;
  messageCount: number;
  lastActive: string;         // ISO timestamp
}

/**
 * IM Bot runtime status (returned by cmd_im_bot_status)
 */
export interface ImBotStatus {
  botUsername?: string;
  status: ImStatus;
  uptimeSeconds: number;
  lastMessageAt?: string;       // ISO timestamp
  activeSessions: ImActiveSession[];
  errorMessage?: string;
  restartCount: number;
  bufferedMessages: number;
  /** Deep link URL for QR code (e.g. https://t.me/BotName?start=BIND_xxxx) */
  bindUrl?: string;
}

/**
 * IM conversation summary (for listing in Desktop UI)
 */
export interface ImConversation {
  sessionId: string;
  sessionKey: string;
  sourceType: ImSourceType;
  sourceId: string;             // Telegram chat_id
  workspacePath: string;
  messageCount: number;
  lastActive: string;           // ISO timestamp
}

/**
 * Default IM Bot configuration
 */
export const DEFAULT_IM_BOT_CONFIG: ImBotConfig = {
  botToken: '',
  allowedUsers: [],
  permissionMode: 'plan',
  enabled: false,
};

/**
 * Source display labels
 */
export const SOURCE_LABELS: Record<MessageSource, string> = {
  desktop: '桌面端',
  telegram_private: 'Telegram 私聊',
  telegram_group: 'Telegram 群聊',
};

/**
 * Source display icons
 */
export const SOURCE_ICONS: Record<MessageSource, string> = {
  desktop: '🖥',
  telegram_private: '📱',
  telegram_group: '👥',
};
