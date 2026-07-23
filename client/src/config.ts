import * as vscode from 'vscode';

export const CONFIGURATION_SECTION = 'cmakeIntelliSense';

export function getSetting<T>(key: string, defaultValue: T, scope?: vscode.ConfigurationScope): T {
    return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, scope).get<T>(key, defaultValue);
}

export function affectsConfiguration(event: vscode.ConfigurationChangeEvent, key: string): boolean {
    return event.affectsConfiguration(`${CONFIGURATION_SECTION}.${key}`);
}
