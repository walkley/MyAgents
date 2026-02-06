import { randomUUID } from 'crypto';

/**
 * Session statistics for tracking usage
 */
export interface SessionStats {
    messageCount: number;        // Number of user messages (queries)
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

/**
 * Session metadata stored in sessions.json
 */
export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    /** @deprecated 统一后新 session 的 sdkSessionId === id，保留用于旧 session 兼容 */
    sdkSessionId?: string;
    /** 统一后创建的 session 标记。为 true 时 id 即 SDK session ID */
    unifiedSession?: boolean;
    /** Session statistics */
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
}

/**
 * Full session data including messages
 */
export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

/**
 * Attachment info for messages
 */
export interface MessageAttachment {
    id: string;
    name: string;
    mimeType: string;
    path: string; // Relative path in attachments directory
}

/**
 * Per-model usage breakdown
 */
export interface ModelUsageEntry {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

/**
 * Usage information for assistant messages
 */
export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Primary model (for backwards compatibility and simple display) */
    model?: string;
    /** Per-model breakdown (for detailed statistics) */
    modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * Simplified message format for storage
 */
export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    attachments?: MessageAttachment[];
    /** Usage info (only for assistant messages) */
    usage?: MessageUsage;
    /** Tool call count in this response */
    toolCount?: number;
    /** Response duration in milliseconds */
    durationMs?: number;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate session title from first user message
 */
export function generateSessionTitle(message: string): string {
    const maxLength = 20;
    const trimmed = message.trim();
    if (!trimmed) {
        return 'New Chat';
    }
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return trimmed.slice(0, maxLength) + '...';
}

/**
 * Create a new session metadata object
 */
export function createSessionMetadata(agentDir: string): SessionMetadata {
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        agentDir,
        title: 'New Chat',
        createdAt: now,
        lastActiveAt: now,
        unifiedSession: true,
    };
}
