import * as path from 'path';
import { getConfigLogLevel, Logger } from './logging';
import { workspace, ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';


export const SERVER_ID = 'cmakeIntelliSence';
export const SERVER_NAME = 'CMake Language Server';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    const config = workspace.getConfiguration(SERVER_ID);
    const logger = new Logger();
    logger.setLogLevel(getConfigLogLevel(config));

    context.subscriptions.push(workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SERVER_ID}.loggingLevel`)) {
            logger.setLogLevel(getConfigLogLevel(config));
        }
    }));

    const serverModule = context.asAbsolutePath(
        path.join('dist', 'server.js')
    );

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

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'cmake', scheme: 'file' },
            { language: 'cmake', scheme: 'untitled' }
        ],
        outputChannel: logger.getOutputChannel()
    };

    
    client = new LanguageClient(SERVER_ID, SERVER_NAME, serverOptions, clientOptions);

    // start the client. This will also launch the server
    logger.info(`Start ${SERVER_NAME} ...`);
    client.start();
}


export function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
