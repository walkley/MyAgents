/**
 * BrandSection - Left panel of the Launcher page
 * Layout: Logo+Slogan pinned to upper area, input box anchored to lower area
 * with floating workspace selector above it
 */

import { useCallback } from 'react';

import SimpleChatInput, { type ImageAttachment } from '@/components/SimpleChatInput';
import WorkspaceSelector from './WorkspaceSelector';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';

interface BrandSectionProps {
    // Workspace
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelectWorkspace: (project: Project) => void;
    onAddFolder: () => void;
    // Input
    onSend: (text: string, images?: ImageAttachment[]) => void;
    isStarting?: boolean;
    // Provider/Model (pass-through to SimpleChatInput)
    provider?: Provider | null;
    providers?: Provider[];
    selectedModel?: string;
    onProviderChange?: (id: string) => void;
    onModelChange?: (id: string) => void;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    apiKeys?: Record<string, string>;
    providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
    // MCP
    workspaceMcpEnabled?: string[];
    globalMcpEnabled?: string[];
    mcpServers?: Array<{ id: string; name: string; description?: string }>;
    onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
    onRefreshProviders?: () => void;
}

export default function BrandSection({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelectWorkspace,
    onAddFolder,
    onSend,
    isStarting,
    provider,
    providers,
    selectedModel,
    onProviderChange,
    onModelChange,
    permissionMode,
    onPermissionModeChange,
    apiKeys,
    providerVerifyStatus,
    workspaceMcpEnabled,
    globalMcpEnabled,
    mcpServers,
    onWorkspaceMcpToggle,
    onRefreshProviders,
}: BrandSectionProps) {
    const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
        onSend(text, images);
        return undefined; // SimpleChatInput expects boolean | void
    }, [onSend]);

    return (
        <section className="flex flex-1 flex-col items-center px-12">
            {/* Upper area: Brand Name + Slogans */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <h1 className="brand-title mb-5 text-[2.75rem] font-light tracking-[0.04em] text-[var(--ink)] md:text-[3.5rem]">
                    MyAgents
                </h1>
                <p className="brand-slogan text-center text-[15px] font-light tracking-[0.06em] text-[var(--ink-secondary)] md:text-[17px]">
                    每个人都应享受智能的推背感，欢迎来到言出法随的世界
                </p>
            </div>

            {/* Lower area: Workspace selector (floating pill) + Input box */}
            <div className="mt-10 w-full max-w-[640px] pb-[12vh]">
                {/* Floating workspace selector — small pill above input */}
                <div className="mb-3 flex justify-start">
                    <WorkspaceSelector
                        projects={projects}
                        selectedProject={selectedProject}
                        defaultWorkspacePath={defaultWorkspacePath}
                        onSelect={onSelectWorkspace}
                        onAddFolder={onAddFolder}
                    />
                </div>

                {/* Input box */}
                <div className="relative w-full">
                    <SimpleChatInput
                        mode="launcher"
                        onSend={handleSend}
                        isLoading={!!isStarting}
                        provider={provider}
                        providers={providers}
                        selectedModel={selectedModel}
                        onProviderChange={onProviderChange}
                        onModelChange={onModelChange}
                        permissionMode={permissionMode}
                        onPermissionModeChange={onPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={workspaceMcpEnabled}
                        globalMcpEnabled={globalMcpEnabled}
                        mcpServers={mcpServers}
                        onWorkspaceMcpToggle={onWorkspaceMcpToggle}
                        onRefreshProviders={onRefreshProviders}
                    />
                </div>
            </div>
        </section>
    );
}
