import { CharStreams, CommonTokenStream, ParseTreeWalker } from 'antlr4';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { CompletionItemKind, CompletionParams, DefinitionParams, DocumentFormattingParams, DocumentSymbolParams, SignatureHelpTriggerKind } from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionItemTag, CompletionList, Hover, Position } from 'vscode-languageserver-types';
import { CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from './cmakeInfo';
import { DIAG_CODE_CMD_CASE } from './consts';
import { SymbolListener } from './docSymbols';
import { Formatter } from './format';
import CMakeLexer from './generated/CMakeLexer';
import CMakeParser, { FileContext } from './generated/CMakeParser';
import CMakeSimpleLexer from './generated/CMakeSimpleLexer';
import CMakeSimpleParser, * as cmsp from './generated/CMakeSimpleParser';
import localize from './localize';
import { Logger, createLogger } from './logging';
import SemanticDiagnosticsListener, { CommandCaseChecker } from './semanticDiagnostics';
import { SemanticListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import ExtensionSettings from './settings';
import { DefinationListener, incToBaseDir, parsedFiles, refToDef, topScope } from './symbolTable/goToDefination';
import SyntaxErrorListener from './syntaxDiagnostics';
import { getFileContext } from './utils';

type Word = {
    text: string,
    line: number,
    col: number
};

enum CMakeCompletionType {
    Command,
    Module,
    Policy,
    Variable,
    Property,
    Argument,
}

interface CMakeCompletionInfo {
    type: CMakeCompletionType,

    // if type is CMakeCompletionType.Argument, this field is the active command name
    command?: string,
}

export let logger: Logger;
export let initializationOptions: any;

class CMakeLanguageServer {
    private contentChanged = true;
    private initParams: InitializeParams;
    private connection = createConnection(ProposedFeatures.all);
    private documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
    private extSettings = new ExtensionSettings();
    private cmakeInfo: CMakeInfo;

    constructor() {
        this.initialize();
    }

    private initialize() {
        this.connection.onInitialize(this.onInitialize.bind(this));
        this.connection.onInitialized(this.onInitialized.bind(this));
        this.connection.onHover(this.onHover.bind(this));
        this.connection.onCompletion(this.onCompletion.bind(this));
        this.connection.onSignatureHelp(this.onSignatureHelp.bind(this));
        this.connection.onDocumentFormatting(this.onDocumentFormatting.bind(this));
        this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
        this.connection.onDefinition(this.onDefinition.bind(this));
        this.connection.onCodeAction(this.onCodeAction.bind(this));
        this.connection.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this));
        this.connection.languages.semanticTokens.on(this.onSemanticTokens.bind(this));
        this.connection.languages.semanticTokens.onDelta(this.onSemanticTokensDelta.bind(this));
        this.connection.languages.semanticTokens.onRange(this.onSemanticTokensRange.bind(this));
        this.documents.onDidChangeContent(this.onDidChangeContent.bind(this));
        this.documents.onDidClose(this.onDidClose.bind(this));

        this.documents.listen(this.connection);
        this.connection.listen();
    }

    private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
        this.initParams = params;
        initializationOptions = params.initializationOptions;

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
                        tokenTypes: getTokenTypes(params),
                        tokenModifiers: getTokenModifiers(params),
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
    }

    private async onInitialized(params: InitializedParams) {
        this.connection.client.register(DidChangeConfigurationNotification.type, undefined);
        await this.extSettings.getSettings(this.connection);
        this.cmakeInfo = new CMakeInfo(this.extSettings.cmakePath);
        await this.cmakeInfo.init();
        logger = createLogger('cmake-intellisence', this.extSettings.loggingLevel);
    }

    private async onHover(params: HoverParams): Promise<Hover | null> {
        const document: TextDocument = this.documents.get(params.textDocument.uri);
        const word = this.getWordAtPosition(document, params.position).text;
        if (word.length === 0) {
            return null;
        }

        const wordLower = word.toLowerCase();
        if (wordLower in builtinCmds) {
            const sigs = '```cmdsignature\n'
                + builtinCmds[wordLower]['sig'].join('\n')
                + '\n```';
            const cmdHelp: string = builtinCmds[wordLower]['doc'] + '\n' + sigs;
            return {
                contents: {
                    kind: 'markdown',
                    value: cmdHelp
                }
            };
        }

        let moduleArg = '';

        if (this.cmakeInfo.modules.includes(word)) {
            const line = document.getText({
                start: { line: params.position.line, character: 0 },
                end: { line: params.position.line, character: Number.MAX_VALUE }
            });
            if (line.trim().startsWith('include')) {
                moduleArg = '--help-module ';
            }
        } else if (this.cmakeInfo.policies.includes(word)) {
            moduleArg = '--help-policy ';
        } else if (this.cmakeInfo.variables.includes(word)) {
            moduleArg = '--help-variable ';
        } else if (this.cmakeInfo.properties.includes(word)) {
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
    }

    /**
     * Retrieves the current command context based on the given position.
     * Utilizes binary search to determine if the position falls within the range of any command.
     * 
     * @param contexts - An array of command contexts to search within.
     * @param position - The position to check against the command contexts.
     * @returns The command context if the position is within any command's range, otherwise null.
     */
    private findActiveCommand(contexts: cmsp.CommandContext[], position: Position): cmsp.CommandContext | null {
        if (contexts.length === 0) {
            return null;
        }

        let left = 0, right = contexts.length - 1;
        let mid = 0;
        while (left <= right) {
            mid = Math.floor((left + right) / 2);
            // line is 1-based, column is 0-based in antlr4
            const start = contexts[mid].start.line - 1;
            const stop = contexts[mid].stop.line - 1;
            if (position.line >= start && position.line <= stop) {
                return contexts[mid];
            } else if (position.line < start) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }
        return null;
    }

    private getCompletionInfoAtCursor(tree: cmsp.FileContext, position: Position): CMakeCompletionInfo {
        const commands: cmsp.CommandContext[] = tree.command_list();
        const currentCommand = this.findActiveCommand(commands, position);
        if (currentCommand === null) {
            return { type: CMakeCompletionType.Command };
        } else {
            const lParen = currentCommand.LParen();
            if (lParen === null) {
                return { type: CMakeCompletionType.Command };
            }
            // line is 1-based, column is 0-based in antlr4
            const lParenLine = currentCommand.LParen().symbol.line - 1;
            const rParenLine = currentCommand.RParen().symbol.line - 1;
            const lParenColumn = currentCommand.LParen().symbol.column;
            const rParenColumn = currentCommand.RParen().symbol.column;
            if (position.line >= lParenLine && position.line <= rParenLine) {
                // if the cursor is within the range of the command's arguments
                if (position.character > lParenColumn && position.character <= rParenColumn) {
                    return { type: CMakeCompletionType.Argument, command: currentCommand.ID().symbol.text };
                } else {
                    return { type: CMakeCompletionType.Command };
                }
            }
        }
        return { type: CMakeCompletionType.Command };
    }

    private async onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        const document = this.documents.get(params.textDocument.uri);
        const inputStream = CharStreams.fromString(document.getText());
        const lexer = new CMakeSimpleLexer(inputStream);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokenStream);
        const tree = parser.file();
        const info = this.getCompletionInfoAtCursor(tree, params.position);

        const word = this.getWordAtPosition(document, params.position).text;
        if (info.type === CMakeCompletionType.Command) {
            return this.getCommandSuggestions(word);
        } else if (info.type === CMakeCompletionType.Argument) {
            const command = info.command.toLowerCase();
            return this.getArgumentSuggestions(command);
        }

        const results = await Promise.all([
            this.getCommandSuggestions(word),
            this.getSuggestions(word, CompletionItemKind.Module, this.cmakeInfo.modules),
            this.getSuggestions(word, CompletionItemKind.Constant, this.cmakeInfo.policies),
            this.getSuggestions(word, CompletionItemKind.Variable, this.cmakeInfo.variables),
            this.getSuggestions(word, CompletionItemKind.Property, this.cmakeInfo.properties)
        ]);
        return results.flat();
    }

    private onSignatureHelp(params: SignatureHelpParams) {
        return new Promise((resolve, reject) => {
            const document = this.documents.get(params.textDocument.uri);
            if (params.context.triggerKind === SignatureHelpTriggerKind.TriggerCharacter) {
                if (params.context.triggerCharacter === "(") {
                    const posBeforeLParen: Position = {
                        line: params.position.line,
                        character: params.position.character - 1
                    };

                    const word: string = this.getWordAtPosition(document, posBeforeLParen).text;
                    if (word.length === 0 || !(word in builtinCmds)) {
                        resolve(null);
                        return;
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
                const line: string = this.getLineAtPosition(document, params.position);
                const word: string = this.getWordAtPosition(document, params.position).text;
                if (word.length === 0) {
                    if (line[params.position.character - 1] === ')') {
                        return resolve(null);
                    }
                }
                const firstSig: string = params.context.activeSignatureHelp?.signatures[0].label;
                const leftParenIndex = firstSig.indexOf('(');
                const command = firstSig.slice(0, leftParenIndex);
                if (!command) {
                    return resolve(null);
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
    }

    private onDocumentFormatting(params: DocumentFormattingParams) {
        const tabSize = params.options.tabSize;
        const document = this.documents.get(params.textDocument.uri);
        const range: Range = {
            start: { line: 0, character: 0 },
            end: { line: document.lineCount - 1, character: Number.MAX_VALUE }
        };

        return new Promise((resolve, rejects) => {
            const input = CharStreams.fromString(document.getText());
            const lexer = new CMakeSimpleLexer(input);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new CMakeSimpleParser(tokenStream);
            const tree = parser.file();
            const formatListener = new Formatter(tabSize, tokenStream);
            ParseTreeWalker.DEFAULT.walk(formatListener, tree);
            resolve([
                {
                    range: range,
                    newText: formatListener.formatted
                }
            ]);
        });
    }

    private onDocumentSymbol(params: DocumentSymbolParams) {
        const document = this.documents.get(params.textDocument.uri);
        return new Promise((resolve, reject) => {
            const input = CharStreams.fromString(document.getText());
            const lexer = new CMakeLexer(input);
            const tokenStream = new CommonTokenStream(lexer);
            const parser = new CMakeParser(tokenStream);
            const tree = parser.file();
            const symbolListener = new SymbolListener();
            ParseTreeWalker.DEFAULT.walk(symbolListener, tree);
            resolve(symbolListener.getSymbols());
        });
    }

    private onDefinition(params: DefinitionParams) {
        const workspaceFolders = this.initParams.workspaceFolders;
        if (workspaceFolders === null || workspaceFolders.length === 0) {
            return null;
        }
        if (workspaceFolders.length > 1) {
            this.connection.window.showInformationMessage("CMake IntelliSence doesn't support multi-root workspace now");
            return null;
        }

        return new Promise((resolve, reject) => {
            const document = this.documents.get(params.textDocument.uri);
            const word: Word = this.getWordAtPosition(document, params.position);
            const wordPos: string = params.textDocument.uri + '_' + params.position.line + '_' +
                word.col + '_' + word.text;

            if (this.contentChanged) {
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
                const tree = getFileContext(this.documents, rootFileURI);
                const definationListener = new DefinationListener(this.documents, this.cmakeInfo, baseDir, rootFileURI, topScope);
                ParseTreeWalker.DEFAULT.walk(definationListener, tree);

                this.contentChanged = false;
            }

            if (refToDef.has(wordPos)) {
                return resolve(refToDef.get(wordPos));
            } else {
                if (!parsedFiles.has(params.textDocument.uri)) {
                    refToDef.clear();
                    topScope.clear();
                    incToBaseDir.clear();

                    const curFile: URI = URI.parse(params.textDocument.uri);
                    const tree = getFileContext(this.documents, curFile);
                    const baseDir: URI = Utils.dirname(curFile);
                    const definationListener = new DefinationListener(this.documents, this.cmakeInfo, baseDir, curFile, topScope);
                    ParseTreeWalker.DEFAULT.walk(definationListener, tree);

                    parsedFiles.delete(params.textDocument.uri);

                    if (refToDef.has(wordPos)) {
                        return resolve(refToDef.get(wordPos));
                    }
                }

                logger.warning(`can't find defination, word: ${word.text}, wordPos: ${wordPos}`);
                return null;
            }
        });
    }

    private async onSemanticTokens(params: SemanticTokensParams) {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { data: [] };
        }

        const docUri: URI = URI.parse(params.textDocument.uri);
        const tree: FileContext = getFileContext(this.documents, docUri);
        const semanticListener = new SemanticListener(docUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, tree);

        return semanticListener.getSemanticTokens();
    }

    private onSemanticTokensDelta(params: SemanticTokensDeltaParams) {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return {
                edits: []
            };
        }

        const builder = getTokenBuilder(document.uri);
        builder.previousResult(params.previousResultId);

        const docuUri: URI = URI.parse(document.uri);
        const tree = getFileContext(this.documents, docuUri);
        const semanticListener = new SemanticListener(docuUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, tree);

        return semanticListener.buildEdits();
    }

    private onSemanticTokensRange(params: SemanticTokensRangeParams) {
        return {
            data: []
        };
    }

    private onCodeAction(params: CodeActionParams) {
        const isCmdCaseProblem = params.context.diagnostics.some(value => { return value.code === DIAG_CODE_CMD_CASE; });
        if (isCmdCaseProblem) {
            const cmdName: string = this.documents.get(params.textDocument.uri).getText(params.range);
            return [
                {
                    title: localize('codeAction.cmdCase', cmdName),
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
    }

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
    private onDidChangeConfiguration(params: DidChangeConfigurationParams) {
        this.extSettings.getSettings(this.connection);
    }

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    private onDidChangeContent(change: TextDocumentChangeEvent<TextDocument>) {
        if (change.document.version !== 1) {
            this.contentChanged = true;
        }

        const input = CharStreams.fromString(change.document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        parser.removeErrorListeners();
        const syntaxErrorListener = new SyntaxErrorListener();
        parser.addErrorListener(syntaxErrorListener);
        const tree = parser.file();
        const semanticListener = new SemanticDiagnosticsListener();
        ParseTreeWalker.DEFAULT.walk(semanticListener, tree);
        const diagnostics = {
            uri: change.document.uri,
            diagnostics: [
                ...syntaxErrorListener.getSyntaxErrors(),
                ...semanticListener.getSemanticDiagnostics()
            ]
        };
        if (this.extSettings.cmdCaseDiagnostics) {
            const cmdCaseChecker = new CommandCaseChecker();
            ParseTreeWalker.DEFAULT.walk(cmdCaseChecker, tree);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDdiagnostics());
        }
        this.connection.sendDiagnostics(diagnostics);
    }

    private onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        tokenBuilders.delete(event.document.uri);
    }

    private getWordAtPosition(textDocument: TextDocument, position: Position): Word {
        const lineRange: Range = {
            start: { line: position.line, character: 0 },
            end: { line: position.line, character: Number.MAX_VALUE }
        };
        const line = textDocument.getText(lineRange),
            start = line.substring(0, position.character),
            end = line.substring(position.character);
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

    private getLineAtPosition(textDocument: TextDocument, position: Position): string {
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

    private getCommandSuggestions(word: string): Thenable<CompletionItem[]> {
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

    private getArgumentSuggestions(command: string): Promise<CompletionItem[] | null> {
        return new Promise((resolve, rejects) => {
            if (!(command in builtinCmds)) {
                return resolve(null);
            }
            const sigs: string[] = builtinCmds[command]['sig'];
            const args: string[] = sigs.flatMap(sig => {
                const matches = sig.match(/[A-Z][A-Z_]*[A-Z]/g);
                return matches ? matches : [];
            });
            resolve(Array.from(new Set(args)).map((arg, index, array) => {
                return {
                    label: arg,
                    kind: CompletionItemKind.Variable
                };
            }));
        });
    }

    private getSuggestions(word: string, kind: CompletionItemKind, dataSource: string[]): Thenable<CompletionItem[]> {
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
}

new CMakeLanguageServer();
