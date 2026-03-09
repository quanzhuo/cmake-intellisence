import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as which from 'which';
import { getConfigLogLevel, Logger } from './logging';

export const SERVER_ID = 'cmakeIntelliSence';
export const SERVER_NAME = 'CMake Language Server';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const channel = vscode.window.createOutputChannel('CMake IntelliSence');
    context.subscriptions.push(channel);

    const logger = new Logger(channel);
    logger.setLogLevel(getConfigLogLevel(vscode.workspace.getConfiguration(SERVER_ID)));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration(`${SERVER_ID}.loggingLevel`)) {
            logger.setLogLevel(getConfigLogLevel(vscode.workspace.getConfiguration(SERVER_ID)));
        }

        if (e.affectsConfiguration(`${SERVER_ID}.cmakePath`)) {
            if (client && client.isRunning()) {
                await client.stop();
            }
            const newCmakePath = await getCMakePath();
            await checkAndStart(newCmakePath);
        }
    }));

    await checkAndStart(await getCMakePath());

    async function checkAndStart(cmakePath: string | null) {
        if (cmakePath) {
            const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
            startLanguageServer(cmakePath, serverModule, channel, logger);
        } else {
            const selected = await vscode.window.showErrorMessage<string>(vscode.l10n.t('cmakeNotFound'), vscode.l10n.t('settings'));
            if (selected) {
                vscode.commands.executeCommand('workbench.action.openSettings', `${SERVER_ID}.cmakePath`);
            }
        }
    }
}

async function getCMakePath(): Promise<string | null> {
    let cmakePath: string | null = vscode.workspace.getConfiguration(SERVER_ID).get<string>('cmakePath', 'cmake');
    cmakePath = await which(cmakePath, { nothrow: true });
    if (cmakePath) {
        return cmakePath;
    }
    return null;
}

function startLanguageServer(cmakePath: string, serverModule: string, channel: vscode.OutputChannel, logger: Logger) {
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

    // start the client. This will also launch the server
    logger.info(`Start ${SERVER_NAME} ...`);
    client.start();
}


export function deactivate() {
    if (client) {
        return client.stop();
    }
}
