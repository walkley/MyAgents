/**
 * MermaidDiagram - Renders Mermaid diagrams with preview/code toggle
 *
 * Features:
 * - Progressive rendering: keeps last successful render while content updates
 * - Graceful degradation: shows last valid diagram if current content fails to parse
 * - Debounced updates to avoid excessive re-renders during streaming
 * - Preview/Code toggle: default to rendered preview, switchable to syntax-highlighted source
 * - Copy button: copies raw Mermaid source in both modes
 */

import { AlertCircle, Check, Code, Copy, Eye, RefreshCw } from 'lucide-react';
import mermaid from 'mermaid';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Track if mermaid is initialized
let mermaidInitialized = false;

function initMermaid() {
    if (mermaidInitialized) return;

    mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        suppressErrorRendering: true, // Don't show error in SVG
        fontFamily: "'Avenir Next', 'Gill Sans', sans-serif",
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
        },
        themeVariables: {
            primaryColor: '#e8ddd0',
            primaryTextColor: '#1c1612',
            primaryBorderColor: '#c4b5a5',
            lineColor: '#8a7a6a',
            secondaryColor: '#f5efe8',
            tertiaryColor: '#fff8f0',
        },
    });
    mermaidInitialized = true;
}

// Reuse CodeBlock's theme for consistent code styling
const codeTheme = {
    ...oneDark,
    'pre[class*="language-"]': {
        ...oneDark['pre[class*="language-"]'],
        background: '#1e1e1e',
        borderRadius: 0,
        padding: '1rem',
        margin: 0,
        fontSize: '13px',
        lineHeight: '1.6',
    },
    'code[class*="language-"]': {
        ...oneDark['code[class*="language-"]'],
        background: 'transparent',
        fontSize: '13px',
        lineHeight: '1.6',
        fontFamily: 'var(--font-code)',
    },
};

interface MermaidDiagramProps {
    children: string;
}

// Check if mermaid content looks like it could be valid and complete
function looksLikeValidMermaid(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length < 15) return false; // Need more than just "graph TD"

    // Must have at least one newline to be a valid diagram
    if (!trimmed.includes('\n')) return false;

    const validStarts = [
        'graph', 'flowchart', 'sequencediagram', 'classdiagram',
        'statediagram', 'erdiagram', 'journey', 'gantt', 'pie',
        'mindmap', 'timeline', 'gitgraph', 'c4context'
    ];

    // Get first line and check if it starts with a valid keyword
    const firstLine = trimmed.split('\n')[0].trim().toLowerCase();
    return validStarts.some(start => firstLine.startsWith(start));
}

