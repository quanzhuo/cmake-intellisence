import { CharStreams, CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams, SignatureHelpTriggerKind } from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionList, DocumentLink, Hover, Position } from 'vscode-languageserver-types';
import { CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from './cmakeInfo';
import Completion, { findCommandAtPosition, inComments } from './completion';
import { DIAG_CODE_CMD_CASE } from './consts';
import { DocumentLinkInfo } from './docLink';
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
import { getFileContext, getSimpleFileContext } from './utils';

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

export class CMakeLanguageServer {
    private contentChanged = true;
    private initParams: InitializeParams;
    private connection = createConnection(ProposedFeatures.all);
    private documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
    private extSettings = new ExtensionSettings();
    private cmakeInfo: CMakeInfo;
    private completion: Completion;
    private disposables: Disposable[] = [];

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
        this.connection.onDocumentLinks(this.onDocumentLinks.bind(this));
        this.connection.onShutdown(this.onShutdown.bind(this));

        this.connection.languages.semanticTokens.on(this.onSemanticTokens.bind(this));
        this.connection.languages.semanticTokens.onDelta(this.onSemanticTokensDelta.bind(this));
        this.connection.languages.semanticTokens.onRange(this.onSemanticTokensRange.bind(this));

        this.disposables.push(this.documents.onDidChangeContent(this.onDidChangeContent.bind(this)));
        this.disposables.push(this.documents.onDidClose(this.onDidClose.bind(this)));

        process.on('SIGTERM', () => this.onShutdown());
        process.on('SIGINT', () => this.onShutdown());

        this.documents.listen(this.connection);
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
        const document: TextDocument = this.documents.get(params.textDocument.uri);
        const inputStream = CharStreams.fromString(document.getText());
        const lexer = new CMakeSimpleLexer(inputStream);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokenStream);
        const tree = parser.file();
        const comments = tokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands: cmsp.CommandContext[] = tree.command_list();
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

        return this.completion.onCompletion(params);
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
            const tree = getSimpleFileContext(document.getText());
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
            const word: Word = getWordAtPosition(document, params.position);
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
                const tree = getFileContext(document.getText());
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
                    const tree = getFileContext(document.getText());
                    const baseDir: URI = Utils.dirname(curFile);
                    const definationListener = new DefinationListener(this.documents, this.cmakeInfo, baseDir, curFile, topScope);
                    ParseTreeWalker.DEFAULT.walk(definationListener, tree);

                    parsedFiles.delete(params.textDocument.uri);

                    if (refToDef.has(wordPos)) {
                        return resolve(refToDef.get(wordPos));
                    }
                }

                logger.warning(`can't find defination, word: ${word.text}, wordPos: ${wordPos}`);
                return resolve(null);
            }
        });
    }

    private async onSemanticTokens(params: SemanticTokensParams) {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { data: [] };
        }
        const docUri: URI = URI.parse(params.textDocument.uri);
        const tree: FileContext = getFileContext(document.getText());
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
        const tree = getFileContext(document.getText());
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
    private async onDidChangeConfiguration(params: DidChangeConfigurationParams) {
        await this.extSettings.getSettings(this.connection);
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

    private async onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        const simpleFileContext = getSimpleFileContext(document.getText());
        let commands: cmsp.CommandContext[] = simpleFileContext.command_list();
        commands = commands.filter((command: cmsp.CommandContext) => {
            const cmdName = command.ID().symbol.text;
            return cmdName === 'include' ||
                cmdName === 'file' ||
                cmdName === 'target_sources' ||
                cmdName === 'add_executable' ||
                cmdName === 'add_library' ||
                cmdName === 'configure_file' ||
                cmdName === 'add_subdirectory';
        });
        if (commands.length === 0) {
            return null;
        }

        return new DocumentLinkInfo(commands, params.textDocument.uri, this.cmakeInfo).links;
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

    private onShutdown() {
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }
}

const server = new CMakeLanguageServer();
