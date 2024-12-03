import { CharStreams, CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import { exec } from 'child_process';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams, SignatureHelpTriggerKind } from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionList, DocumentLink, Hover, Location, LocationLink, Position } from 'vscode-languageserver-types';
import { CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, createConnection } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from './cmakeInfo';
import Completion, { findCommandAtPosition, inComments } from './completion';
import { DIAG_CODE_CMD_CASE } from './consts';
import { DefinitionResolver } from './defination';
import SemanticDiagnosticsListener, { CommandCaseChecker, SyntaxErrorListener } from './diagnostics';
import { DocumentLinkInfo } from './docLink';
import { SymbolListener } from './docSymbols';
import { Formatter } from './format';
import CMakeLexer from './generated/CMakeLexer';
import CMakeParser, { FileContext } from './generated/CMakeParser';
import CMakeSimpleLexer from './generated/CMakeSimpleLexer';
import CMakeSimpleParser, * as cmsp from './generated/CMakeSimpleParser';
import localize from './localize';
import { Logger, createLogger } from './logging';
import { SemanticListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import ExtensionSettings from './settings';
import { getFileContent } from './utils';

type Word = {
    text: string,
    line: number,
    col: number
};

export let logger: Logger;
export let initializationOptions: any;
export { builtinCmds };

export function getWordAtPosition(textDocument: TextDocument, position: Position): Word {
    const lineRange: Range = {
        start: { line: position.line, character: 0 },
        end: { line: position.line, character: Number.MAX_VALUE }
    },
        line = textDocument.getText(lineRange),
        start = line.substring(0, position.character),
        end = line.substring(position.character),
        startReg = /[a-zA-Z0-9_\.\/]*$/,
        endReg = /^[a-zA-Z0-9_\.\/]*/,
        startWord = start.match(startReg)[0],
        endWord = end.match(endReg)[0];

    return {
        text: startWord + endWord,
        line: position.line,
        col: position.character - startWord.length
    };
}

export class CMakeLanguageServer {
    private initParams: InitializeParams;
    private connection = createConnection(ProposedFeatures.all);
    private documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
    private extSettings = new ExtensionSettings();
    private cmakeInfo: CMakeInfo;
    private completion: Completion;
    private disposables: Disposable[] = [];
    private fileContexts: Map<string, FileContext> = new Map();
    private tokenStreams: Map<string, CommonTokenStream> = new Map();
    private simpleTokenStreams: Map<string, CommonTokenStream> = new Map();
    private simpleFileContexts: Map<string, cmsp.FileContext> = new Map();

    constructor() {
        this.initialize();
    }

    private initialize() {
        this.disposables.push(
            this.connection.onInitialize(this.onInitialize.bind(this)),
            this.connection.onInitialized(this.onInitialized.bind(this)),
            this.connection.onHover(this.onHover.bind(this)),
            this.connection.onCompletion(this.onCompletion.bind(this)),
            this.connection.onSignatureHelp(this.onSignatureHelp.bind(this)),
            this.connection.onDocumentFormatting(this.onDocumentFormatting.bind(this)),
            this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this)),
            this.connection.onDefinition(this.onDefinition.bind(this)),
            this.connection.onCodeAction(this.onCodeAction.bind(this)),
            this.connection.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this)),
            this.connection.onDocumentLinks(this.onDocumentLinks.bind(this)),
            this.connection.onShutdown(this.onShutdown.bind(this)),
            this.connection.languages.semanticTokens.on(this.onSemanticTokens.bind(this)),
            this.connection.languages.semanticTokens.onDelta(this.onSemanticTokensDelta.bind(this)),
            this.connection.languages.semanticTokens.onRange(this.onSemanticTokensRange.bind(this)),
            this.documents.onDidChangeContent(this.onDidChangeContent.bind(this)),
            this.documents.onDidClose(this.onDidClose.bind(this)),
        );

        process.on('SIGTERM', () => this.onShutdown());
        process.on('SIGINT', () => this.onShutdown());

        this.disposables.push(this.documents.listen(this.connection));
        this.connection.listen();
    }

    private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
        this.initParams = params;
        initializationOptions = params.initializationOptions;
        this.cmakeInfo = new CMakeInfo(initializationOptions.cmakePath, this.connection);
        await this.cmakeInfo.init();
        logger = createLogger('cmake-intellisence', this.extSettings.loggingLevel);

        const result: InitializeResult = {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                hoverProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['(']
                },
                completionProvider: {
                    triggerCharacters: ['/', '(', ' ']
                },
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
                },
                documentLinkProvider: {},
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
    }

    private async onHover(params: HoverParams): Promise<Hover | null> {
        const simpleTokenStream = this.getSimpleTokenStream(params.textDocument.uri);
        const comments = simpleTokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));
        if (inComments(params.position, comments)) {
            return null;
        }

        const simpleFileContext: cmsp.FileContext = this.getSimpleFileContext(params.textDocument.uri);
        const commands: cmsp.CommandContext[] = simpleFileContext.command_list();
        const hoveredCommand = findCommandAtPosition(commands, params.position);
        if (hoveredCommand === null) {
            return null;
        }

        const commandToken: Token = hoveredCommand.ID().symbol;
        const commandName = commandToken.text.toLowerCase();
        // if hover on command name
        if ((params.position.line + 1 === commandToken.line) && (params.position.character <= commandToken.column + commandToken.text.length)) {
            if (commandName.toLowerCase() in builtinCmds) {
                const sigs = '```cmdsignature\n'
                    + builtinCmds[commandName]['sig'].join('\n')
                    + '\n```';
                const cmdHelp: string = builtinCmds[commandName]['doc'] + '\n' + sigs;
                return {
                    contents: {
                        kind: 'markdown',
                        value: cmdHelp
                    }
                };
            }
        }
        // hover on arguments
        else {
            const document = this.documents.get(params.textDocument.uri);
            const word = getWordAtPosition(document, params.position).text;
            if (word.length === 0) {
                return null;
            }

            let arg = '';
            if (commandName === 'include' && this.cmakeInfo.modules.includes(word)) {
                arg = '--help-module ';
            } else if (commandName === 'cmake_policy' && this.cmakeInfo.policies.includes(word)) {
                arg = '--help-policy ';
            } else if (this.cmakeInfo.variables.includes(word)) {
                arg = '--help-variable ';
            } else if (this.cmakeInfo.properties.includes(word)) {
                arg = '--help-property ';
            }

            if (arg.length !== 0) {
                const command = 'cmake ' + arg + word;
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
    }

    private async onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        if (!this.completion) {
            this.completion = new Completion(this.initParams, this.connection, this.documents, this.extSettings, this.cmakeInfo);
        }

        return this.completion.onCompletion(params, this.getSimpleFileContext(params.textDocument.uri), this.getSimpleTokenStream(params.textDocument.uri));
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

                    const word: string = getWordAtPosition(document, posBeforeLParen).text;
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
                const word: string = getWordAtPosition(document, params.position).text;
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
            const formatListener = new Formatter(tabSize, this.getSimpleTokenStream(params.textDocument.uri));
            ParseTreeWalker.DEFAULT.walk(formatListener, this.getSimpleFileContext(params.textDocument.uri));
            resolve([
                {
                    range: range,
                    newText: formatListener.formatted
                }
            ]);
        });
    }

    private onDocumentSymbol(params: DocumentSymbolParams) {
        return new Promise((resolve, reject) => {
            const symbolListener = new SymbolListener();
            ParseTreeWalker.DEFAULT.walk(symbolListener, this.getFileContext(params.textDocument.uri));
            resolve(symbolListener.getSymbols());
        });
    }

    private onDefinition(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const uri: string = params.textDocument.uri;
        const simpleFileContext: cmsp.FileContext = this.getSimpleFileContext(uri);
        const simpleTokenStream: CommonTokenStream = this.getSimpleTokenStream(uri);
        const comments = simpleTokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));
        if (inComments(params.position, comments)) {
            return Promise.resolve(null);
        }

        const commands = simpleFileContext.command_list();
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return Promise.resolve(null);
        }

        const workspaceFolder = this.initParams.workspaceFolders[0].uri;
        const resolver = new DefinitionResolver(this.fileContexts, this.documents, this.cmakeInfo, workspaceFolder, URI.parse(uri), command);
        return resolver.resolve(params);
    }

    private async onSemanticTokens(params: SemanticTokensParams) {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { data: [] };
        }
        const docUri: URI = URI.parse(params.textDocument.uri);
        const semanticListener = new SemanticListener(docUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(params.textDocument.uri));
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
        const docUri: URI = URI.parse(document.uri);
        const semanticListener = new SemanticListener(docUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(document.uri));
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
    private async onDidChangeConfiguration(params: DidChangeConfigurationParams) {
        await this.extSettings.getSettings(this.connection);
    }

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    private onDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
        // check syntax errors
        const input = CharStreams.fromString(event.document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        parser.removeErrorListeners();
        const syntaxErrorListener = new SyntaxErrorListener();
        parser.addErrorListener(syntaxErrorListener);
        const fileContext = parser.file();
        this.fileContexts.set(event.document.uri, fileContext);
        this.tokenStreams.set(event.document.uri, tokenStream);

        // get simpleFileContext
        input.reset();
        const simpleLexer = new CMakeSimpleLexer(input);
        const simpleTokenStream = new CommonTokenStream(simpleLexer);
        const simpleParser = new CMakeSimpleParser(simpleTokenStream);
        const simpleFileContext = simpleParser.file();
        this.simpleFileContexts.set(event.document.uri, simpleFileContext);
        this.simpleTokenStreams.set(event.document.uri, simpleTokenStream);

        // check semantic errors
        const semanticListener = new SemanticDiagnosticsListener();
        ParseTreeWalker.DEFAULT.walk(semanticListener, fileContext);

        // all diagnostics
        const diagnostics = {
            uri: event.document.uri,
            diagnostics: [
                ...syntaxErrorListener.getSyntaxErrors(),
                ...semanticListener.getSemanticDiagnostics()
            ]
        };
        if (this.extSettings.cmdCaseDiagnostics) {
            const cmdCaseChecker = new CommandCaseChecker();
            ParseTreeWalker.DEFAULT.walk(cmdCaseChecker, simpleFileContext);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDdiagnostics());
        }
        this.connection.sendDiagnostics(diagnostics);
    }

    private async onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[] | null> {
        const simpleFileContext = this.getSimpleFileContext(params.textDocument.uri);
        return new DocumentLinkInfo(simpleFileContext, params.textDocument.uri, this.cmakeInfo).links;
    }

    private onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        tokenBuilders.delete(event.document.uri);
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

    public getFileContext(uri: string): FileContext {
        if (this.fileContexts.has(uri)) {
            return this.fileContexts.get(uri);
        }

        const input = CharStreams.fromString(getFileContent(this.documents, URI.parse(uri)));
        const lexer = new CMakeLexer(input);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        const fileContext = parser.file();
        this.fileContexts.set(uri, fileContext);
        this.tokenStreams.set(uri, tokenStream);
        return fileContext;
    }

    public getTokenStream(uri: string): CommonTokenStream {
        if (this.tokenStreams.has(uri)) {
            return this.tokenStreams.get(uri);
        }
        this.getFileContext(uri);
        return this.tokenStreams.get(uri);
    }

    public getSimpleFileContext(uri: string): cmsp.FileContext {
        if (this.simpleFileContexts.has(uri)) {
            return this.simpleFileContexts.get(uri);
        }

        const input = CharStreams.fromString(getFileContent(this.documents, URI.parse(uri)));
        const lexer = new CMakeSimpleLexer(input);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokenStream);
        const fileContext = parser.file();
        this.simpleFileContexts.set(uri, fileContext);
        this.simpleTokenStreams.set(uri, tokenStream);
        return fileContext;
    }

    public getSimpleTokenStream(uri: string): CommonTokenStream {
        if (this.simpleTokenStreams.has(uri)) {
            return this.simpleTokenStreams.get(uri);
        }
        this.getSimpleFileContext(uri);
        return this.simpleTokenStreams.get(uri);
    }

    private onShutdown() {
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }
}

const server = new CMakeLanguageServer();
