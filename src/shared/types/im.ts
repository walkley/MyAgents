// IM Bot integration types (shared between frontend, backend, and Rust)

/**
 * IM platform type
 */
export type ImPlatform = 'telegram' | 'feishu';

/**
 * Message source identifier
 */
export type MessageSource = 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';

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
 * Designed for multi-bot architecture (currently single bot)
 */
export interface ImBotConfig {
  // ===== Multi-bot identity =====
  id: string;                   // Bot unique ID (UUID)
  name: string;                 // User-defined name (e.g. "工作助手")
  platform: ImPlatform;         // Platform type

  // ===== Platform connection =====
  botToken: string;             // Telegram Bot Token
  allowedUsers: string[];       // user_id or username

  // ===== Feishu-specific credentials =====
  feishuAppId?: string;
  feishuAppSecret?: string;

  // ===== AI config (independent from Desktop client) =====
  providerId?: string;          // Provider ID (e.g. 'anthropic-sub', 'deepseek')
  model?: string;               // Model ID (e.g. 'claude-sonnet-4-6')
  permissionMode: string;       // 'plan' | 'auto' | 'fullAgency'
  mcpEnabledServers?: string[]; // Bot-enabled MCP server IDs

  // ===== Workspace =====
  defaultWorkspacePath?: string;

  // ===== Runtime state =====
  enabled: boolean;

  /** Wizard completed (Token verified + user bound). Defaults to false for new bots. */
  setupCompleted?: boolean;
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
  /** Plain bind code for platforms without deep links (e.g. Feishu) */
  bindCode?: string;
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
 * Default Telegram Bot configuration
 */
export const DEFAULT_IM_BOT_CONFIG: ImBotConfig = {
  id: '',           // Generated on creation
  name: 'Telegram Bot',
  platform: 'telegram',
  botToken: '',
  allowedUsers: [],
  providerId: undefined,
  model: undefined,
  permissionMode: 'fullAgency',
  mcpEnabledServers: undefined,
  enabled: false,
  setupCompleted: false,
};

/**
 * Default Feishu Bot configuration
 */
export const DEFAULT_FEISHU_BOT_CONFIG: ImBotConfig = {
  id: '',           // Generated on creation
  name: '飞书 Bot',
  platform: 'feishu',
  botToken: '',     // Not used for Feishu
  allowedUsers: [],
  feishuAppId: '',
  feishuAppSecret: '',
  providerId: undefined,
  model: undefined,
  permissionMode: 'fullAgency',
  mcpEnabledServers: undefined,
  enabled: false,
  setupCompleted: false,
};

/**
 * Source display labels
 */
export const SOURCE_LABELS: Record<MessageSource, string> = {
  desktop: '桌面端',
  telegram_private: 'Telegram 私聊',
  telegram_group: 'Telegram 群聊',
  feishu_private: '飞书私聊',
  feishu_group: '飞书群聊',
};

/**
 * Source display icons
 */
export const SOURCE_ICONS: Record<MessageSource, string> = {
  desktop: '🖥',
  telegram_private: '📱',
  telegram_group: '👥',
  feishu_private: '📱',
  feishu_group: '👥',
};
