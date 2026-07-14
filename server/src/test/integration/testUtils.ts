import { ProtocolConnection } from 'vscode-languageserver-protocol/node';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { READY_NOTIFICATION } from '../../cmakeToolsSnapshot';

export function waitForServerReady(connection: ProtocolConnection, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            readySubscription.dispose();
            reject(new Error(`Timeout waiting for server ready notification: ${READY_NOTIFICATION}`));
        }, timeout);

        const readySubscription = connection.onNotification(READY_NOTIFICATION, () => {
            clearTimeout(timer);
            readySubscription.dispose();
            resolve();
        });
    });
}

export function createCompatibleConfigurationResponse(extSettings: ExtensionSettings): [Record<string, unknown>, Record<string, unknown>] {
    const response = {
        cmakePath: extSettings.cmakePath,
        loggingLevel: extSettings.loggingLevel,
        cmdCaseDiagnostics: extSettings.cmdCaseDiagnostics,
        pkgConfigPath: extSettings.pkgConfigPath,
        workspaceIgnoreDirectories: extSettings.workspaceIgnoreDirectories,
        excludeCMakeBuildDirectories: extSettings.excludeCMakeBuildDirectories,
    };

    return [response, response];
}
