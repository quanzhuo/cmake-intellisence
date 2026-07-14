import { ExtensionSettings } from './cmakeEnvironment';

export const CONFIGURATION_SECTION = 'cmakeIntelliSense';
export const LEGACY_CONFIGURATION_SECTION = 'cmakeIntelliSence';

type RawExtensionSettings = {
    loggingLevel?: string;
    cmakePath?: string;
    pkgConfigPath?: string;
    cmdCaseDiagnostics?: boolean;
    workspaceIgnoreDirectories?: string[];
    excludeCMakeBuildDirectories?: boolean;
    enableCMakeToolsIntegration?: boolean;
};

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
        return fallback;
    }

    const normalized = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(Boolean);

    return normalized.length > 0 || value.length === 0 ? normalized : fallback;
}

function asRawExtensionSettings(value: unknown): RawExtensionSettings {
    if (!value || typeof value !== 'object') {
        return {};
    }

    const record = value as Record<string, unknown>;
    return {
        loggingLevel: asString(record.loggingLevel),
        cmakePath: asString(record.cmakePath),
        pkgConfigPath: asString(record.pkgConfigPath),
        cmdCaseDiagnostics: asBoolean(record.cmdCaseDiagnostics),
        workspaceIgnoreDirectories: Array.isArray(record.workspaceIgnoreDirectories)
            ? normalizeStringArray(record.workspaceIgnoreDirectories, [])
            : undefined,
        excludeCMakeBuildDirectories: asBoolean(record.excludeCMakeBuildDirectories),
    };
}

function haveSameStringEntries(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((entry, index) => entry === right[index]);
}

function hasNonDefaultStringValue(value: string | undefined, defaultValue: string): boolean {
    return value !== undefined && value !== defaultValue;
}

function hasNonDefaultBooleanValue(value: boolean | undefined, defaultValue: boolean): boolean {
    return value !== undefined && value !== defaultValue;
}

function hasNonDefaultStringArrayValue(value: string[] | undefined, defaultValue: string[]): boolean {
    return value !== undefined && !haveSameStringEntries(value, defaultValue);
}

function resolveStringSetting(currentValue: string | undefined, legacyValue: string | undefined, defaultValue: string): string {
    if (currentValue === undefined) {
        return legacyValue ?? defaultValue;
    }

    if (hasNonDefaultStringValue(currentValue, defaultValue) || !hasNonDefaultStringValue(legacyValue, defaultValue)) {
        return currentValue;
    }

    return legacyValue ?? currentValue;
}

function resolveBooleanSetting(currentValue: boolean | undefined, legacyValue: boolean | undefined, defaultValue: boolean): boolean {
    if (currentValue === undefined) {
        return legacyValue ?? defaultValue;
    }

    if (hasNonDefaultBooleanValue(currentValue, defaultValue) || !hasNonDefaultBooleanValue(legacyValue, defaultValue)) {
        return currentValue;
    }

    return legacyValue ?? currentValue;
}

function resolveStringArraySetting(currentValue: string[] | undefined, legacyValue: string[] | undefined, defaultValue: string[]): string[] {
    if (currentValue === undefined) {
        return legacyValue ?? defaultValue;
    }

    if (hasNonDefaultStringArrayValue(currentValue, defaultValue) || !hasNonDefaultStringArrayValue(legacyValue, defaultValue)) {
        return currentValue;
    }

    return legacyValue ?? currentValue;
}

export function resolveExtensionSettings(currentSettingsValue: unknown, legacySettingsValue: unknown, defaults: ExtensionSettings): ExtensionSettings {
    const currentSettings = asRawExtensionSettings(currentSettingsValue);
    const legacySettings = asRawExtensionSettings(legacySettingsValue);
    const defaultWorkspaceIgnoreDirectories = defaults.workspaceIgnoreDirectories ?? [];

    return {
        cmakePath: resolveStringSetting(currentSettings.cmakePath, legacySettings.cmakePath, defaults.cmakePath),
        loggingLevel: resolveStringSetting(currentSettings.loggingLevel, legacySettings.loggingLevel, defaults.loggingLevel),
        cmdCaseDiagnostics: resolveBooleanSetting(currentSettings.cmdCaseDiagnostics, legacySettings.cmdCaseDiagnostics, defaults.cmdCaseDiagnostics),
        pkgConfigPath: resolveStringSetting(currentSettings.pkgConfigPath, legacySettings.pkgConfigPath, defaults.pkgConfigPath),
        workspaceIgnoreDirectories: resolveStringArraySetting(
            currentSettings.workspaceIgnoreDirectories,
            legacySettings.workspaceIgnoreDirectories,
            defaultWorkspaceIgnoreDirectories,
        ),
        excludeCMakeBuildDirectories: resolveBooleanSetting(
            currentSettings.excludeCMakeBuildDirectories,
            legacySettings.excludeCMakeBuildDirectories,
            defaults.excludeCMakeBuildDirectories ?? true,
        ),
        enableCMakeToolsIntegration: resolveBooleanSetting(currentSettings.enableCMakeToolsIntegration, legacySettings.enableCMakeToolsIntegration, defaults.enableCMakeToolsIntegration),
    };
}
