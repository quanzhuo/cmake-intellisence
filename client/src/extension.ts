import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as which from 'which';
import localize from './localize';
import { getConfigLogLevel, Logger } from './logging';

export const SERVER_ID = 'cmakeIntelliSence';
export const SERVER_NAME = 'CMake Language Server';

let client: LanguageClient;

interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration(SERVER_ID);
    const logger = new Logger();
    context.subscriptions.push(logger.getOutputChannel());
    logger.setLogLevel(getConfigLogLevel(config));
    const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

    async function checkAndStart(cmakePath: string) {
        const cmakePathAbs: string | null = which.sync(cmakePath, { nothrow: true });
        if (cmakePathAbs) {
            startLanguageServer(serverModule, logger, context);
        } else {
            const selected = await vscode.window.showErrorMessage<string>(localize('cmakeNotFound'), localize('settings'));
            if (selected) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'cmakeIntelliSence.cmakePath');
            }
        }
    }

    checkAndStart(config.cmakePath);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration(`${SERVER_ID}.loggingLevel`)) {
            logger.setLogLevel(getConfigLogLevel(config));
        }

        if (e.affectsConfiguration(`${SERVER_ID}.cmakePath`)) {
            const cmakePath = vscode.workspace.getConfiguration(SERVER_ID).get<string>('cmakePath');
            if (!client?.isRunning()) {
                checkAndStart(cmakePath);
            }
        }
    }));
}

function startLanguageServer(serverModule: string, logger: Logger, context: vscode.ExtensionContext) {
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

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

    function getExtensionSettings(): ExtensionSettings {
        const config = vscode.workspace.getConfiguration(SERVER_ID);
        return {
            loggingLevel: config.get<string>('loggingLevel'),
            cmakePath: config.get<string>('cmakePath'),
            pkgConfigPath: config.get<string>('pkgConfigPath'),
            cmdCaseDiagnostics: config.get<boolean>('cmdCaseDiagnostics'),
        };
    }

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'cmake', scheme: 'file' },
            { language: 'cmake', scheme: 'untitled' }
        ],
        outputChannel: logger.getOutputChannel(),
        initializationOptions: {
            language: vscode.env.language,
            extensionPath: context.extensionPath,
            extSettings: getExtensionSettings(),
        }
    };

    client = new LanguageClient(SERVER_ID, SERVER_NAME, serverOptions, clientOptions);

    // start the client. This will also launch the server
    logger.info(`Start ${SERVER_NAME} ...`);
    client.start();
}


export function deactivate() {
    if (client) {
        return client.stop();
    }
}
