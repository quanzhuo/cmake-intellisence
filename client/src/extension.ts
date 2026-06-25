import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Trace, TransportKind } from 'vscode-languageclient/node';
import { CMakeToolsSnapshotBridge } from './cmakeToolsBridge';
import * as which from 'which';
import { affectsCompatibleConfiguration, CONFIGURATION_SECTION, getCompatibleSetting } from './config';
import { getConfigLogLevel, Logger } from './logging';

export const SERVER_ID = CONFIGURATION_SECTION;
export const SERVER_NAME = 'CMake Language Server';

let client: LanguageClient | undefined;
let cmakeToolsSnapshotBridge: CMakeToolsSnapshotBridge | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const channel = vscode.window.createOutputChannel('CMake IntelliSense');
    context.subscriptions.push(channel);

    const logger = new Logger(channel);
    logger.setLogLevel(getConfigLogLevel());

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (affectsCompatibleConfiguration(e, 'loggingLevel')) {
            logger.setLogLevel(getConfigLogLevel());
        }

        if (affectsCompatibleConfiguration(e, 'trace.server')) {
            await applyTraceConfiguration();
        }

        if (affectsCompatibleConfiguration(e, 'cmakePath')) {
            cmakeToolsSnapshotBridge?.dispose();
            cmakeToolsSnapshotBridge = undefined;
            if (client && client.isRunning()) {
                await client.stop();
            }
            const newCmakePath = await getCMakePath();
            await checkAndStart(newCmakePath);
        }

        if (affectsCompatibleConfiguration(e, 'enableCMakeToolsIntegration')) {
            const enabled = getCompatibleSetting('enableCMakeToolsIntegration', true);
            if (enabled && !cmakeToolsSnapshotBridge && client) {
                cmakeToolsSnapshotBridge = new CMakeToolsSnapshotBridge(client, logger);
                logger.info('CMake Tools integration enabled');
            } else if (!enabled && cmakeToolsSnapshotBridge) {
                cmakeToolsSnapshotBridge.dispose();
                cmakeToolsSnapshotBridge = undefined;
                logger.info('CMake Tools integration disabled');
            }
        }
    }));

    await checkAndStart(await getCMakePath());

    async function checkAndStart(cmakePath: string | null) {
        if (cmakePath) {
            const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
            await startLanguageServer(cmakePath, serverModule, channel, logger);
        } else {
            const selected = await vscode.window.showErrorMessage<string>(vscode.l10n.t('cmakeNotFound'), vscode.l10n.t('settings'));
            if (selected) {
                vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIGURATION_SECTION}.cmakePath`);
            }
        }
    }
}

async function getCMakePath(): Promise<string | null> {
    let cmakePath: string | null = getCompatibleSetting('cmakePath', 'cmake');
    cmakePath = await which(cmakePath, { nothrow: true });
    if (cmakePath) {
        return cmakePath;
    }
    return null;
}

async function startLanguageServer(cmakePath: string, serverModule: string, channel: vscode.OutputChannel, logger: Logger) {
    // The debug options for the server
    // --inspect-brk=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
    // 该参数会让 Node.js 在执行 Server 入口文件（即你的 server.js）的第一行代码前挂起，直到有外部调试器（VS Code）连接进来才会继续执行。
    const debugOptions = { execArgv: ['--nolazy', '--inspect-brk=6009'] };

    // If the extension is lanched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'cmake', scheme: 'file' },
            { language: 'cmake', scheme: 'untitled' }
        ],
        outputChannel: channel
    };

    client = new LanguageClient(SERVER_ID, SERVER_NAME, serverOptions, clientOptions);
    cmakeToolsSnapshotBridge?.dispose();
    cmakeToolsSnapshotBridge = undefined;
    if (getCompatibleSetting('enableCMakeToolsIntegration', true)) {
        cmakeToolsSnapshotBridge = new CMakeToolsSnapshotBridge(client, logger);
    } else {
        logger.info('CMake Tools integration is disabled by configuration');
    }

    // start the client. This will also launch the server
    logger.info(`Start ${SERVER_NAME} ...`);
    await client.start();
    await applyTraceConfiguration();
}

async function applyTraceConfiguration(): Promise<void> {
    if (!client) {
        return;
    }

    await client.setTrace(Trace.fromString(getCompatibleSetting('trace.server', 'off')));
}


export function deactivate() {
    cmakeToolsSnapshotBridge?.dispose();
    cmakeToolsSnapshotBridge = undefined;
    if (client) {
        return client.stop();
    }
}
