import { Loader2 } from 'lucide-react';
import { memo, useMemo, useState, useEffect, useRef, type CSSProperties, type RefObject } from 'react';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import type { Message as MessageType } from '@/types/chat';

/**
 * Format elapsed seconds to human-readable string
 * - < 60s: "30秒"
 * - < 1h: "1分钟3秒"
 * - >= 1h: "1小时50分钟10秒"
 */
function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分钟${seconds}秒`;
  } else if (minutes > 0) {
    return `${minutes}分钟${seconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

interface MessageListProps {
  messages: MessageType[];
  isLoading: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  bottomPadding?: number;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  systemStatus?: string | null;  // SDK system status (e.g., 'compacting')
}

// Enable CSS scroll anchoring for smoother streaming experience
// overscroll-none completely prevents scroll chaining (works even without scrollbar)
const containerClasses = 'flex-1 overflow-y-auto overscroll-none px-3 py-3 scroll-anchor-auto';

// Fun streaming status messages - randomly picked for each AI response
const STREAMING_MESSAGES = [
  // 思考类
  '苦思冥想中…',
  '深思熟虑中…',
  '灵光一闪中…',
  '绞尽脑汁中…',
  '思绪飞速运转中…',
  // 拟人/可爱类
  '小脑袋瓜转啊转…',
  '神经元疯狂放电中…',
  '灵感小火花碰撞中…',
  '正在努力组织语言…',
  // 比喻类
  '在知识海洋里捞答案…',
  '正在翻阅宇宙图书馆…',
  '答案正在酝酿中…',
  '灵感咖啡冲泡中…',
  // 程序员幽默类
  '递归思考中，请勿打扰…',
  '正在遍历可能性…',
  '加载智慧模块中…',
  // 轻松俏皮类
  '容我想想…',
  '稍等，马上就好…',
  '别急，好饭不怕晚…',
  '正在认真对待你的问题…',
];

// System status messages (fixed, not random)
const SYSTEM_STATUS_MESSAGES: Record<string, string> = {
  compacting: '会话内容过长，智能总结中…',
};

function getRandomStreamingMessage(): string {
  return STREAMING_MESSAGES[Math.floor(Math.random() * STREAMING_MESSAGES.length)];
}

/**
 * StatusTimer - isolated component for elapsed time counter.
 * Ticks every 1s via setInterval. Isolating it here prevents the
 * parent MessageList from re-rendering (and re-running messages.map())
 * on every tick.
 */
const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);

  useEffect(() => {
    startTimeRef.current = Date.now();

    const intervalId = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>
        {message}
        {elapsedSeconds > 0 && ` (${formatElapsedTime(elapsedSeconds)})`}
      </span>
    </div>
  );
});

export default function MessageList({
  messages,
  isLoading,
  containerRef,
  bottomPadding,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  systemStatus,
}: MessageListProps) {
  const containerStyle: CSSProperties | undefined =
    bottomPadding ? { paddingBottom: bottomPadding } : undefined;

  // Keep the same random message during one streaming session
  // Use messages.length as a stable key - new message is picked when a new AI response starts
  const streamingMessage = useMemo(
    () => getRandomStreamingMessage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only change when message count changes
    [messages.length]
  );

  // Determine status display
  const showStatus = isLoading || !!systemStatus;
  const statusMessage = systemStatus
    ? (SYSTEM_STATUS_MESSAGES[systemStatus] || systemStatus)
    : streamingMessage;

  return (
    <div ref={containerRef} className={`relative ${containerClasses}`} style={containerStyle}>
      <div className="mx-auto max-w-3xl space-y-2">
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            isLoading={isLoading && index === messages.length - 1}
          />
        ))}
        {/* Permission prompt inline after messages */}
        {pendingPermission && onPermissionDecision && (
          <div className="py-2">
            <PermissionPrompt
              request={pendingPermission}
              onDecision={(_requestId, decision) => onPermissionDecision(decision)}
            />
          </div>
        )}
        {/* AskUserQuestion prompt inline after messages */}
        {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
          <div className="py-2">
            <AskUserQuestionPrompt
              request={pendingAskUserQuestion}
              onSubmit={onAskUserQuestionSubmit}
              onCancel={onAskUserQuestionCancel}
            />
          </div>
        )}
        {/* Unified status indicator - rendered in isolated component to avoid
            re-running messages.map() on every 1-second timer tick */}
        {showStatus && <StatusTimer message={statusMessage} />}
      </div>
      {/* Scroll anchor - helps browser maintain scroll position during content changes */}
      <div className="scroll-anchor h-px" aria-hidden="true" />
    </div>
  );
}
