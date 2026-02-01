/**
 * System Notification Service
 * Sends system-level notifications when user is not focused on the app
 */

import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

import { isTauriEnvironment } from '../utils/browserMock';

// Track if we've already requested permission this session
let permissionRequested = false;

// Throttle notifications to avoid notification bombing
let lastNotifyTime = 0;
const NOTIFY_THROTTLE_MS = 3000; // 3 seconds between notifications

/**
 * Check if user focus is away from the current window/tab
 * Returns true if notification should be sent
 */
function shouldNotify(): boolean {
    // Check if document is hidden (user switched to another tab/window)
    if (document.hidden) {
        return true;
    }
    // Check if window doesn't have focus
    if (!document.hasFocus()) {
        return true;
    }
    return false;
}

/**
 * Ensure notification permission is granted
 * Requests permission if not already granted
 */
async function ensurePermission(): Promise<boolean> {
    if (!isTauriEnvironment()) {
        return false;
    }

    try {
        let granted = await isPermissionGranted();
        if (!granted && !permissionRequested) {
            permissionRequested = true;
            const permission = await requestPermission();
            granted = permission === 'granted';
        }
        return granted;
    } catch (error) {
        console.warn('[Notification] Failed to check/request permission:', error);
        return false;
    }
}

/**
 * Send a system notification
 * Only sends if user is not focused on the app
 */
async function notify(title: string, body?: string): Promise<void> {
    // Only notify when user is not focused
    if (!shouldNotify()) {
        return;
    }

    // Throttle: avoid notification bombing when multiple events fire rapidly
    const now = Date.now();
    if (now - lastNotifyTime < NOTIFY_THROTTLE_MS) {
        return;
    }
    lastNotifyTime = now;

    // Ensure we have permission
    const hasPermission = await ensurePermission();
    if (!hasPermission) {
        return;
    }

    try {
        sendNotification({ title, body });
    } catch (error) {
        console.warn('[Notification] Failed to send notification:', error);
    }
}

/**
 * Notify that AI has completed a response
 */
export function notifyMessageComplete(): void {
    void notify('MyAgents - 任务完成', '请您查看结果');
}

/**
 * Notify that AI is requesting permission
 */
export function notifyPermissionRequest(toolName: string): void {
    void notify('MyAgents - 权限请求', `AI 请求使用工具 - ${toolName}`);
}

/**
 * Notify that AI is asking user a question
 */
export function notifyAskUserQuestion(): void {
    void notify('MyAgents - 需求确认', 'AI 等待您的确认相关信息');
}

/**
 * Initialize notification service
 * Call this early in app lifecycle to pre-request permission
 */
export async function initNotificationService(): Promise<void> {
    if (!isTauriEnvironment()) {
        return;
    }
    // Pre-check permission status (don't request yet, wait for first notification)
    try {
        await isPermissionGranted();
    } catch {
        // Ignore errors during init
    }
}
