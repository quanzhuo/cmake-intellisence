// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as path from 'path';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    const config = vscode.workspace.getConfiguration('cmakeIntelliSence');
    let cmakels = config.get<string>('languageServerPath');
    if (cmakels === undefined) {
        cmakels = 'cmakels';
    }

    // language server options
    // default transport is TransportKind.stdio
    const serverOptions: ServerOptions = {
        command: cmakels,
        // args: [serverEntryPath]
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'cmake', scheme: 'file' },
            { language: 'cmake', scheme: 'untitled' }
        ],
        outputChannel: vscode.window.createOutputChannel('CMake IntelliSence')
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'cmakeLanguageServer',
        'CMake Language Server',
        serverOptions,
        clientOptions
    );

    // start the client. This will also launch the server
    client.start();
}

// this method is called when your extension is deactivated
export function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
