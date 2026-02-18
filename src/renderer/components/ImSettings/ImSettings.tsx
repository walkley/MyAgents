import React, { useState } from 'react';
import { useConfig } from '@/hooks/useConfig';
import ImBotList from './ImBotList';
import ImBotDetail from './ImBotDetail';
import ImBotWizard from './ImBotWizard';

type View =
    | { type: 'list' }
    | { type: 'detail'; botId: string }
    | { type: 'wizard' };

export default function ImSettings() {
    const { config } = useConfig();
    const [view, setView] = useState<View>({ type: 'list' });

    const botConfigs = config.imBotConfigs ?? [];

    switch (view.type) {
        case 'list':
            return (
                <ImBotList
                    configs={botConfigs}
                    onAdd={() => setView({ type: 'wizard' })}
                    onSelect={(id) => setView({ type: 'detail', botId: id })}
                />
            );
        case 'detail':
            return (
                <ImBotDetail
                    botId={view.botId}
                    onBack={() => setView({ type: 'list' })}
                />
            );
        case 'wizard':
            return (
                <ImBotWizard
                    onComplete={(id) => setView({ type: 'detail', botId: id })}
                    onCancel={() => setView({ type: 'list' })}
                />
            );
    }
}