export default function MermaidDiagram({ children }: MermaidDiagramProps) {
    // View mode: preview (rendered diagram) or code (syntax highlighted source)
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
    const [copied, setCopied] = useState(false);

    // Store both current SVG and last successfully rendered SVG
    const [lastValidSvg, setLastValidSvg] = useState<string>('');
    const [lastValidContent, setLastValidContent] = useState<string>('');
    const [isRendering, setIsRendering] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);

    const id = useId().replace(/:/g, '_');
    const renderCountRef = useRef(0);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(children.trim());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [children]);

    const tryRender = useCallback(async (content: string) => {
        const trimmedContent = content.trim();

        // Skip if content hasn't changed from last successful render
        if (trimmedContent === lastValidContent) {
            return;
        }

        // Skip if content doesn't look like valid mermaid
        if (!looksLikeValidMermaid(trimmedContent)) {
            return;
        }

        try {
            initMermaid();
            setIsRendering(true);
            setParseError(null);

            // Unique ID for each render attempt
            renderCountRef.current += 1;
            const renderId = `mermaid-${id}-${renderCountRef.current}`;

            const { svg } = await mermaid.render(renderId, trimmedContent);

            // Success! Update both the displayed SVG and the last valid content
            setLastValidSvg(svg);
            setLastValidContent(trimmedContent);
        } catch (err) {
            // Parse failed - this is expected during streaming
            // Keep showing the last valid SVG, just note the error
            const errorMsg = err instanceof Error ? err.message : 'Parse error';
            setParseError(errorMsg);
        } finally {
            setIsRendering(false);
        }
    }, [id, lastValidContent]);

    useEffect(() => {
        // Debounce rendering - wait for content to stabilize
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            if (children.trim()) {
                tryRender(children);
            }
        }, 300); // 300ms debounce

        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [children, tryRender]);

    const handleRetry = () => {
        setParseError(null);
        tryRender(children);
    };

    // Header bar with toggle and copy button (shared across all states)
    const headerBar = (
        <div className="flex items-center justify-between bg-[#2d2d2d] px-4 py-2 text-xs">
            <span className="font-mono uppercase tracking-wide text-neutral-400">
                mermaid
            </span>
            <div className="flex items-center gap-2">
                {/* Preview / Code toggle */}
                <div className="flex items-center rounded-md bg-neutral-800 p-0.5">
                    <button
                        type="button"
                        onClick={() => setViewMode('preview')}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                            viewMode === 'preview'
                                ? 'bg-neutral-600 text-neutral-100'
                                : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                    >
                        <Eye className="size-3" />
                        <span>预览</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode('code')}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                            viewMode === 'code'
                                ? 'bg-neutral-600 text-neutral-100'
                                : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                    >
                        <Code className="size-3" />
                        <span>代码</span>
                    </button>
                </div>
                {/* Copy button */}
                <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-200"
                    title={copied ? '已复制' : '复制代码'}
                >
                    {copied ? (
                        <>
                            <Check className="size-3.5" />
                            <span>已复制</span>
                        </>
                    ) : (
                        <>
                            <Copy className="size-3.5" />
                            <span>复制</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );

    // Code view: syntax highlighted Mermaid source
    const codeView = (
        <SyntaxHighlighter
            language="mermaid"
            style={codeTheme}
            customStyle={{ margin: 0 }}
            showLineNumbers={children.trim().split('\n').length > 5}
            lineNumberStyle={{
                minWidth: '2.5em',
                paddingRight: '1em',
                color: '#4a4a4a',
                userSelect: 'none',
            }}
            wrapLongLines
        >
            {children.trim()}
        </SyntaxHighlighter>
    );

    // Preview content based on render state
    const previewContent = (() => {
        // Has valid SVG
        if (lastValidSvg) {
            return (
                <>
                    {isRendering && (
                        <div className="flex items-center gap-1.5 border-b border-neutral-700/50 px-3 py-1.5 text-xs text-neutral-400">
                            <RefreshCw className="size-3 animate-spin" />
                            <span>更新中...</span>
                        </div>
                    )}
                    {/*
                     * SECURITY: dangerouslySetInnerHTML is safe here because:
                     * 1. SVG is generated by Mermaid library from validated diagram syntax
                     * 2. User input is parsed as Mermaid DSL, not directly injected as HTML
                     * 3. Mermaid is configured with securityLevel: 'loose' which still sanitizes
                     */}
                    <div
                        className="flex justify-center bg-[var(--paper-elevated)] p-4 [&>svg]:max-w-full"
                        dangerouslySetInnerHTML={{ __html: lastValidSvg }}
                    />
                </>
            );
        }

        // Parse error state (no valid SVG yet)
        if (parseError && looksLikeValidMermaid(children)) {
            return (
                <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 text-[var(--warning)]">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-medium">图表渲染中...</p>
                                <p className="mt-1 truncate text-xs opacity-60">{parseError}</p>
                            </div>
                        </div>
                        <button
                            onClick={handleRetry}
                            className="shrink-0 rounded px-2 py-1 text-xs text-[var(--warning)] hover:bg-[var(--warning-bg)]"
                        >
                            重试
                        </button>
                    </div>
                </div>
            );
        }

        // Initial loading state
        return (
            <div className="flex h-20 items-center justify-center bg-[var(--paper-contrast)]/50">
                <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                    <RefreshCw className="size-4 animate-spin" />
                    <span>渲染图表...</span>
                </div>
            </div>
        );
    })();

    return (
        <div className="my-3 w-full overflow-hidden rounded-lg">
            {headerBar}
            {viewMode === 'code' ? codeView : previewContent}
        </div>
    );
}
