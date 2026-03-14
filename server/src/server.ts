import { CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { Range, TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { CodeAction, Command, CompletionItem, CompletionList, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, SignatureHelp, SymbolInformation } from 'vscode-languageserver-types';
import { CancellationToken, CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, ReferenceParams, RenameParams, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, WorkspaceEdit, WorkspaceSymbolParams, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import { hydrateBuiltinModuleCacheEntry, loadBuiltinModuleCommandCatalog, warmBuiltinModuleCaches } from './builtinModuleIndex';
import { isCancellationError, throwIfCancelled } from './cancellation';
import { ExtensionSettings, ProjectTargetInfoListener, initializeCMakeEnvironment } from './cmakeEnvironment';
import Completion, { CMakeCompletionType, CompletionItemType, ProjectTargetInfo, findCommandAtPosition, findRecoveredCommandInfoAtPosition, getCompletionHelpLabel, getCompletionInfoAtCursor, getCompletionItemType, getCompletionWorkspaceKey, inComments } from './completion';
import { DefinitionResolver } from './defination';
import SemanticDiagnosticsListener, { CommandCaseChecker, DIAG_CODE_CMD_CASE, SyntaxErrorListener } from './diagnostics';
import { DocumentLinkInfo } from './docLink';
import { SymbolListener } from './docSymbols';
import { FlatCommand } from './flatCommands';
import { Formatter } from './format';
import CMakeLexer from './generated/CMakeLexer';
import { FileContext } from './generated/CMakeParser';
import localize, { localizeInitializer } from './localize';
import { Logger, createLogger } from './logging';
import { ExecFileFailure, execFilePromise } from './processUtils';
import { ReferenceResolver } from './references';
import { RenameResolver } from './rename';
import { rstToMarkdown } from './rstToMarkdown';
import { SemanticTokenListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import { buildSignatureHelp, buildSignatureHelpForInvocation } from './signatureHelp';
import { extractSymbols } from './symbolExtractor';
import { SymbolIndex } from './symbolIndex';
import { READY_NOTIFICATION } from './testing';
import { ParsedCMakeFile, getFileContent, parseCMakeText } from './utils';
import { WorkspaceSymbolResolver } from './workspaceSymbol';

type Word = {
    text: string,
    line: number,
    col: number
};

type WorkspaceState = {
    workspaceFolder: URI;
    symbolIndex: SymbolIndex;
    projectTargetInfo?: ProjectTargetInfo;
    projectTargetInfoDirty: boolean;
    workspaceIndexing?: Promise<void>;
    cmakeHelpCache: Map<string, Promise<string | null>>;
    environmentInitialization?: Promise<void>;
    environmentGeneration: number;
    extSettings: ExtensionSettings;
};

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
        startWord = start.match(startReg)?.[0] ?? '',
        endWord = end.match(endReg)?.[0] ?? '';

    return {
        text: startWord + endWord,
        line: position.line,
        col: position.character - startWord.length
    };
}

export class CMakeLanguageServer {
    private initParams?: InitializeParams;
    private connection = createConnection(ProposedFeatures.all);
    private documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
    private disposables: Disposable[] = [];
    private fileContexts: Map<string, FileContext> = new Map();
    private tokenStreams: Map<string, CommonTokenStream> = new Map();
    private flatCommandsMap: Map<string, FlatCommand[]> = new Map();
    private commentsMap: Map<string, Token[]> = new Map();
    private workspaceStates: Map<string, WorkspaceState> = new Map();
    private logger: Logger = createLogger('cmake-intelli', 'off');

    private readonly defaultExtSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
    };

    constructor() {
        this.disposables.push(
            this.connection.onInitialize(this.wrapRequestRethrow('initialize', this.onInitialize.bind(this))),
            this.connection.onInitialized(this.wrapNotification('initialized', this.onInitialized.bind(this))),
            this.connection.onHover(this.wrapRequest('hover', this.onHover.bind(this), null)),
            this.connection.onCompletion(this.wrapRequest('completion', this.onCompletion.bind(this), null)),
            this.connection.onCompletionResolve(this.wrapRequest('completionResolve', this.onCompletionResolve.bind(this), undefined as unknown as CompletionItem)),
            this.connection.onSignatureHelp(this.wrapRequest('signatureHelp', this.onSignatureHelp.bind(this), null)),
            this.connection.onDocumentFormatting(this.wrapRequest('documentFormatting', this.onDocumentFormatting.bind(this), null)),
            this.connection.onDocumentSymbol(this.wrapRequest('documentSymbol', this.onDocumentSymbol.bind(this), null)),
            this.connection.onDefinition(this.wrapRequest('definition', this.onDefinition.bind(this), null)),
            this.connection.onReferences(this.wrapRequest('references', this.onReferences.bind(this), null)),
            this.connection.onRenameRequest(this.wrapRequest('rename', this.onRename.bind(this), null)),
            this.connection.onWorkspaceSymbol(this.wrapRequest('workspaceSymbol', this.onWorkspaceSymbol.bind(this), null)),
            this.connection.onCodeAction(this.wrapRequest('codeAction', this.onCodeAction.bind(this), [])),
            this.connection.onDidChangeConfiguration(this.wrapNotification('didChangeConfiguration', this.onDidChangeConfiguration.bind(this))),
            this.connection.onDocumentLinks(this.wrapRequest('documentLinks', this.onDocumentLinks.bind(this), null)),
            this.connection.onShutdown(this.wrapNotification('shutdown', this.onShutdown.bind(this))),
            this.connection.languages.semanticTokens.on(this.wrapRequest('semanticTokens', this.onSemanticTokens.bind(this), { data: [] })),
            this.connection.languages.semanticTokens.onDelta(this.wrapRequest('semanticTokensDelta', this.onSemanticTokensDelta.bind(this), { edits: [] })),
            this.connection.languages.semanticTokens.onRange(this.wrapRequest('semanticTokensRange', this.onSemanticTokensRange.bind(this), { data: [] })),
            this.documents.onDidChangeContent(this.wrapNotification('didChangeContent', this.onDidChangeContent.bind(this))),
            this.documents.onDidClose(this.wrapNotification('didClose', this.onDidClose.bind(this))),
        );

        process.on('SIGTERM', () => this.onShutdown());
        process.on('SIGINT', () => this.onShutdown());

        this.disposables.push(this.documents.listen(this.connection));
        this.connection.listen();
    }

    // #region: methods to process LSP requests and notifications

    private logUnhandledHandlerError(handlerName: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.connection.console.error(`Unhandled error in ${handlerName}: ${message}`);
        this.logger.error(`Unhandled error in ${handlerName}: ${message}`);
        if (error instanceof Error && error.stack) {
            this.logger.debug(error.stack);
        }
    }

    private createWorkspaceState(workspaceFolder: URI): WorkspaceState {
        return {
            workspaceFolder,
            symbolIndex: new SymbolIndex(),
            projectTargetInfoDirty: false,
            cmakeHelpCache: new Map<string, Promise<string | null>>(),
            environmentGeneration: 0,
            extSettings: { ...this.defaultExtSettings },
        };
    }

    private getWorkspaceState(workspaceFolder: URI): WorkspaceState {
        const key = workspaceFolder.toString();
        let state = this.workspaceStates.get(key);
        if (!state) {
            state = this.createWorkspaceState(workspaceFolder);
            this.workspaceStates.set(key, state);
        }
        return state;
    }

    private getWorkspaceStateForUri(docUri: string): WorkspaceState {
        return this.getWorkspaceState(this.getWorkspaceFolderForUri(docUri));
    }

    private getWorkspaceStateByKey(workspaceKey: string | undefined, fallbackUri?: string): WorkspaceState | undefined {
        if (workspaceKey) {
            return this.workspaceStates.get(workspaceKey);
        }
        if (fallbackUri) {
            return this.getWorkspaceStateForUri(fallbackUri);
        }
        const [firstWorkspace] = this.getWorkspaceFolders();
        return firstWorkspace ? this.getWorkspaceState(firstWorkspace) : undefined;
    }

    private wrapRequest<TArgs extends unknown[], TResult>(
        handlerName: string,
        handler: (...args: TArgs) => Promise<TResult> | TResult,
        fallbackValue: TResult,
    ): (...args: TArgs) => Promise<TResult> {
        return async (...args: TArgs): Promise<TResult> => {
            try {
                return await handler(...args);
            } catch (error) {
                if (isCancellationError(error)) {
                    return fallbackValue;
                }
                this.logUnhandledHandlerError(handlerName, error);
                return fallbackValue;
            }
        };
    }

    private wrapRequestRethrow<TArgs extends unknown[], TResult>(
        handlerName: string,
        handler: (...args: TArgs) => Promise<TResult> | TResult,
    ): (...args: TArgs) => Promise<TResult> {
        return async (...args: TArgs): Promise<TResult> => {
            try {
                return await handler(...args);
            } catch (error) {
                this.logUnhandledHandlerError(handlerName, error);
                throw error;
            }
        };
    }

    private wrapNotification<TArgs extends unknown[]>(
        handlerName: string,
        handler: (...args: TArgs) => Promise<void> | void,
    ): (...args: TArgs) => Promise<void> {
        return async (...args: TArgs): Promise<void> => {
            try {
                await handler(...args);
            } catch (error) {
                this.logUnhandledHandlerError(handlerName, error);
            }
        };
    }

    private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
        this.initParams = params;
        localizeInitializer.init(params.locale || 'en');

        const result: InitializeResult = {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                hoverProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['('],
                    retriggerCharacters: [' '],
                },
                completionProvider: {
                    triggerCharacters: ['/', '(', ' '],
                    resolveProvider: true,
                },
                documentFormattingProvider: true,
                documentSymbolProvider: true,
                definitionProvider: true,
                referencesProvider: true,
                renameProvider: { prepareProvider: false },
                workspaceSymbolProvider: true,
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
        await Promise.all(this.getWorkspaceFolders().map(folder => this.ensureEnvironmentInitialized(folder)));
        await this.ensureAllWorkspaceFoldersIndexed();
        this.connection.sendNotification(READY_NOTIFICATION);
    }

    private async onHover(params: HoverParams, token: CancellationToken): Promise<Hover | null> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureEnvironmentInitialized(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureWorkspaceIndexedForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(params.textDocument.uri);
        throwIfCancelled(token);
        const comments = this.getComments(params.textDocument.uri);
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands: FlatCommand[] = this.getFlatCommands(params.textDocument.uri);
        const tokenStream = this.getTokenStream(params.textDocument.uri);
        const hoveredCommand = findCommandAtPosition(commands, params.position);
        const recoveredCommandInfo = hoveredCommand ? null : findRecoveredCommandInfoAtPosition(tokenStream, params.position);
        const recoveredCommandName = recoveredCommandInfo?.name ?? null;
        if (hoveredCommand === null && recoveredCommandName === null) {
            return null;
        }

        const commandToken: Token | null = hoveredCommand?.ID().symbol ?? null;
        const commandName = (hoveredCommand?.ID().symbol.text ?? recoveredCommandName ?? '').toLowerCase();
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }
        let word = getWordAtPosition(document, params.position).text;
        if (word.length === 0) {
            return null;
        }

        let arg = '', category = '';
        const systemCache = workspaceState.symbolIndex.getSystemCache();
        const hoveringCommandToken = commandToken
            ? ((params.position.line + 1 === commandToken.line) && (params.position.character <= commandToken.column + commandToken.text.length))
            : (recoveredCommandInfo?.isOnCommandName ?? false);

        if (hoveringCommandToken && systemCache.commands.has(commandName.toLowerCase())) {
            arg = '--help-command';
            category = 'command';
            word = commandName;
        } else if (commandName === 'include' && systemCache.modules.has(word)) {
            arg = '--help-module';
            category = 'module';
        } else if (commandName === 'cmake_policy' && systemCache.policies.has(word)) {
            arg = '--help-policy';
            category = 'policy';
        } else if (systemCache.variables.has(word)) {
            arg = '--help-variable';
            category = 'variable';
        } else if (systemCache.properties.has(word)) {
            arg = '--help-property';
            category = 'property';
        }

        if (arg.length !== 0) {
            try {
                throwIfCancelled(token);
                const stdout = await this.getCMakeHelp(workspaceState, arg, word);
                throwIfCancelled(token);
                if (stdout === null) {
                    return null;
                }

                return {
                    contents: {
                        kind: 'markdown',
                        value: stdout,
                    }
                };

            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }

                const pattern = /_(CXX|C)(_)?$/;
                if (pattern.test(word)) {
                    const modifiedWord = word.replace(pattern, '_<LANG>$2');
                    throwIfCancelled(token);
                    const modifiedStdout = await this.getCMakeHelp(workspaceState, arg, modifiedWord);
                    throwIfCancelled(token);
                    if (modifiedStdout !== null) {
                        this.logger.debug(`Hover help fallback succeeded for ${word} -> ${modifiedWord}`);
                        return {
                            contents: {
                                kind: 'markdown',
                                value: modifiedStdout,
                            }
                        };
                    }
                    return null;
                }

                this.logger.debug(`Hover help lookup failed for ${category || 'unknown'} ${word}: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        }
        return null;
    }

    private getEntryFilePath(docUri: string): string {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const entryCMakeLists = Utils.joinPath(workspaceFolder, "CMakeLists.txt");
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            return entryCMakeLists.toString();
        }

        const indexedEntryFile = workspaceState.symbolIndex.findEntryFile(docUri);
        if (indexedEntryFile) {
            return indexedEntryFile;
        }

        return docUri;
    }

    private onCompletion(params: CompletionParams, token: CancellationToken): Promise<CompletionItem[] | CompletionList | null> {
        return this.handleCompletion(params, token);
    }

    private async handleCompletion(params: CompletionParams, token?: CancellationToken): Promise<CompletionItem[] | CompletionList | null> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureEnvironmentInitialized(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureWorkspaceIndexedForUri(params.textDocument.uri);
        throwIfCancelled(token);

        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        const entryFileSource = this.getEntryFilePath(params.textDocument.uri);
        await this.populateIndexTopDownAsync(entryFileSource, new Set(), token);
        throwIfCancelled(token);

        const word = getWordAtPosition(document, params.position).text;
        const targetInfo = await this.getProjectTargetInfoForUri(params.textDocument.uri, entryFileSource);
        throwIfCancelled(token);
        const completion = new Completion(this.flatCommandsMap, this.tokenStreams, targetInfo, word, this.logger, workspaceState.symbolIndex, params.textDocument.uri, entryFileSource, workspaceState.workspaceFolder.toString());
        return completion.onCompletion(params);
    }

    private onCompletionResolve(item: CompletionItem): Promise<CompletionItem> {
        const workspaceState = this.getWorkspaceStateByKey(getCompletionWorkspaceKey(item.data));
        const completionType = getCompletionItemType(item.data);
        if (completionType === undefined) {
            return Promise.resolve(item);
        }

        if (completionType === CompletionItemType.PkgConfigModules) {
            item.documentation = workspaceState?.symbolIndex.pkgConfigModules.get(item.label);
            return Promise.resolve(item);
        }

        let helpArg = '';
        switch (completionType) {
            case CompletionItemType.BuiltInCommand:
                helpArg = '--help-command';
                break;
            case CompletionItemType.BuiltInModule:
                helpArg = '--help-module';
                break;
            case CompletionItemType.BuiltInPolicy:
                helpArg = '--help-policy';
                break;
            case CompletionItemType.BuiltInVariable:
                helpArg = '--help-variable';
                break;
            case CompletionItemType.BuiltInProperty:
                helpArg = '--help-property';
                break;
            default:
                return Promise.resolve(item);
        }
        const helpLabel = getCompletionHelpLabel(item.data) ?? item.label;
        if (!workspaceState) {
            return Promise.resolve(item);
        }

        return this.getCMakeHelp(workspaceState, helpArg, helpLabel, true).then(stdout => {
            if (stdout !== null) {
                item.documentation = {
                    kind: 'markdown',
                    value: stdout,
                };
            }
            return item;
        });
    }

    private async onSignatureHelp(params: SignatureHelpParams): Promise<SignatureHelp | null> {
        const pos = params.position;
        const uri = params.textDocument.uri;
        await this.ensureParsedFile(uri);
        const commands: FlatCommand[] = this.getFlatCommands(uri);
        const tokenStream = this.getTokenStream(uri);
        const completionInfo = getCompletionInfoAtCursor(commands, pos, tokenStream);
        if (completionInfo.type === CMakeCompletionType.Argument && completionInfo.command) {
            const args = completionInfo.context
                ? completionInfo.context.argument_list().map(arg => arg.getText())
                : (completionInfo.arguments ?? []);
            return buildSignatureHelpForInvocation(completionInfo.command, args, completionInfo.index ?? 0);
        }

        const command = findCommandAtPosition(commands, pos);
        if (!command) {
            return null;
        }
        return buildSignatureHelp(command, pos, commands);
    }

    private async onDocumentFormatting(params: DocumentFormattingParams): Promise<TextEdit[] | null> {
        await this.ensureParsedFile(params.textDocument.uri);
        const tabSize = params.options.tabSize;
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }
        const range: Range = {
            start: { line: 0, character: 0 },
            end: { line: document.lineCount - 1, character: Number.MAX_VALUE }
        };

        const formatListener = new Formatter(tabSize, this.getTokenStream(params.textDocument.uri));
        try {
            formatListener.format(this.getFlatCommands(params.textDocument.uri));
        } catch (error) {
            this.logger.error(`Failed to format document: ${error}`);
        }
        return [
            {
                range: range,
                newText: formatListener.formatted
            }
        ];
    }

    private async onDocumentSymbol(params: DocumentSymbolParams): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
        await this.ensureParsedFile(params.textDocument.uri);
        const symbolListener = new SymbolListener();
        ParseTreeWalker.DEFAULT.walk(symbolListener, this.getFileContext(params.textDocument.uri));
        return symbolListener.getSymbols();
    }

    private async onDefinition(params: DefinitionParams, token: CancellationToken): Promise<Location | Location[] | LocationLink[] | null> {
        const uri: string = params.textDocument.uri;
        const workspaceState = this.getWorkspaceStateForUri(uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(uri);
        throwIfCancelled(token);
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return null;
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const resolver = new DefinitionResolver(
            this.documents,
            workspaceState.symbolIndex,
            this.getFlatCommandsAsync.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger,
            () => token.isCancellationRequested,
        );
        return await resolver.resolve(params);
    }

    private async onReferences(params: ReferenceParams, token: CancellationToken): Promise<Location[] | null> {
        const uri: string = params.textDocument.uri;
        const workspaceState = this.getWorkspaceStateForUri(uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(uri);
        throwIfCancelled(token);
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return null;
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const resolver = new ReferenceResolver(
            this.documents,
            workspaceState.symbolIndex,
            this.getFlatCommandsAsync.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger,
            () => token.isCancellationRequested,
        );
        return await resolver.resolve(params);
    }

    private async onRename(params: RenameParams, token: CancellationToken): Promise<WorkspaceEdit | null> {
        const uri: string = params.textDocument.uri;
        const workspaceState = this.getWorkspaceStateForUri(uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(uri);
        throwIfCancelled(token);
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return null;
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const refResolver = new ReferenceResolver(
            this.documents,
            workspaceState.symbolIndex,
            this.getFlatCommandsAsync.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger,
            () => token.isCancellationRequested,
        );
        const renameResolver = new RenameResolver(refResolver);
        return await renameResolver.resolve(params, () => token.isCancellationRequested);
    }

    private async onWorkspaceSymbol(params: WorkspaceSymbolParams): Promise<SymbolInformation[] | null> {
        const resolve = async (): Promise<SymbolInformation[] | null> => {
            await this.ensureAllWorkspaceFoldersIndexed();
            const results = await Promise.all(this.getWorkspaceFolders().map(async folder => {
                const resolver = new WorkspaceSymbolResolver(this.getWorkspaceState(folder).symbolIndex);
                return resolver.resolve(params) ?? [];
            }));
            return results.flat();
        };

        return resolve();
    }

    private async onSemanticTokens(params: SemanticTokensParams): Promise<SemanticTokens> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { data: [] };
        }
        await this.ensureParsedFile(params.textDocument.uri);
        const docUri: URI = URI.parse(params.textDocument.uri);
        const entryUri = this.getEntryFilePath(params.textDocument.uri);
        const semanticListener = new SemanticTokenListener(docUri.toString(), workspaceState.symbolIndex, entryUri);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(params.textDocument.uri));
        return semanticListener.getSemanticTokens();
    }

    private async onSemanticTokensDelta(params: SemanticTokensDeltaParams): Promise<SemanticTokens | SemanticTokensDelta> {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { edits: [] };
        }

        const workspaceState = this.getWorkspaceStateForUri(document.uri);
        await this.ensureParsedFile(document.uri);
        const builder = getTokenBuilder(document.uri);
        builder.previousResult(params.previousResultId);
        const docUri: URI = URI.parse(document.uri);
        const entryUri = this.getEntryFilePath(document.uri);
        const semanticListener = new SemanticTokenListener(docUri.toString(), workspaceState.symbolIndex, entryUri);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(document.uri));
        return semanticListener.buildEdits();
    }

    private onSemanticTokensRange(params: SemanticTokensRangeParams): Promise<SemanticTokens> {
        return Promise.resolve({ data: [] });
    }

    private onCodeAction(params: CodeActionParams): (Command | CodeAction)[] | null {
        const isCmdCaseProblem = params.context.diagnostics.some(value => { return value.code === DIAG_CODE_CMD_CASE; });
        if (isCmdCaseProblem) {
            const document = this.documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }
            const cmdName: string = document.getText(params.range);
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
        await Promise.all(this.getWorkspaceFolders().map(async folder => {
            const workspaceState = this.getWorkspaceState(folder);
            const extSettings = await this.getExtSettings(folder.toString());
            if (extSettings.cmakePath !== workspaceState.extSettings.cmakePath || extSettings.pkgConfigPath !== workspaceState.extSettings.pkgConfigPath) {
                workspaceState.environmentInitialization = this.initializeEnvironment(folder, extSettings);
                await workspaceState.environmentInitialization;
                await this.ensureWorkspaceFolderIndexed(folder);
                return;
            }
            workspaceState.extSettings = extSettings;
            this.logger.setLevel(extSettings.loggingLevel);
        }));
    }

    /**
     * The content of a text document has changed. This event is emitted
     *  when the text document first opened or when its content has changed.
     * 
     * @param event 
     */
    private async onDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
        const workspaceState = this.getWorkspaceStateForUri(event.document.uri);
        await this.ensureEnvironmentInitialized(event.document.uri);

        // check syntax errors
        const syntaxErrorListener = new SyntaxErrorListener();
        const parsedFile = this.parseCMakeFile(event.document, 'document change', parser => {
            parser.removeErrorListeners();
            parser.addErrorListener(syntaxErrorListener);
        });
        const { fileContext, flatCommands } = parsedFile;
        this.storeParsedFileSnapshot(event.document.uri, parsedFile);

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

        if (workspaceState.extSettings.cmdCaseDiagnostics) {
            const cmdCaseChecker = new CommandCaseChecker(workspaceState.symbolIndex);
            cmdCaseChecker.check(flatCommands);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDiagnostics());
        }
        this.connection.sendDiagnostics(diagnostics);

        this.markProjectTargetInfoDirty(event.document.uri);
    }

    private async onDocumentLinks(params: DocumentLinkParams, token: CancellationToken): Promise<DocumentLink[] | null> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(params.textDocument.uri);
        throwIfCancelled(token);
        const commands = this.getFlatCommands(params.textDocument.uri);
        const linkInfo = await DocumentLinkInfo.create(commands, params.textDocument.uri, workspaceState.symbolIndex);
        throwIfCancelled(token);
        return linkInfo.links;
    }

    private onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        const uri = event.document.uri;
        tokenBuilders.delete(uri);
        this.fileContexts.delete(uri);
        this.tokenStreams.delete(uri);
        this.commentsMap.delete(uri);
        const docUri = URI.parse(uri);
        const workspaceFolderUri = this.getWorkspaceFolderForUri(uri);
        const isPersistedWorkspaceFile = this.isUriInsideWorkspace(docUri, workspaceFolderUri) && fs.existsSync(docUri.fsPath);

        if (isPersistedWorkspaceFile) {
            this.indexWorkspaceFile(uri);
        } else {
            this.flatCommandsMap.delete(uri);
            this.getWorkspaceState(workspaceFolderUri).symbolIndex.deleteCache(uri);
        }

        const workspaceState = this.getWorkspaceState(workspaceFolderUri);
        workspaceState.projectTargetInfo = undefined;
        workspaceState.projectTargetInfoDirty = false;
    }

    private onShutdown() {
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }

    // #endregion

    private markProjectTargetInfoDirty(docUri: string) {
        this.getWorkspaceStateForUri(docUri).projectTargetInfoDirty = true;
    }

    private getWorkspaceFolderForUri(docUri: string): URI {
        const documentUri = URI.parse(docUri);
        const workspaceFolders = this.getWorkspaceFolders();

        if (workspaceFolders.length === 0) {
            return URI.file(path.dirname(documentUri.fsPath));
        }

        let bestMatch: URI | undefined;
        for (const workspaceFolder of workspaceFolders) {
            const relativePath = path.relative(workspaceFolder.fsPath, documentUri.fsPath);
            const isInsideWorkspace = relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
            if (!isInsideWorkspace) {
                continue;
            }
            if (!bestMatch || workspaceFolder.fsPath.length > bestMatch.fsPath.length) {
                bestMatch = workspaceFolder;
            }
        }

        return bestMatch ?? workspaceFolders[0];
    }

    private getWorkspaceFolders(): URI[] {
        return this.initParams?.workspaceFolders?.map(folder => URI.parse(folder.uri))
            ?? (this.initParams?.rootUri ? [URI.parse(this.initParams.rootUri)] : []);
    }

    private isUriInsideWorkspace(documentUri: URI, workspaceFolder: URI): boolean {
        const relativePath = path.relative(workspaceFolder.fsPath, documentUri.fsPath);
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    private async ensureAllWorkspaceFoldersIndexed(): Promise<void> {
        await Promise.all(this.getWorkspaceFolders().map(folder => this.ensureWorkspaceFolderIndexed(folder)));
    }

    private async ensureWorkspaceIndexedForUri(docUri: string): Promise<void> {
        await this.ensureWorkspaceFolderIndexed(this.getWorkspaceFolderForUri(docUri));
    }

    private ensureWorkspaceFolderIndexed(workspaceFolder: URI): Promise<void> {
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const existing = workspaceState.workspaceIndexing;
        if (existing) {
            return existing;
        }

        const indexing = this.indexWorkspaceFolder(workspaceFolder).catch(error => {
            workspaceState.workspaceIndexing = undefined;
            this.logger.error(`Failed to index workspace folder ${workspaceFolder.fsPath}`, error as Error);
        });
        workspaceState.workspaceIndexing = indexing;
        return indexing;
    }

    private async indexWorkspaceFolder(workspaceFolder: URI): Promise<void> {
        const start = Date.now();
        const files = await this.collectWorkspaceCMakeFiles(workspaceFolder.fsPath);
        for (const filePath of files) {
            await this.indexWorkspaceFile(URI.file(filePath).toString());
        }

        const elapsedMs = Date.now() - start;
        this.logger.info(
            `Finished parsing workspace CMake files: ${files.length} files in ${elapsedMs}ms (${workspaceFolder.fsPath})`
        );
    }

    private async collectWorkspaceCMakeFiles(rootPath: string): Promise<string[]> {
        const results: string[] = [];
        const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'cmake-build-debug', 'cmake-build-release']);

        const visit = async (dirPath: string): Promise<void> => {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isSymbolicLink()) {
                    continue;
                }
                if (entry.isDirectory()) {
                    if (ignoredDirectories.has(entry.name)) {
                        continue;
                    }
                    await visit(fullPath);
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                if (entry.name === 'CMakeLists.txt' || entry.name.endsWith('.cmake')) {
                    results.push(fullPath);
                }
            }
        };

        await visit(rootPath);
        return results;
    }

    private async indexWorkspaceFile(uri: string): Promise<void> {
        const text = await getFileContent(this.documents, URI.parse(uri));
        const parsedFile = this.parseCMakeFile({ uri, getText: () => text }, 'workspace index');
        this.storeParsedFileSnapshot(uri, parsedFile);
    }

    private storeParsedFileSnapshot(uri: string, parsedFile: ParsedCMakeFile) {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        this.fileContexts.set(uri, parsedFile.fileContext);
        this.tokenStreams.set(uri, parsedFile.tokenStream);
        this.flatCommandsMap.set(uri, parsedFile.flatCommands);

        const baseDir = URI.file(path.dirname(URI.parse(uri).fsPath));
        const fileSymbolCache = extractSymbols(uri, parsedFile.flatCommands, baseDir, workspaceState.symbolIndex);
        workspaceState.symbolIndex.setCache(uri, fileSymbolCache);

        const commentsChannel = CMakeLexer.channelNames.indexOf("COMMENTS");
        this.commentsMap.set(uri, parsedFile.tokenStream.tokens.filter(token => token.channel === commentsChannel));
    }

    private parseCMakeFile(
        document: Pick<TextDocument, 'uri' | 'getText'>,
        trigger: string,
        configureParser?: Parameters<typeof parseCMakeText>[1]
    ): ParsedCMakeFile {
        const start = Date.now();
        const parsedFile = parseCMakeText(document.getText(), configureParser);
        const elapsedMs = Date.now() - start;
        const tokenCount = Math.max(parsedFile.tokenStream.tokens.length - 1, 0);

        this.logger.info(
            `Parsed CMake file: ${document.uri} (trigger=${trigger}, duration=${elapsedMs}ms, commands=${parsedFile.flatCommands.length}, tokens=${tokenCount})`
        );

        return parsedFile;
    }

    private async parseAndStoreFileAsync(uri: string): Promise<ParsedCMakeFile> {
        const text = await getFileContent(this.documents, URI.parse(uri));
        const parsedFile = this.parseCMakeFile(
            { uri, getText: () => text },
            'on-demand cache miss'
        );
        this.storeParsedFileSnapshot(uri, parsedFile);
        return parsedFile;
    }

    private async ensureParsedFile(uri: string): Promise<void> {
        if (this.fileContexts.has(uri) && this.tokenStreams.has(uri) && this.flatCommandsMap.has(uri) && this.commentsMap.has(uri)) {
            return;
        }

        await this.parseAndStoreFileAsync(uri);
    }

    private async ensureDependencyIndexed(uri: string): Promise<void> {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        if (workspaceState.symbolIndex.getCache(uri)) {
            return;
        }

        if (workspaceState.symbolIndex.cmakeModulePath) {
            const hydrated = await hydrateBuiltinModuleCacheEntry({
                symbolIndex: workspaceState.symbolIndex,
                cmakePath: workspaceState.symbolIndex.cmakePath,
                cmakeVersion: workspaceState.symbolIndex.cmakeVersion,
                cmakeModulePath: workspaceState.symbolIndex.cmakeModulePath,
            }, uri);
            if (hydrated) {
                return;
            }
        }

        await this.ensureParsedFile(uri);
    }

    private async populateIndexTopDownAsync(uri: string, visited: Set<string>, token?: CancellationToken): Promise<void> {
        throwIfCancelled(token);
        if (visited.has(uri)) {
            return;
        }
        visited.add(uri);

        try {
            await this.ensureDependencyIndexed(uri);
            throwIfCancelled(token);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            this.logger.error(`Failed to parse dependency during completion: ${uri}`, error as Error);
            return;
        }

        const workspaceState = this.getWorkspaceStateForUri(uri);
        for (const dep of workspaceState.symbolIndex.getAvailableDependencies(uri)) {
            throwIfCancelled(token);
            await this.populateIndexTopDownAsync(dep.uri, visited, token);
        }
    }

    private async rebuildProjectTargetInfoForUri(docUri: string): Promise<ProjectTargetInfo> {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const projectRootCMake = Utils.joinPath(workspaceFolder, 'CMakeLists.txt');
        const entryCMake = fs.existsSync(projectRootCMake.fsPath)
            ? projectRootCMake.toString()
            : this.getEntryFilePath(docUri);
        await this.ensureParsedFile(entryCMake);
        const commands = this.getFlatCommands(entryCMake);
        const targetInfoListener = new ProjectTargetInfoListener(
            workspaceState.symbolIndex,
            entryCMake,
            workspaceFolder.fsPath,
            this.getFlatCommandsAsync.bind(this),
            new Set<string>(),
            workspaceFolder.fsPath,
        );
        await targetInfoListener.processCommands(commands);
        workspaceState.projectTargetInfo = targetInfoListener.targetInfo;
        workspaceState.projectTargetInfoDirty = false;
        return targetInfoListener.targetInfo;
    }

    private async getProjectTargetInfoForUri(docUri: string, entryUri?: string): Promise<ProjectTargetInfo> {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        if (workspaceState.projectTargetInfo && !workspaceState.projectTargetInfoDirty) {
            return workspaceState.projectTargetInfo;
        }

        if (entryUri) {
            const projectRootCMake = Utils.joinPath(workspaceFolder, 'CMakeLists.txt');
            if (!fs.existsSync(projectRootCMake.fsPath) && entryUri !== docUri) {
                await this.ensureParsedFile(entryUri);
                const commands = this.getFlatCommands(entryUri);
                const targetInfoListener = new ProjectTargetInfoListener(
                    workspaceState.symbolIndex,
                    entryUri,
                    workspaceFolder.fsPath,
                    this.getFlatCommandsAsync.bind(this),
                    new Set<string>(),
                    workspaceFolder.fsPath,
                );
                await targetInfoListener.processCommands(commands);
                workspaceState.projectTargetInfo = targetInfoListener.targetInfo;
                workspaceState.projectTargetInfoDirty = false;
                return targetInfoListener.targetInfo;
            }
        }

        return await this.rebuildProjectTargetInfoForUri(docUri);
    }

    private async getExtSettings(scopeUri?: string): Promise<ExtensionSettings> {
        const [
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            pkgConfigPath,
        ] = await this.connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath', scopeUri },
            { section: 'cmakeIntelliSence.loggingLevel', scopeUri },
            { section: 'cmakeIntelliSence.cmdCaseDiagnostics', scopeUri },
            { section: 'cmakeIntelliSence.pkgConfigPath', scopeUri },
        ]);

        return {
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            pkgConfigPath,
        };
    }

    private async initializeEnvironment(workspaceFolder: URI, settings?: ExtensionSettings): Promise<void> {
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const generation = ++workspaceState.environmentGeneration;
        workspaceState.extSettings = settings ?? await this.getExtSettings(workspaceFolder.toString());
        workspaceState.workspaceIndexing = undefined;
        workspaceState.projectTargetInfo = undefined;
        workspaceState.projectTargetInfoDirty = false;
        workspaceState.cmakeHelpCache.clear();
        const previousModulePath = workspaceState.symbolIndex.cmakeModulePath;
        if (previousModulePath) {
            workspaceState.symbolIndex.deleteCachesInDirectory(previousModulePath);
        }
        workspaceState.symbolIndex.clearBuiltinModuleCommandCatalog();
        try {
            await initializeCMakeEnvironment(workspaceState.extSettings, workspaceState.symbolIndex);
            if (workspaceState.symbolIndex.cmakeModulePath) {
                const catalog = await loadBuiltinModuleCommandCatalog({
                    symbolIndex: workspaceState.symbolIndex,
                    cmakePath: workspaceState.symbolIndex.cmakePath,
                    cmakeVersion: workspaceState.symbolIndex.cmakeVersion,
                    cmakeModulePath: workspaceState.symbolIndex.cmakeModulePath,
                });
                if (catalog.length > 0) {
                    this.logger.debug(`Loaded builtin module command catalog: commands=${catalog.length}`);
                }
            }
        } catch (e: any) {
            this.logger.error('Failed to initialize CMake environment', e instanceof Error ? e : new Error(String(e)));
            this.connection.window.showErrorMessage(e.message);
        }
        this.logger.setLevel(workspaceState.extSettings.loggingLevel);

        void this.warmBuiltinModuleCachesInBackground(workspaceState, generation);
    }

    private async warmBuiltinModuleCachesInBackground(workspaceState: WorkspaceState, generation: number): Promise<void> {
        const cmakeModulePath = workspaceState.symbolIndex.cmakeModulePath;
        if (!cmakeModulePath) {
            return;
        }

        try {
            const result = await warmBuiltinModuleCaches({
                symbolIndex: workspaceState.symbolIndex,
                cmakePath: workspaceState.symbolIndex.cmakePath,
                cmakeVersion: workspaceState.symbolIndex.cmakeVersion,
                cmakeModulePath,
                shouldCancel: () => generation !== workspaceState.environmentGeneration,
            });

            if (generation !== workspaceState.environmentGeneration) {
                return;
            }

            this.logger.debug(
                `Standard library warmup finished: loaded=${result.loadedFromCache}, indexed=${result.indexedFresh}`
            );
        } catch (error) {
            if (generation !== workspaceState.environmentGeneration) {
                return;
            }
            this.logger.warning(`Failed to warm standard library module cache: ${error}`);
        }
    }

    private async ensureEnvironmentInitialized(target?: string | URI): Promise<void> {
        const workspaceFolder = typeof target === 'string'
            ? this.getWorkspaceFolderForUri(target)
            : (target ?? this.getWorkspaceFolders()[0]);
        if (!workspaceFolder) {
            return;
        }

        const workspaceState = this.getWorkspaceState(workspaceFolder);
        if (workspaceState.environmentInitialization) {
            await workspaceState.environmentInitialization;
        }

        if (workspaceState.symbolIndex.getSystemCache().commands.size > 0) {
            return;
        }

        workspaceState.environmentInitialization = this.initializeEnvironment(workspaceFolder);
        await workspaceState.environmentInitialization;
    }

    private requireCachedValue<T>(cacheName: string, uri: string, value: T | undefined): T {
        if (value !== undefined) {
            return value;
        }

        throw new Error(`Missing ${cacheName} cache for ${uri}`);
    }

    public getFileContext(uri: string): FileContext {
        return this.requireCachedValue('fileContext', uri, this.fileContexts.get(uri));
    }

    public getTokenStream(uri: string): CommonTokenStream {
        return this.requireCachedValue('tokenStream', uri, this.tokenStreams.get(uri));
    }

    public getFlatCommands(uri: string): FlatCommand[] {
        return this.requireCachedValue('flatCommands', uri, this.flatCommandsMap.get(uri));
    }

    public async getFlatCommandsAsync(uri: string): Promise<FlatCommand[]> {
        await this.ensureParsedFile(uri);
        return this.getFlatCommands(uri);
    }

    private getComments(uri: string): Token[] {
        return this.requireCachedValue('comments', uri, this.commentsMap.get(uri));
    }

    private getCMakeHelp(workspaceState: WorkspaceState, helpArg: string, label: string, logErrors = false): Promise<string | null> {
        const cacheKey = `${helpArg}\0${label}`;
        const existing = workspaceState.cmakeHelpCache.get(cacheKey);
        if (existing) {
            return existing;
        }

        const request = execFilePromise(workspaceState.symbolIndex.cmakePath, [helpArg, label])
            .then(({ stdout }) => rstToMarkdown(stdout))
            .catch((error: ExecFileFailure) => {
                if (logErrors) {
                    this.logger.error(`Failed to get help for ${label}: ${error.stderr ?? ''}`);
                }
                workspaceState.cmakeHelpCache.delete(cacheKey);
                return null;
            });

        workspaceState.cmakeHelpCache.set(cacheKey, request);
        return request;
    }
}

new CMakeLanguageServer();
