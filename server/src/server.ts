import {
    CodeActionKind,
    CodeActionParams,
    createConnection, DidChangeConfigurationNotification, DidChangeConfigurationParams,
    HoverParams, InitializedParams, InitializeParams, InitializeResult, ProposedFeatures,
    SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams,
    SignatureHelpParams, TextDocumentChangeEvent, TextDocuments, TextDocumentSyncKind
} from 'vscode-languageserver/node';

import {
    CompletionItemKind, CompletionParams, DefinitionParams, DocumentFormattingParams,
    DocumentSymbolParams, SignatureHelpTriggerKind
} from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItem, CompletionItemTag, Position
} from 'vscode-languageserver-types';

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { URI, Utils } from 'vscode-uri';
import * as builtinCmds from './builtin-cmds.json';
import { cmakeInfo } from './cmakeInfo';
import SyntaxErrorListener from './syntaxDiagnostics';
import { SymbolListener } from './docSymbols';
import { FormatListener } from './format';
import antlr4 from './parser/antlr4/index.js';
import CMakeLexer from './parser/CMakeLexer.js';
import CMakeParser from './parser/CMakeParser.js';
import { getTokenBuilder, getTokenModifiers, getTokenTypes, SemanticListener, tokenBuilders } from './semanticTokens';
import { extSettings } from './settings';
import { DefinationListener, incToBaseDir, refToDef, topScope } from './symbolTable/goToDefination';
import { getFileContext } from './utils';
import { createLogger } from './logging';
import SemanticDiagnosticsListener, { cmdNameCase } from './semanticDiagnostics';

type Word = {
    text: string,
    line: number,
    col: number
};

let contentChanged = true;

export let initParams: InitializeParams;

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

export const logger = createLogger('server');

connection.onInitialize(async (params: InitializeParams) => {
    initParams = params;

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
            definitionProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: getTokenTypes(),
                    tokenModifiers: getTokenModifiers()
                },
                range: false,
                full: {
                    delta: true
                }
            },
            codeActionProvider: {
                codeActionKinds: [
                    CodeActionKind.QuickFix
                ]
            }
        },
        serverInfo: {
            name: 'cmakels',
            version: '0.1'
        }
    };

    return result;
});

connection.onInitialized(async (params: InitializedParams) => {
    console.log("Initialized");
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
    await extSettings.getSettings();
    await cmakeInfo.init();
});


connection.onHover(async (params: HoverParams) => {
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

    if (cmakeInfo.modules.includes(word)) {
        const line = document.getText({
            start: { line: params.position.line, character: 0 },
            end: { line: params.position.line, character: Number.MAX_VALUE }
        });
        if (line.trim().startsWith('include')) {
            moduleArg = '--help-module ';
        }
    } else if (cmakeInfo.policies.includes(word)) {
        moduleArg = '--help-policy ';
    } else if (cmakeInfo.variables.includes(word)) {
        moduleArg = '--help-variable ';
    } else if (cmakeInfo.properties.includes(word)) {
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
        getProposals(word, CompletionItemKind.Module, cmakeInfo.modules),
        getProposals(word, CompletionItemKind.Constant, cmakeInfo.policies),
        getProposals(word, CompletionItemKind.Variable, cmakeInfo.variables),
        getProposals(word, CompletionItemKind.Property, cmakeInfo.properties)
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
                    resolve(null);
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
            const line: string = getLineAtPosition(document, params.position);
            const word: string = getWordAtPosition(document, params.position).text;
            if (word.length === 0) {
                if (line[params.position.character - 1] === ')') {
                    resolve(null);
                }
            }
            const firstSig: string = params.context.activeSignatureHelp?.signatures[0].label;
            const leftParenIndex = firstSig.indexOf('(');
            const command = firstSig.slice(0, leftParenIndex);
            if (!command) {
                resolve(null);
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
    const workspaceFolders = initParams.workspaceFolders;
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
            logger.warning(`can't find defination, word: ${word.text}, wordPos: ${wordPos}`);
            return null;
        }
    });
});

