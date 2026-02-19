// React hook for managing app configuration
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
    addProject as addProjectService,
    loadAppConfig,
    loadProjects,
    removeProject as removeProjectService,
    atomicModifyConfig,
    updateProject as updateProjectService,
    patchProject as patchProjectService,
    touchProject as touchProjectService,
    getAllProviders,
    loadApiKeys as loadApiKeysService,
    saveApiKey as saveApiKeyService,
    deleteApiKey as deleteApiKeyService,
    loadProviderVerifyStatus as loadProviderVerifyStatusService,
    saveProviderVerifyStatus as saveProviderVerifyStatusService,
    saveCustomProvider as saveCustomProviderService,
    deleteCustomProvider as deleteCustomProviderService,
    ensureBundledWorkspace,
} from '@/config/configService';
import { CUSTOM_EVENTS } from '../../shared/constants';
import {
    type AppConfig,
    DEFAULT_CONFIG,
    type ModelEntity,
    type Project,
    type Provider,
    type ProviderVerifyStatus,
    PRESET_PROVIDERS,
} from '@/config/types';

interface UseConfigResult {
    // Config state
    config: AppConfig;
    isLoading: boolean;
    error: string | null;

    // Projects
    projects: Project[];
    addProject: (path: string) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    /** Partially update a project — only merges specified fields, safe against stale React state */
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;

    // Providers (preset providers have custom models merged)
    providers: Provider[];
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;

    // Preset provider custom models (user-added models for preset providers)
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;

    // API Keys
    apiKeys: Record<string, string>;
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;

    // Provider verify status (persisted)
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    saveProviderVerifyStatus: (providerId: string, status: 'valid' | 'invalid', accountEmail?: string) => Promise<void>;

    // Config updates
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;

    /** Lightweight config-only refresh from disk (no loading state, no projects/providers reload) */
    refreshConfig: () => Promise<void>;

    // Reload all data
    reload: () => Promise<void>;

    // Refresh only provider-related data (apiKeys and verifyStatus) - lightweight, no loading state
    refreshProviderData: () => Promise<void>;
}

// Helper: Merge preset custom models into providers
function mergePresetCustomModels(
    providers: Provider[],
    presetCustomModels: Record<string, ModelEntity[]> | undefined
): Provider[] {
    if (!presetCustomModels || Object.keys(presetCustomModels).length === 0) {
        return providers;
    }
    return providers.map(provider => {
        if (!provider.isBuiltin) return provider;
        const customModels = presetCustomModels[provider.id];
        if (!customModels || customModels.length === 0) return provider;
        // Merge: preset models first, then user custom models
        return {
            ...provider,
            models: [...provider.models, ...customModels],
        };
    });
}

