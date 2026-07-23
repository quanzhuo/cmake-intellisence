import { ExtensionSettings } from './cmakeEnvironment';

export const CONFIGURATION_SECTION = 'cmakeIntelliSense';

type RawExtensionSettings = {
    loggingLevel?: string;
    cmakePath?: string;
    pkgConfigPath?: string;
    cmdCaseDiagnostics?: boolean;
    workspaceIgnoreDirectories?: string[];
    excludeCMakeBuildDirectories?: boolean;
};

function normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const normalized = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(Boolean);
    return normalized.length > 0 || value.length === 0 ? normalized : undefined;
}

function asRawExtensionSettings(value: unknown): RawExtensionSettings {
    if (!value || typeof value !== 'object') {
        return {};
    }

    const record = value as Record<string, unknown>;
    return {
        loggingLevel: typeof record.loggingLevel === 'string' ? record.loggingLevel : undefined,
        cmakePath: typeof record.cmakePath === 'string' ? record.cmakePath : undefined,
        pkgConfigPath: typeof record.pkgConfigPath === 'string' ? record.pkgConfigPath : undefined,
        cmdCaseDiagnostics: typeof record.cmdCaseDiagnostics === 'boolean' ? record.cmdCaseDiagnostics : undefined,
        workspaceIgnoreDirectories: normalizeStringArray(record.workspaceIgnoreDirectories),
        excludeCMakeBuildDirectories: typeof record.excludeCMakeBuildDirectories === 'boolean'
            ? record.excludeCMakeBuildDirectories
            : undefined,
    };
}

export function resolveExtensionSettings(settingsValue: unknown, defaults: ExtensionSettings): ExtensionSettings {
    const settings = asRawExtensionSettings(settingsValue);
    return {
        cmakePath: settings.cmakePath ?? defaults.cmakePath,
        loggingLevel: settings.loggingLevel ?? defaults.loggingLevel,
        cmdCaseDiagnostics: settings.cmdCaseDiagnostics ?? defaults.cmdCaseDiagnostics,
        pkgConfigPath: settings.pkgConfigPath ?? defaults.pkgConfigPath,
        workspaceIgnoreDirectories: settings.workspaceIgnoreDirectories ?? defaults.workspaceIgnoreDirectories,
        excludeCMakeBuildDirectories: settings.excludeCMakeBuildDirectories ?? defaults.excludeCMakeBuildDirectories,
    };
}