connection.languages.semanticTokens.on(async (params: SemanticTokensParams) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) {
        return { data: [] };
    }

    // const builder = getTokenBuilder(document);
    const docUri: URI = URI.parse(params.textDocument.uri);
    const tree = getFileContext(docUri);
    const semanticListener = new SemanticListener(docUri);
    antlr4.tree.ParseTreeWalker.DEFAULT.walk(semanticListener, tree);

    // return builder.build();
    return semanticListener.getSemanticTokens();
});

connection.languages.semanticTokens.onDelta((params: SemanticTokensDeltaParams) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) {
        return {
            edits: []
        };
    }

    const builder = getTokenBuilder(document.uri);
    builder.previousResult(params.previousResultId);

    const docuUri: URI = URI.parse(document.uri);
    const tree = getFileContext(docuUri);
    const semanticListener = new SemanticListener(docuUri);
    antlr4.tree.ParseTreeWalker.DEFAULT.walk(semanticListener, tree);

    return semanticListener.buildEdits();
});

connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams) => {
    return {
        data: []
    };
});

connection.onCodeAction((params: CodeActionParams) => {
    const isCmdCaseProblem = params.context.diagnostics.some(value => {
        return value.message === cmdNameCase;
    });

    if (isCmdCaseProblem) {
        const cmdName: string = documents.get(params.textDocument.uri).getText(params.range);
        return [
            {
                title: `convert '${cmdName}' to lower case`,
                kind: CodeActionKind.QuickFix,
                diagnostics: params.context.diagnostics,
                isPreferred: true,
                edit: {
                    changes: {
                        [params.textDocument.uri]: [
                            {
                                range: params.range,
                                newText: cmdName.toLowerCase()
                            }
                        ]
                    }
                }
            }
        ];
    }

    return [];
});

/**
 * @param params This argument is null when configuration changed
 * 
 * there are two different configuration models. A push model (the old) where
 * the client pushed settings to the server. In this model the client takes a
 * settings configuration which settings to push if they change. The new model
 * is the pull model where the server pulls for settings. This model has the
 * advantage that the pull can contain a scope (e.g. a resource). In this model
 * the clients simply sends an empty change event to signal that the settings
 * have changed and must be reread. The client can't send the changes in the event
 * since the settings might be different for different resources.
 * 
 * see the following two issues for detail
 * https://github.com/microsoft/vscode/issues/54821
 * https://github.com/microsoft/vscode-languageserver-node/issues/380
 */
connection.onDidChangeConfiguration((params: DidChangeConfigurationParams) => {
    extSettings.getSettings();
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
    contentChanged = true;

    // const document = documents.get(change.document.uri);
    const input = antlr4.CharStreams.fromString(change.document.getText());
    const lexer = new CMakeLexer(input);
    const tokenStream = new antlr4.CommonTokenStream(lexer);
    const parser = new CMakeParser(tokenStream);
    parser.removeErrorListeners();
    const syntaxErrorListener = new SyntaxErrorListener();
    parser.addErrorListener(syntaxErrorListener);
    const tree = parser.file();
    const semanticListener = new SemanticDiagnosticsListener();
    antlr4.tree.ParseTreeWalker.DEFAULT.walk(semanticListener, tree);
    connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: [
            ...syntaxErrorListener.getSyntaxErrors(),
            ...semanticListener.getSemanticDiagnostics()
        ]
    });
});

documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
    tokenBuilders.delete(event.document.uri);
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

function getLineAtPosition(textDocument: TextDocument, position: Position): string {
    const lineRange: Range = {
        start: {
            line: position.line,
            character: 0
        },
        end: {
            line: position.line,
            character: Number.MAX_VALUE
        }
    };

    return textDocument.getText(lineRange);
}

function getCommandProposals(word: string): Thenable<CompletionItem[]> {
    return new Promise((resolve, rejects) => {
        const similarCmds = Object.keys(builtinCmds).filter(cmd => {
            return cmd.includes(word.toLowerCase());
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
logger.info('listen on connection');

// Listen on the connection
connection.listen();
