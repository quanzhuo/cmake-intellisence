import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    HoverParams,
    SignatureHelpParams

} from 'vscode-languageserver/node';

import { TextDocument, Range } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver-types';

import * as builtinCmds from './builtin-cmds.json';
import { Entries, getBuiltinEntries } from './utils';
import { exec } from 'child_process';

const entries: Entries = getBuiltinEntries();
const modules = entries[0].split('\n');
const policies = entries[1].split('\n');
const variables = entries[2].split('\n');
const properties = entries[3].split('\n');;

// Craete a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['('],
                retriggerCharacters: [' ']
            }
        },
        serverInfo: {
            name: 'cmakels',
            version: '0.1'
        }
    };

    return result;
});

connection.onInitialized(() => {
    console.log("Initialized");
});

connection.onHover((params: HoverParams) => {
    const document: TextDocument = documents.get(params.textDocument.uri);
    const word = getWordAtPosition(document, params.position);
    if (word.length === 0) {
        return undefined;
    }

    // check if the word is a builtin commands
    if (word in builtinCmds) {
        const sigs = '```cmdsignature\n'
            + builtinCmds[word]['sig'].join('\n')
            + '\n```';
        const cmdHelp: string = builtinCmds[word]['doc'] + '\n' + sigs;
        return {
            contents: {
                kind: 'markdown',
                value: cmdHelp
            }
        };
    }

    let moduleArg = '';

    if (modules.includes(word)) {
        const line = document.getText({
            start: { line: params.position.line, character: 0 },
            end: { line: params.position.line, character: Number.MAX_VALUE }
        });
        if (line.trim().startsWith('include')) {
            moduleArg = '--help-module ';
        }
    } else if (policies.includes(word)) {
        moduleArg = '--help-policy ';
    } else if (variables.includes(word)) {
        moduleArg = '--help-variable ';
    } else if (properties.includes(word)) {
        moduleArg = '--help-property ';
    }

    if (moduleArg.length !== 0) {
        const command = 'cmake ' + moduleArg + word;
        return new Promise((resolve, rejects) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    rejects(error);
                }
                resolve({
                    contents: {
                        kind: 'plaintext',
                        value: stdout
                    }
                });
            });
        });
    }
});

connection.onSignatureHelp((params: SignatureHelpParams) => {
    return null;
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    console.log('content changed');
});

function getWordAtPosition(textDocument: TextDocument, position: Position): string {
    const lineRange: Range = {
        start: { line: position.line, character: 0 },
        end: { line: position.line, character: Number.MAX_VALUE }
    };
    const line = textDocument.getText(lineRange),
        start = line.substring(0, position.character),
        end = line.substring(position.character);
    // TODO: the regex expression capture numbers, fix it.
    const startReg = /[a-zA-Z0-9_]*$/,
        endReg = /^[a-zA-Z0-9_]*/;
    
    const startWord = start.match(startReg)[0],
        endWord = end.match(endReg)[0];
    return startWord + endWord;
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
