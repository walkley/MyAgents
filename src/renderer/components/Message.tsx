import { memo, useEffect, useRef, useState } from 'react';
import { Copy, Check, Undo2 } from 'lucide-react';

import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import BlockGroup from '@/components/BlockGroup';
import Markdown from '@/components/Markdown';
import { useImagePreview } from '@/context/ImagePreviewContext';
import type { ContentBlock, Message as MessageType } from '@/types/chat';

interface MessageProps {
  message: MessageType;
  isLoading?: boolean;
  isStreaming?: boolean;       // AI 回复中时隐藏时间回溯按钮
  onRewind?: (messageId: string) => void;
}

/**
 * Format timestamp to "YYYY-MM-DD HH:mm:ss"
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Deep compare message content for memo optimization.
 * Returns true if content is equal (skip re-render), false otherwise.
 */
function areMessagesEqual(prev: MessageProps, next: MessageProps): boolean {
  // Different loading state -> must re-render
  if (prev.isLoading !== next.isLoading) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  // onRewind 不比较 — 通过 Chat.tsx useCallback([]) + ref 保证稳定

  const prevMsg = prev.message;
  const nextMsg = next.message;

  // Same reference -> definitely equal (fast path for history messages)
  if (prevMsg === nextMsg) return true;

  // Different ID -> different message
  if (prevMsg.id !== nextMsg.id) return false;

  // Metadata change -> must re-render
  if (prevMsg.metadata?.source !== nextMsg.metadata?.source) return false;

  // For streaming messages, check content changes
  if (typeof prevMsg.content === 'string' && typeof nextMsg.content === 'string') {
    return prevMsg.content === nextMsg.content;
  }

  // ContentBlock array - compare by reference (streaming updates create new arrays)
  // This allows streaming message to re-render while history messages stay stable
  return prevMsg.content === nextMsg.content;
}

/**
 * Parse SDK local command output tags from user message content.
 * SDK wraps local command output (like /cost, /context) in <local-command-stdout> tags.
 * Returns { isLocalCommand: true, content: string } if found, otherwise { isLocalCommand: false }.
 */
function parseLocalCommandOutput(content: string): { isLocalCommand: boolean; content: string } {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (match) {
    return { isLocalCommand: true, content: match[1].trim() };
  }
  return { isLocalCommand: false, content };
}

/**
 * Format local command output for better readability.
 * SDK outputs like /cost already have proper newlines, but contain $ signs
 * that trigger LaTeX math mode in our Markdown renderer (KaTeX).
 * This function escapes $ to prevent unintended math rendering.
 */
function formatLocalCommandOutput(content: string): string {
  // Escape $ signs that trigger LaTeX math mode
  // Example: "$0.0576" -> "\$0.0576"
  return content.replace(/\$/g, '\\$');
}

/**
 * Message component with memo optimization.
 * History messages won't re-render when streaming message updates.
 */
