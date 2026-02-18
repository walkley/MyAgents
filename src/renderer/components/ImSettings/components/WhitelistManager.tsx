import React, { useCallback, useState } from 'react';
import { Plus, X } from 'lucide-react';

export default function WhitelistManager({
    users,
    onChange,
}: {
    users: string[];
    onChange: (users: string[]) => void;
}) {
    const [newUser, setNewUser] = useState('');

    const handleAdd = useCallback(() => {
        const trimmed = newUser.trim();
        if (!trimmed) return;
        if (users.includes(trimmed)) {
            setNewUser('');
            return;
        }
        onChange([...users, trimmed]);
        setNewUser('');
    }, [newUser, users, onChange]);

    const handleRemove = useCallback((user: string) => {
        onChange(users.filter(u => u !== user));
    }, [users, onChange]);

    return (
        <div className="space-y-3">
            <label className="text-sm font-medium text-[var(--ink)]">手动添加用户白名单</label>
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={newUser}
                    onChange={(e) => setNewUser(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    placeholder="Telegram 用户名或 User ID"
                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--ink)] focus:outline-none"
                />
                <button
                    onClick={handleAdd}
                    disabled={!newUser.trim()}
                    className="rounded-lg bg-[var(--button-primary-bg)] p-2 text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                >
                    <Plus className="h-4 w-4" />
                </button>
            </div>

            {users.length > 0 ? (
                <div className="flex flex-wrap gap-2 pt-1">
                    {users.map((user) => (
                        <span
                            key={user}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--paper-contrast)] px-2.5 py-1 text-xs text-[var(--ink)]"
                        >
                            {user}
                            <button
                                onClick={() => handleRemove(user)}
                                className="rounded-full p-0.5 text-[var(--ink-muted)] hover:text-[var(--error)]"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <p className="text-xs text-[var(--ink-muted)]">
                    未添加白名单用户。启动 Bot 后可通过二维码快速绑定，或手动添加用户名 / User ID。
                </p>
            )}
        </div>
    );
}