export function useConfig(): UseConfigResult {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [projects, setProjects] = useState<Project[]>([]);
    const [rawProviders, setRawProviders] = useState<Provider[]>(PRESET_PROVIDERS);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [providerVerifyStatus, setProviderVerifyStatus] = useState<Record<string, ProviderVerifyStatus>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Merge preset custom models into providers for consumers (memoized to avoid unnecessary recalculations)
    const providers = useMemo(
        () => mergePresetCustomModels(rawProviders, config.presetCustomModels),
        [rawProviders, config.presetCustomModels]
    );

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Ensure bundled workspace (mino) is registered before loading projects.
            // Runs once per session; eliminates race between mino init and loadProjects.
            await ensureBundledWorkspace();

            const [loadedConfig, loadedProjects, loadedProviders, loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadAppConfig(),
                loadProjects(),
                getAllProviders(),
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);

            setConfig(loadedConfig);
            setProjects(loadedProjects);
            setRawProviders(loadedProviders);
            setApiKeys(loadedApiKeys);
            setProviderVerifyStatus(loadedVerifyStatus);
        } catch (err) {
            console.error('Failed to load config:', err);
            setError(err instanceof Error ? err.message : 'Failed to load configuration');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
        // Atomic read-modify-write: read + merge + write all happen inside the config lock,
        // preventing races with other atomic config operations (e.g., updateImBotConfig).
        const newConfig = await atomicModifyConfig(config => ({ ...config, ...updates }));
        setConfig(newConfig);
        // Notify other components (e.g., App.tsx) that config has changed
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event(CUSTOM_EVENTS.CONFIG_CHANGED));
        }
    }, []);

    const addProject = useCallback(async (path: string) => {
        const project = await addProjectService(path);
        // Always move added/touched project to the front (most recently opened)
        setProjects((prev) => {
            const filtered = prev.filter((p) => p.id !== project.id);
            return [project, ...filtered];
        });
        return project;
    }, []);

    const updateProject = useCallback(async (project: Project) => {
        await updateProjectService(project);
        setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
    }, []);

    const patchProject = useCallback(async (projectId: string, updates: Partial<Omit<Project, 'id'>>) => {
        const updated = await patchProjectService(projectId, updates);
        if (updated) {
            setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
        }
    }, []);

    const removeProject = useCallback(async (projectId: string) => {
        await removeProjectService(projectId);
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
    }, []);

    const touchProject = useCallback(async (projectId: string) => {
        const updated = await touchProjectService(projectId);
        if (updated) {
            // Move the touched project to the front of the list
            setProjects((prev) => {
                const filtered = prev.filter((p) => p.id !== projectId);
                return [updated, ...filtered];
            });
        }
    }, []);

    const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
        await saveApiKeyService(providerId, apiKey);
        setApiKeys((prev) => ({ ...prev, [providerId]: apiKey }));
    }, []);

    const deleteApiKey = useCallback(async (providerId: string) => {
        await deleteApiKeyService(providerId);
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        // Also clear verification status
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
    }, []);

    const saveProviderVerifyStatus = useCallback(async (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string
    ) => {
        await saveProviderVerifyStatusService(providerId, status, accountEmail);
        setProviderVerifyStatus((prev) => ({
            ...prev,
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
            },
        }));
    }, []);

    // Lightweight config-only refresh from disk (no loading state, no projects/providers reload)
    const refreshConfig = useCallback(async () => {
        try {
            const latest = await loadAppConfig();
            setConfig(latest);
        } catch (err) {
            console.error('[useConfig] Failed to refresh config:', err);
        }
    }, []);

    // Lightweight refresh for provider data only (no loading state change)
    const refreshProviderData = useCallback(async () => {
        try {
            const [loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);
            setApiKeys(loadedApiKeys);
            setProviderVerifyStatus(loadedVerifyStatus);
        } catch (err) {
            console.error('[useConfig] Failed to refresh provider data:', err);
        }
    }, []);

    // Refresh providers list (after adding/deleting custom providers)
    const refreshProviders = useCallback(async () => {
        try {
            const loadedProviders = await getAllProviders();
            setRawProviders(loadedProviders);
        } catch (err) {
            console.error('[useConfig] Failed to refresh providers:', err);
        }
    }, []);

    // Add a custom provider
    const addCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        // Refresh providers list to include the new one
        await refreshProviders();
    }, [refreshProviders]);

    // Update an existing custom provider
    const updateCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        // Refresh providers list to reflect the update
        await refreshProviders();
    }, [refreshProviders]);

    // Delete a custom provider
    const deleteCustomProvider = useCallback(async (providerId: string) => {
        await deleteCustomProviderService(providerId);
        // deleteApiKeyService also clears verification status from disk
        await deleteApiKeyService(providerId);
        // Refresh providers list to remove the deleted one
        await refreshProviders();
        // Sync local state (deleteApiKeyService already persisted the change)
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
    }, [refreshProviders]);

    // Save custom models for a preset provider
    const savePresetCustomModels = useCallback(async (providerId: string, models: ModelEntity[]) => {
        const newConfig = await atomicModifyConfig(config => {
            const newPresetCustomModels = {
                ...config.presetCustomModels,
                [providerId]: models,
            };
            if (models.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...config, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
    }, []);

    // Remove a single custom model from a preset provider
    const removePresetCustomModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(config => {
            const currentModels = config.presetCustomModels?.[providerId] ?? [];
            const newModels = currentModels.filter(m => m.model !== modelId);
            const newPresetCustomModels = { ...config.presetCustomModels, [providerId]: newModels };
            if (newModels.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...config, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
    }, []);

    return {
        config,
        isLoading,
        error,
        projects,
        addProject,
        updateProject,
        patchProject,
        removeProject,
        touchProject,
        providers,
        addCustomProvider,
        updateCustomProvider,
        deleteCustomProvider,
        refreshProviders,
        savePresetCustomModels,
        removePresetCustomModel,
        apiKeys,
        saveApiKey,
        deleteApiKey,
        providerVerifyStatus,
        saveProviderVerifyStatus,
        updateConfig,
        refreshConfig,
        reload: load,
        refreshProviderData,
    };
}
