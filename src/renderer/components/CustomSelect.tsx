/**
 * CustomSelect - Custom dropdown select component
 * Replaces native <select> with styled dropdown matching design system
 */

import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export interface SelectOption {
    value: string;
    label: string;
    icon?: ReactNode;
}

interface CustomSelectProps {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    triggerIcon?: ReactNode;
    className?: string;
    footerAction?: {
        label: string;
        icon?: ReactNode;
        onClick: () => void;
    };
}

export default function CustomSelect({
    value,
    options,
    onChange,
    placeholder = '请选择',
    triggerIcon,
    className,
    footerAction,
}: CustomSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const selectedOption = options.find(o => o.value === value);

    const handleSelect = useCallback((optionValue: string) => {
        onChange(optionValue);
        setIsOpen(false);
    }, [onChange]);

    return (
        <div ref={containerRef} className={`relative ${className ?? ''}`}>
            {/* Trigger */}
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-left text-xs transition-colors hover:border-[var(--ink-subtle)]"
            >
                {triggerIcon && (
                    <span className="shrink-0 text-[var(--ink-muted)]">{triggerIcon}</span>
                )}
                <span className={`min-w-0 flex-1 truncate ${selectedOption ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}>
                    {selectedOption?.label ?? placeholder}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown panel */}
            {isOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md">
                    {options.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => handleSelect(option.value)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                option.value === value
                                    ? 'text-[var(--accent-warm)]'
                                    : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                            }`}
                        >
                            {option.icon && (
                                <span className="shrink-0">{option.icon}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.value === value && (
                                <Check className="h-3 w-3 shrink-0" />
                            )}
                        </button>
                    ))}

                    {/* Footer action */}
                    {footerAction && (
                        <>
                            <div className="my-1 border-t border-[var(--line)]" />
                            <button
                                type="button"
                                onClick={() => {
                                    setIsOpen(false);
                                    footerAction.onClick();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                {footerAction.icon && (
                                    <span className="shrink-0">{footerAction.icon}</span>
                                )}
                                <span>{footerAction.label}</span>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
