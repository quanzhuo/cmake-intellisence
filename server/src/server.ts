import {
    createConnection, HoverParams, InitializeParams, InitializeResult,
    ProposedFeatures, SignatureHelpParams, TextDocuments, TextDocumentSyncKind,
    _RemoteWindow
} from 'vscode-languageserver/node';

import {
    CompletionItemKind, CompletionParams, DocumentFormattingParams,
    DocumentSymbolParams, SignatureHelpTriggerKind, DefinitionParams,
    WorkspaceFolder
} from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItem, CompletionItemTag, Position
} from 'vscode-languageserver-types';

import { exec } from 'child_process';
import * as builtinCmds from './builtin-cmds.json';
import { FormatListener } from './format';
import antlr4 from './parser/antlr4/index.js';
import CMakeLexer from './parser/CMakeLexer.js';
import CMakeParser from './parser/CMakeParser.js';
import { SymbolListener } from './docSymbols';
import { Entries, getBuiltinEntries, getCMakeVersion, getFileContext } from './utils';
import { DefinationListener, incToBaseDir, refToDef, topScope } from './symbolTable/goToDefination';
import { existsSync } from 'fs';
import { URI, Utils } from 'vscode-uri';
import path = require('path');

type Word = {
    text: string,
    line: number,
    col: number
};

const entries: Entries = getBuiltinEntries();
const modules = entries[0].split('\n');
const policies = entries[1].split('\n');
const variables = entries[2].split('\n');
const properties = entries[3].split('\n');

let workspaceFolders: WorkspaceFolder[] | null;
let contentChanged = true;

