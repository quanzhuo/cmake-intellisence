import * as net from 'net';
import * as vscode from 'vscode';
import { getConfigLogLevel, Logger } from './logging';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';


export const SERVER_ID = 'cmakeIntelliSence';
export const SERVER_NAME = 'CMake Language Server';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration(SERVER_ID);
    const logger = new Logger();
    logger.setLogLevel(getConfigLogLevel(config));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SERVER_ID}.loggingLevel`)) {
            logger.setLogLevel(getConfigLogLevel(config));
        }
    }));

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'cmake', scheme: 'file' },
            { language: 'cmake', scheme: 'untitled' }
        ],
        outputChannel: logger.getOutputChannel()
    };

    // language server options
    let serverOptions: ServerOptions;
    let mode: string;
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        // Development - communicate using tcp
        serverOptions = () => {
            return new Promise((resolve) => {
                const clientSocket = new net.Socket();
                clientSocket.connect(2088, "127.0.0.1", () => {
                    resolve({
                        reader: clientSocket,
                        writer: clientSocket
                    });
                });
                clientSocket.on('connect', () => { logger.info('Connected'); });
                clientSocket.on('error', (err) => { logger.info('error', err); });
                clientSocket.on('close', () => { logger.info('connection closed'); });
            });
        };
        mode = 'Development';
    } else {
        // Production - communicate using stdio
        serverOptions = {
            command: 'cmakels'
        };
        mode = 'Production';
    }
    client = new LanguageClient(SERVER_ID, SERVER_NAME, serverOptions, clientOptions);

    // start the client. This will also launch the server
    logger.info(`Start ${SERVER_NAME} in ${mode} mode...`);
    client.start();
}


export function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