const Message = memo(function Message({ message, isLoading = false, isStreaming, onRewind }: MessageProps) {
  const { openPreview } = useImagePreview();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (message.role === 'user') {
    const userContent = typeof message.content === 'string' ? message.content : '';
    const hasAttachments = Boolean(message.attachments?.length);
    const attachmentItems =
      message.attachments?.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        isImage: attachment.isImage ?? attachment.mimeType.startsWith('image/'),
        previewUrl: attachment.previewUrl,
        footnoteLines: [attachment.relativePath ?? attachment.savedPath].filter(
          (line): line is string => Boolean(line)
        )
      })) ?? [];

    // Check if this is a local command output (like /cost, /context)
    const parsed = parseLocalCommandOutput(userContent);

    // Local command output - render as system info block (left-aligned)
    if (parsed.isLocalCommand) {
      const formattedContent = formatLocalCommandOutput(parsed.content);
      return (
        <div className="flex justify-start w-full px-4 py-2 select-none">
          <div className="w-full max-w-none rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/50 p-4">
            <div className="text-xs font-medium text-[var(--ink-muted)] mb-2">系统信息</div>
            <div className="text-sm text-[var(--ink)] select-text">
              <Markdown>{formattedContent}</Markdown>
            </div>
          </div>
        </div>
      );
    }

    const hasText = userContent.trim().length > 0;
    const imSource = message.metadata?.source;
    const isImMessage = imSource && imSource !== 'desktop';

    return (
      <div className="group/user relative flex justify-end px-1 select-none"
           data-role="user" data-message-id={message.id}>
        {/* 气泡 + 时间戳 */}
        <div className="flex w-full flex-col items-end">
          {/* IM source indicator */}
          {isImMessage && (
            <div className="mr-2 mb-1 flex items-center gap-1 text-[11px] text-[var(--ink-muted)]">
              {imSource === 'telegram_group' && <span>👥</span>}
              <span>via {imSource === 'telegram_private' ? 'Telegram' : 'Telegram 群聊'}</span>
              {message.metadata?.senderName && (
                <span>· {message.metadata.senderName}</span>
              )}
            </div>
          )}
          <article className="relative w-fit max-w-[66%] rounded-2xl border border-[var(--line)] bg-[var(--paper-strong)] px-4 py-3 text-base leading-relaxed text-[var(--ink)] shadow-[var(--shadow-soft)] select-text">
            {/* Images first (above text) - compact mode for 5 per row */}
            {hasAttachments && (
              <div className={hasText ? 'mb-2' : ''}>
                <AttachmentPreviewList
                  attachments={attachmentItems}
                  compact
                  onPreview={openPreview}
                />
              </div>
            )}
            {/* Text below images */}
            {hasText && (
              <div className="text-[var(--ink)]">
                <Markdown preserveNewlines>{userContent}</Markdown>
              </div>
            )}
          </article>
          <span className="mr-2 mt-1 text-[11px] text-[var(--ink-muted)] opacity-0 transition-opacity group-hover/user:opacity-100">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        {/* 右侧操作菜单 — hover 时淡入，绝对定位不占布局空间 */}
        <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full pl-1 flex flex-col items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100">
          <div className="group/copy relative">
            <button type="button"
              onClick={() => {
                navigator.clipboard.writeText(userContent).catch(() => { /* clipboard unavailable */ });
                setCopied(true);
                if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
                copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] hover:shadow-sm">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            <span className="pointer-events-none absolute right-full top-1/2 mr-1 -translate-y-1/2 whitespace-nowrap rounded-md bg-[var(--paper)] px-2 py-1 text-[11px] text-[var(--ink-muted)] shadow-md border border-[var(--line)] opacity-0 transition-opacity group-hover/copy:opacity-100">
              {copied ? '已复制' : '复制'}
            </span>
          </div>
          {!isStreaming && onRewind && (
            <div className="group/rewind relative">
              <button type="button"
                onClick={() => onRewind(message.id)}
                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] hover:shadow-sm">
                <Undo2 className="size-3.5" />
              </button>
              <span className="pointer-events-none absolute right-full top-1/2 mr-1 -translate-y-1/2 whitespace-nowrap rounded-md bg-[var(--paper)] px-2 py-1 text-[11px] text-[var(--ink-muted)] shadow-md border border-[var(--line)] opacity-0 transition-opacity group-hover/rewind:opacity-100">
                时间回溯
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Assistant message
  if (typeof message.content === 'string') {
    return (
      <div className="flex justify-start w-full px-4 py-2 select-none">
        <div className="w-full max-w-none text-[var(--ink)] select-text">
          <Markdown>{message.content}</Markdown>
        </div>
      </div>
    );
  }

  // Group consecutive thinking/tool blocks together, merge adjacent text blocks
  const groupedBlocks: (ContentBlock | ContentBlock[])[] = [];
  let currentGroup: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      // If we have a group, add it before the text block
      if (currentGroup.length > 0) {
        groupedBlocks.push([...currentGroup]);
        currentGroup = [];
      }
      // Merge consecutive text blocks into one (defensive: prevents split rendering)
      const prev = groupedBlocks[groupedBlocks.length - 1];
      if (prev && !Array.isArray(prev) && prev.type === 'text') {
        groupedBlocks[groupedBlocks.length - 1] = {
          ...prev,
          text: (prev.text || '') + '\n\n' + (block.text || '')
        };
      } else {
        groupedBlocks.push(block);
      }
    } else if (block.type === 'thinking' || block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Add to current group (server_tool_use is treated like tool_use for display)
      currentGroup.push(block);
    }
  }

  // Add any remaining group
  if (currentGroup.length > 0) {
    groupedBlocks.push(currentGroup);
  }

  // Determine which BlockGroup is the latest active section
  // Find the last BlockGroup index
  const lastBlockGroupIndex = groupedBlocks.findLastIndex((item) => Array.isArray(item));

  // Check if there are any incomplete blocks (still streaming)
  const hasIncompleteBlocks = message.content.some((block) => {
    if (block.type === 'thinking') {
      return !block.isComplete;
    }
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Tool is incomplete if it doesn't have a result yet
      // server_tool_use is treated the same as tool_use for streaming state
      const subagentRunning = block.tool?.subagentCalls?.some((call) => call.isLoading);
      return Boolean(block.tool?.isLoading) || Boolean(subagentRunning) || !block.tool?.result;
    }
    return false;
  });

  const isAssistantStreaming = isLoading && hasIncompleteBlocks;

  return (
    <div className="flex justify-start select-none">
      <article className="w-full px-3 py-2">
        <div className="space-y-3">
          {groupedBlocks.map((item, index) => {
            // Single text block
            if (!Array.isArray(item)) {
              if (item.type === 'text' && item.text) {
                return (
                  <div
                    key={index}
                    className="flex justify-start w-full px-1 py-1 select-none"
                  >
                    <div className="w-full max-w-none text-[var(--ink)] select-text">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  </div>
                );
              }
              return null;
            }

            // Group of thinking/tool blocks
            const isLatestActiveSection = index === lastBlockGroupIndex;
            const hasTextAfter =
              index < groupedBlocks.length - 1 &&
              groupedBlocks
                .slice(index + 1)
                .some((nextItem) => !Array.isArray(nextItem) && nextItem.type === 'text');

            return (
              <BlockGroup
                key={`group-${index}`}
                blocks={item}
                isLatestActiveSection={isLatestActiveSection}
                isStreaming={isAssistantStreaming}
                hasTextAfter={hasTextAfter}
              />
            );
          })}
        </div>
      </article>
    </div>
  );
}, areMessagesEqual);

export default Message;