// Craete a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
    workspaceFolders = params.workspaceFolders;
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(']
            },
            completionProvider: {},
            documentFormattingProvider: true,
            documentSymbolProvider: true,
            definitionProvider: true
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
    const word = getWordAtPosition(document, params.position).text;
    if (word.length === 0) {
        return null;
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

connection.onCompletion(async (params: CompletionParams) => {
    const document = documents.get(params.textDocument.uri);
    const word = getWordAtPosition(document, params.position).text;
    if (word.length === 0) {
        return null;
    }

    const results = await Promise.all([
        getCommandProposals(word),
        getProposals(word, CompletionItemKind.Module, modules),
        getProposals(word, CompletionItemKind.Constant, policies),
        getProposals(word, CompletionItemKind.Variable, variables),
        getProposals(word, CompletionItemKind.Property, properties)
    ]);
    return results.flat();
});

connection.onSignatureHelp((params: SignatureHelpParams) => {
    return new Promise((resolve, reject) => {
        const document = documents.get(params.textDocument.uri);
        if (params.context.triggerKind === SignatureHelpTriggerKind.TriggerCharacter) {
            if (params.context.triggerCharacter === "(") {
                const posBeforeLParen: Position = {
                    line: params.position.line,
                    character: params.position.character - 1
                };

                const word: string = getWordAtPosition(document, posBeforeLParen).text;
                if (word.length === 0 || !(word in builtinCmds)) {
                    return null;
                }

                const sigsStrArr: string[] = builtinCmds[word]['sig'];
                const signatures = sigsStrArr.map((value, index, arr) => {
                    return {
                        label: value
                    };
                });

                resolve({
                    signatures: signatures,
                    activeSignature: 0,
                    activeParameter: 0
                });
            }
        } else if (params.context.triggerKind === SignatureHelpTriggerKind.ContentChange) {
            const word: string = getWordAtPosition(document, params.position).text;
            if (word.length === 0) {
                return null;
            }
            const firstSig: string = params.context.activeSignatureHelp?.signatures[0].label;
            const leftParenIndex = firstSig.indexOf('(');
            const command = firstSig.slice(0, leftParenIndex);
            if (!command) {
                return null;
            }
            const sigsStrArr: string[] = builtinCmds[command]['sig'];
            const signatures = sigsStrArr.map((value, index, arr) => {
                return {
                    label: value
                };
            });

            const activeSignature: number = (() => {
                let i = 0;
                for (let j = 0; j < signatures.length; ++j) {
                    if (signatures[j].label.includes(word)) {
                        i = j;
                        break;
                    }
                }
                return i;
            })();

            resolve({
                signatures: signatures,
                activeSignature: activeSignature,
                activeParameter: 0
            });
        }
    });
});

connection.onDocumentFormatting((params: DocumentFormattingParams) => {
    const tabSize = params.options.tabSize;
    const document = documents.get(params.textDocument.uri);
    const range: Range = {
        start: { line: 0, character: 0 },
        end: { line: document.lineCount - 1, character: Number.MAX_VALUE }
    };

    return new Promise((resolve, rejects) => {
        const input = antlr4.CharStreams.fromString(document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new antlr4.CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        const tree = parser.file();
        const formatListener = new FormatListener(tabSize, tokenStream);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(formatListener, tree);
        resolve([
            {
                range: range,
                newText: formatListener.getFormatedText()
            }
        ]);
    });
});

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
    const document = documents.get(params.textDocument.uri);
    return new Promise((resolve, reject) => {
        const input = antlr4.CharStreams.fromString(document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new antlr4.CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        const tree = parser.file();
        const symbolListener = new SymbolListener();
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(symbolListener, tree);
        resolve(symbolListener.getSymbols());
    });
});

connection.onDefinition((params: DefinitionParams) => {
    if (workspaceFolders === null || workspaceFolders.length === 0) {
        return null;
    }
    if (workspaceFolders.length > 1) {
        connection.window.showInformationMessage("CMake IntelliSence doesn't support multi-root workspace now");
        return null;
    }

    return new Promise((resolve, reject) => {
        const document = documents.get(params.textDocument.uri);
        const word: Word = getWordAtPosition(document, params.position);
        const wordPos: string = params.textDocument.uri + '_' + params.position.line + '_' +
            word.col + '_' + word.text;
            
        if (contentChanged) {
            // clear refToDef and topScope first
            refToDef.clear();
            topScope.clear();
            incToBaseDir.clear();

            let rootFile = workspaceFolders[0].uri + '/CMakeLists.txt';
            let rootFileURI: URI = URI.parse(rootFile);
            if (!existsSync(rootFileURI.fsPath)) {
                rootFile = params.textDocument.uri;
                rootFileURI = URI.parse(rootFile);
            }

            const baseDir: URI = Utils.dirname(rootFileURI);
            const tree = getFileContext(rootFileURI);
            const definationListener = new DefinationListener(baseDir, rootFileURI, topScope);
            antlr4.tree.ParseTreeWalker.DEFAULT.walk(definationListener, tree);

            contentChanged = false;
        }

        if (refToDef.has(wordPos)) {
            resolve(refToDef.get(wordPos));
        } else {
            return null;
        }
    });
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    contentChanged = true;
});

function getWordAtPosition(textDocument: TextDocument, position: Position): Word {
    const lineRange: Range = {
        start: { line: position.line, character: 0 },
        end: { line: position.line, character: Number.MAX_VALUE }
    };
    const line = textDocument.getText(lineRange),
        start = line.substring(0, position.character),
        end = line.substring(position.character);
    // TODO: the regex expression capture numbers, fix it.
    const startReg = /[a-zA-Z0-9_\.\/]*$/,
        endReg = /^[a-zA-Z0-9_\.\/]*/;

    const startWord = start.match(startReg)[0],
        endWord = end.match(endReg)[0];
    return {
        text: startWord + endWord,
        line: position.line,
        col: position.character - startWord.length
    };
}

function getCommandProposals(word: string): Thenable<CompletionItem[]> {
    return new Promise((resolve, rejects) => {
        const similarCmds = Object.keys(builtinCmds).filter(cmd => {
            return cmd.includes(word);
        });
        const proposalCmds: CompletionItem[] = similarCmds.map((value, index, array) => {
            let item: CompletionItem = {
                label: value,
                kind: CompletionItemKind.Function,
            };

            if ("deprecated" in builtinCmds[value]) {
                item.tags = [CompletionItemTag.Deprecated];
            }
            return item;
        });

        resolve(proposalCmds);
    });
}

function getProposals(word: string, kind: CompletionItemKind, dataSource: string[]): Thenable<CompletionItem[]> {
    return new Promise((resolve, rejects) => {
        const similar = dataSource.filter(candidate => {
            return candidate.includes(word);
        });

        const proposals: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: kind
            };
        });

        resolve(proposals);
    });
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
