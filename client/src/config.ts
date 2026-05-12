import * as vscode from 'vscode';

export const CONFIGURATION_SECTION = 'cmakeIntelliSense';
export const LEGACY_CONFIGURATION_SECTION = 'cmakeIntelliSence';

type ConfigurationInspection<T> = NonNullable<ReturnType<vscode.WorkspaceConfiguration['inspect<T>']>>;

type ExtendedConfigurationInspect<T> = ConfigurationInspection<T> & {
    globalLanguageValue?: T;
    workspaceLanguageValue?: T;
    workspaceFolderLanguageValue?: T;
};

function hasConfiguredValue<T>(inspection: ExtendedConfigurationInspect<T> | undefined): boolean {
    return inspection?.globalValue !== undefined
        || inspection?.workspaceValue !== undefined
        || inspection?.workspaceFolderValue !== undefined
        || inspection?.globalLanguageValue !== undefined
        || inspection?.workspaceLanguageValue !== undefined
        || inspection?.workspaceFolderLanguageValue !== undefined;
}

export function getCompatibleSetting<T>(key: string, defaultValue: T, scope?: vscode.ConfigurationScope): T {
    const currentConfig = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, scope);
    if (hasConfiguredValue(currentConfig.inspect<T>(key) as ExtendedConfigurationInspect<T> | undefined)) {
        return currentConfig.get<T>(key, defaultValue);
    }

    return vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION, scope).get<T>(key, defaultValue);
}

export function affectsCompatibleConfiguration(event: vscode.ConfigurationChangeEvent, key: string): boolean {
    return event.affectsConfiguration(`${CONFIGURATION_SECTION}.${key}`)
        || event.affectsConfiguration(`${LEGACY_CONFIGURATION_SECTION}.${key}`);
}