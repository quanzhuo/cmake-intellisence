import { CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { Range, TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { CodeAction, Command, CompletionItem, CompletionList, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, SignatureHelp, SymbolInformation } from 'vscode-languageserver-types';
import { CancellationToken, CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, ReferenceParams, RenameParams, SemanticTokensDeltaParams, SemanticTokensParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, WorkspaceEdit, WorkspaceSymbolParams, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import { ArgumentSemanticKind, DefinitionSubject, resolveCursorTarget } from './argumentSemantics';
import { loadBuiltinModuleCommandCatalog, warmBuiltinModuleCaches } from './builtinModuleIndex';
import { isCancellationError, throwIfCancelled } from './cancellation';
import { CMakeCacheEntriesByName, getCacheEntryByName, loadCMakeCacheEntries } from './cmakeCache';
import { BuiltinEntriesLoadStats, ExtensionSettings, ProjectTargetInfoListener, initializeCMakeEnvironment } from './cmakeEnvironment';
import { CONFIGURATION_SECTION, LEGACY_CONFIGURATION_SECTION, resolveExtensionSettings } from './config';
import Completion, { CMakeCompletionType, CompletionItemType, ProjectTargetInfo, findCommandAtPosition, findRecoveredCommandInfoAtPosition, getCompletionHelpLabel, getCompletionInfoAtCursor, getCompletionItemType, getCompletionWorkspaceKey, inComments } from './completion';
import { DefinitionResolver } from './definition';
import SemanticDiagnosticsListener, { CommandCaseChecker, DIAG_CODE_CMD_CASE, SyntaxErrorListener } from './diagnostics';
import { DocumentLinkInfo } from './docLink';
import { loadFileApiRawSnapshot } from './fileApiLoader';
import { SymbolListener } from './docSymbols';
import { FileApiCacheEntrySnapshot, FileApiRawSnapshot } from './fileApiSnapshot';
import { FlatCommand } from './flatCommands';
import { Formatter } from './format';
import CMakeLexer from './generated/CMakeLexer';
import { FileContext } from './generated/CMakeParser';
import localize, { localizeInitializer } from './localize';
import { Logger, createLogger } from './logging';
import { ExecFileFailure, execFilePromise } from './processUtils';
import { PathDiagnosticsProvider } from './pathDiagnostics';
import { ReferenceResolver } from './references';
import { RenameResolver } from './rename';
import { rstToMarkdown } from './rstToMarkdown';
import { SemanticTokenListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import { buildSignatureHelp, buildSignatureHelpForInvocation } from './signatureHelp';
import { extractSymbols } from './symbolExtractor';
import { SymbolIndex } from './symbolIndex';
import { populateIndexTopDown } from './symbolIndexManager';
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, CMakeToolsProjectSnapshot, CMakeToolsProjectSnapshotNotificationParams, READY_NOTIFICATION } from './cmakeToolsSnapshot';
import { PathExpressionResolver } from './pathExpressionResolver';
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
    cmakeToolsProjectSnapshot?: CMakeToolsProjectSnapshot;
    fileApiRawSnapshot?: FileApiRawSnapshot;
    cmakeCacheEntriesByName?: CMakeCacheEntriesByName;
    cmakeCacheBuildDirectory?: string;
    projectTargetInfo?: ProjectTargetInfo;
    projectTargetInfoDirty: boolean;
    projectTargetInfoVersion: number;
    projectTargetInfoBuild?: Promise<ProjectTargetInfo>;
    workspaceIndexing?: Promise<void>;
    workspaceIndexingGeneration?: number;
    workspaceIndexedGeneration?: number;
    cmakeHelpCache: Map<string, HelpCacheEntry>;
    environmentInitialization?: Promise<void>;
    environmentGeneration: number;
    environmentReady: boolean;
    extSettings: ExtensionSettings;
};

type HelpCacheEntry = {
    request: Promise<string | null>;
    expiresAt?: number;
};

const CMAKE_HELP_NULL_CACHE_TTL_MS = 5 * 60 * 1000;
const DIAGNOSTICS_DEBOUNCE_MS = 220;
const TARGET_INFO_STRUCTURE_COMMANDS = new Set([
    'add_executable',
    'add_library',
    'target_sources',
    'find_package',
    'include',
    'add_subdirectory',
    'set',
    'option',
]);

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
    private parsedFileRequestsByUri: Map<string, Promise<ParsedCMakeFile>> = new Map();
    private parsedDocumentVersionsByUri: Map<string, number> = new Map();
    private workspaceStates: Map<string, WorkspaceState> = new Map();
    private logger: Logger = createLogger('cmake-intelli', 'off');
    private diagnosticsTimerByUri: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private diagnosticsSequenceByUri: Map<string, number> = new Map();
    private targetInfoStructureFingerprintByUri: Map<string, string> = new Map();
    private diagnosticsRescheduledCount = 0;
    private diagnosticsDroppedStaleSequenceCount = 0;
    private diagnosticsDroppedStaleVersionCount = 0;
    private diagnosticsPublishedCount = 0;
    private targetInfoForegroundRebuildCount = 0;
    private targetInfoBackgroundRebuildCount = 0;

    private readonly defaultExtSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
        workspaceIgnoreDirectories: ['.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'cmake-build-debug', 'cmake-build-release'],
        enableCMakeToolsIntegration: true,
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
            this.connection.onNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, this.wrapNotification('cmakeToolsProjectSnapshotChanged', this.onCMakeToolsProjectSnapshotChanged.bind(this))),
            this.connection.onDocumentLinks(this.wrapRequest('documentLinks', this.onDocumentLinks.bind(this), null)),
            this.connection.onShutdown(this.wrapNotification('shutdown', this.onShutdown.bind(this))),
            this.connection.languages.semanticTokens.on(this.wrapRequest('semanticTokens', this.onSemanticTokens.bind(this), { data: [] })),
            this.connection.languages.semanticTokens.onDelta(this.wrapRequest('semanticTokensDelta', this.onSemanticTokensDelta.bind(this), { edits: [] })),
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
            projectTargetInfoVersion: 0,
            cmakeHelpCache: new Map<string, HelpCacheEntry>(),
            environmentGeneration: 0,
            environmentReady: false,
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
                textDocumentSync: TextDocumentSyncKind.Full,
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
        const workspaceFolders = this.getWorkspaceFolders();
        const initializationStart = Date.now();
        const initializationResults = await Promise.allSettled(workspaceFolders.map(folder => this.ensureEnvironmentInitialized(folder)));
        const failedWorkspaceFolders: string[] = [];
        initializationResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                return;
            }

            const failedFolder = workspaceFolders[index];
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            failedWorkspaceFolders.push(failedFolder.fsPath);
            this.logger.error(`Failed to initialize workspace folder ${failedFolder.fsPath}: ${message}`);
        });

        if (failedWorkspaceFolders.length > 0) {
            this.connection.window.showWarningMessage(`CMake environment initialization failed for ${failedWorkspaceFolders.length} workspace folder(s). Check output logs for details.`);
        }

        this.logger.debug(`Initial environment initialization finished in ${Date.now() - initializationStart}ms for ${workspaceFolders.length} workspace folder(s)`);

        // The server is ready to handle requests as soon as the CMake environment is
        // initialized. Workspace file indexing is kicked off in the background; individual
        // LSP request handlers (hover, completion, …) will wait for it via
        // ensureWorkspaceIndexedForUri when they first need the workspace symbol index.
        this.connection.sendNotification(READY_NOTIFICATION);

        const workspaceIndexStart = Date.now();
        void this.ensureAllWorkspaceFoldersIndexed()
            .then(() => {
                this.logger.debug(`Initial workspace indexing finished in ${Date.now() - workspaceIndexStart}ms`);
            })
            .catch((error: unknown) => {
                this.logger.error('Initial workspace indexing failed', error instanceof Error ? error : new Error(String(error)));
            });
    }

    private async onCMakeToolsProjectSnapshotChanged(params: CMakeToolsProjectSnapshotNotificationParams): Promise<void> {
        const startedAt = Date.now();
        const workspaceFolder = URI.parse(params.workspaceFolderUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const previousSnapshot = workspaceState.cmakeToolsProjectSnapshot;
        const previousFileApiRawSnapshot = workspaceState.fileApiRawSnapshot;
        const nextSnapshot = params.snapshot ?? undefined;
        workspaceState.cmakeToolsProjectSnapshot = nextSnapshot;
        if (this.shouldResetFileApiRawSnapshot(previousSnapshot, nextSnapshot)) {
            workspaceState.fileApiRawSnapshot = undefined;
        }

        if (nextSnapshot?.buildDirectory) {
            const fileApiLoadStart = Date.now();
            try {
                workspaceState.fileApiRawSnapshot = loadFileApiRawSnapshot(nextSnapshot.buildDirectory) ?? undefined;
                this.logger.debug(`Loaded File API snapshot for ${workspaceFolder.fsPath} in ${Date.now() - fileApiLoadStart}ms`);
            } catch (error) {
                workspaceState.fileApiRawSnapshot = undefined;
                this.logger.debug(`Failed to load File API snapshot for ${workspaceFolder.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const cmakeCacheLoadStart = Date.now();
        workspaceState.cmakeCacheEntriesByName = nextSnapshot?.buildDirectory
            ? await loadCMakeCacheEntries(nextSnapshot.buildDirectory)
            : undefined;
        workspaceState.cmakeCacheBuildDirectory = nextSnapshot?.buildDirectory;
        this.logger.debug(`Loaded CMake cache snapshot for ${workspaceFolder.fsPath} in ${Date.now() - cmakeCacheLoadStart}ms`);

        if (this.didFileApiRawSnapshotChange(previousFileApiRawSnapshot, workspaceState.fileApiRawSnapshot)) {
            const diagnosticsRefreshStart = Date.now();
            await this.refreshOpenDocumentDiagnosticsForWorkspace(workspaceFolder);
            this.logger.debug(`Refreshed open-document diagnostics for ${workspaceFolder.fsPath} in ${Date.now() - diagnosticsRefreshStart}ms after snapshot change`);
        }

        this.logger.debug(`Processed CMake Tools snapshot update for ${workspaceFolder.fsPath} in ${Date.now() - startedAt}ms`);
        this.logger.debug(`Updated CMake Tools snapshot for ${workspaceFolder.fsPath}`, JSON.stringify(params.snapshot));
    }

    private shouldResetFileApiRawSnapshot(
        previousSnapshot?: CMakeToolsProjectSnapshot,
        nextSnapshot?: CMakeToolsProjectSnapshot,
    ): boolean {
        if (!previousSnapshot || !nextSnapshot) {
            return previousSnapshot !== nextSnapshot;
        }

        return previousSnapshot.projectId !== nextSnapshot.projectId
            || previousSnapshot.buildDirectory !== nextSnapshot.buildDirectory
            || previousSnapshot.generation !== nextSnapshot.generation;
    }

    private didFileApiRawSnapshotChange(
        previousSnapshot?: FileApiRawSnapshot,
        nextSnapshot?: FileApiRawSnapshot,
    ): boolean {
        if (!previousSnapshot || !nextSnapshot) {
            return previousSnapshot !== nextSnapshot;
        }

        return previousSnapshot.replyDirectory !== nextSnapshot.replyDirectory
            || previousSnapshot.indexFile !== nextSnapshot.indexFile
            || previousSnapshot.indexMtimeMs !== nextSnapshot.indexMtimeMs;
    }

    private async onHover(params: HoverParams, token: CancellationToken): Promise<Hover | null> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureEnvironmentInitialized(params.textDocument.uri);
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
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }
        let word = getWordAtPosition(document, params.position).text;
        if (word.length === 0) {
            return null;
        }

        await this.ensureWorkspaceCacheEntriesLoaded(workspaceState);
        if (hoveredCommand === null && recoveredCommandName === null) {
            return this.getCacheVariableHover(workspaceState, word);
        }

        const commandToken: Token | null = hoveredCommand?.ID().symbol ?? null;
        const commandName = (hoveredCommand?.ID().symbol.text ?? recoveredCommandName ?? '').toLowerCase();

        let arg = '', category = '';
        const systemCache = workspaceState.symbolIndex.getSystemCache();
        const hoveredVariableName = this.getHoveredVariableName(params, hoveredCommand, word);
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
                    return this.getCacheVariableHover(workspaceState, hoveredVariableName);
                }

                return {
                    contents: {
                        kind: 'markdown',
                        value: category === 'variable'
                            ? this.appendCacheEntryDetails(stdout, workspaceState, hoveredVariableName)
                            : stdout,
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
                                value: category === 'variable'
                                    ? this.appendCacheEntryDetails(modifiedStdout, workspaceState, hoveredVariableName)
                                    : modifiedStdout,
                            }
                        };
                    }
                    return this.getCacheVariableHover(workspaceState, hoveredVariableName);
                }

                this.logger.debug(`Hover help lookup failed for ${category || 'unknown'} ${word}: ${error instanceof Error ? error.message : String(error)}`);
                const cacheHover = this.getCacheVariableHover(workspaceState, hoveredVariableName);
                if (cacheHover) {
                    return cacheHover;
                }

                const filePathHover = await this.getResolvedFileHover(params, workspaceState, hoveredCommand, word, token);
                if (filePathHover) {
                    return filePathHover;
                }

                return this.getSnapshotEntityHover(params, workspaceState, hoveredCommand, word);
            }
        }

        const cacheHover = this.getCacheVariableHover(workspaceState, hoveredVariableName);
        if (cacheHover) {
            return cacheHover;
        }

        const filePathHover = await this.getResolvedFileHover(params, workspaceState, hoveredCommand, word, token);
        if (filePathHover) {
            return filePathHover;
        }

        return this.getSnapshotEntityHover(params, workspaceState, hoveredCommand, word);
    }

    private isPathInsideDirectory(parentPath: string, childPath: string): boolean {
        const relativePath = path.relative(path.normalize(parentPath), path.normalize(childPath));
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    private async getResolvedFileHover(
        params: HoverParams,
        workspaceState: WorkspaceState,
        hoveredCommand: FlatCommand | null,
        word: string,
        token: CancellationToken,
    ): Promise<Hover | null> {
        if (!hoveredCommand) {
            return null;
        }

        const cursorTarget = resolveCursorTarget(hoveredCommand, word, params.position);
        if (cursorTarget.semanticKind !== ArgumentSemanticKind.FilePath || !cursorTarget.argumentSpan) {
            return null;
        }

        const snapshot = workspaceState.cmakeToolsProjectSnapshot;
        const resolver = new PathExpressionResolver({
            symbolIndex: workspaceState.symbolIndex,
            getFlatCommands: this.getFlatCommandsAsync.bind(this),
            entryFile: URI.parse(this.getEntryFilePath(params.textDocument.uri)),
            buildDirectory: snapshot?.buildDirectory,
            buildDirectoriesBySourcePath: workspaceState.fileApiRawSnapshot?.buildDirectoriesBySourcePath,
        });

        throwIfCancelled(token);
        const resolution = await resolver.resolveFileRequestDetailed({
            commandName: hoveredCommand.commandName,
            argText: cursorTarget.argumentSpan.text,
            sourceUri: URI.parse(params.textDocument.uri),
            maxLine: params.position.line,
        });
        throwIfCancelled(token);

        const resolvedUri = resolution.exactCandidates[0];
        if (!resolvedUri) {
            return null;
        }

        const details = [
            this.formatHoverLine('hover.file.name', path.basename(resolvedUri.fsPath)),
            this.formatHoverLine('hover.file.resolvedPath', resolvedUri.fsPath),
        ];
        if (snapshot?.buildDirectory && this.isPathInsideDirectory(snapshot.buildDirectory, resolvedUri.fsPath)) {
            details.push(this.formatHoverBooleanLine('hover.file.inBuildDirectory', true));
        }

        return {
            contents: {
                kind: 'markdown',
                value: details.join('  \n'),
            }
        };
    }

    private getHoveredVariableName(
        params: HoverParams,
        hoveredCommand: FlatCommand | null,
        word: string,
    ): string | null {
        if (hoveredCommand) {
            const cursorTarget = resolveCursorTarget(hoveredCommand, word, params.position);
            if (cursorTarget.subject === DefinitionSubject.Variable && cursorTarget.text.length !== 0) {
                return cursorTarget.text;
            }
        }

        return word.length !== 0 ? word : null;
    }

    private async ensureWorkspaceCacheEntriesLoaded(workspaceState: WorkspaceState): Promise<void> {
        const buildDirectory = workspaceState.cmakeToolsProjectSnapshot?.buildDirectory;
        if (!buildDirectory) {
            workspaceState.cmakeCacheEntriesByName = undefined;
            workspaceState.cmakeCacheBuildDirectory = undefined;
            return;
        }

        if (workspaceState.cmakeCacheEntriesByName !== undefined && workspaceState.cmakeCacheBuildDirectory === buildDirectory) {
            return;
        }

        workspaceState.cmakeCacheEntriesByName = await loadCMakeCacheEntries(buildDirectory);
        workspaceState.cmakeCacheBuildDirectory = buildDirectory;
    }

    private getWorkspaceCacheEntry(
        workspaceState: WorkspaceState,
        variableName: string | null,
    ): FileApiCacheEntrySnapshot | null {
        if (!variableName) {
            return null;
        }

        const fileApiEntry = getCacheEntryByName(workspaceState.fileApiRawSnapshot?.cacheEntriesByName, variableName);
        if (fileApiEntry) {
            return fileApiEntry;
        }

        const cmakeCacheEntry = getCacheEntryByName(workspaceState.cmakeCacheEntriesByName, variableName);
        if (cmakeCacheEntry) {
            return cmakeCacheEntry;
        }

        return null;
    }

    private escapeMarkdownText(value: string): string {
        return value.replace(/([`*_{}\[\]()#+!|])/g, '\\$1');
    }

    private formatHoverLine(key: string, value: string | number): string {
        return localize(key, this.escapeMarkdownText(String(value)));
    }

    private formatHoverBooleanLine(key: string, value: boolean): string {
        return localize(key, localize(value ? 'common.yes' : 'common.no'));
    }

    private formatHoverAvailabilityLine(key: string, value: boolean): string {
        return localize(key, localize(value ? 'common.available' : 'common.unavailable'));
    }

    private toMarkdownCodeBlock(value: string): string {
        let fence = '```';
        while (value.includes(fence)) {
            fence += '`';
        }

        return `${fence}text\n${value}\n${fence}`;
    }

    private renderCacheEntryMarkdown(workspaceState: WorkspaceState, variableName: string | null): string | null {
        const cacheEntry = this.getWorkspaceCacheEntry(workspaceState, variableName);
        if (!cacheEntry || !variableName) {
            return null;
        }

        const metadata: string[] = [];

        if (cacheEntry.type) {
            metadata.push(this.formatHoverLine('hover.cache.type', cacheEntry.type));
        }
        if (cacheEntry.help) {
            metadata.push(this.formatHoverLine('hover.cache.help', cacheEntry.help));
        }

        const blocks = [this.formatHoverLine('hover.cache.variable', variableName)];

        if (cacheEntry.value !== undefined) {
            blocks.push(`${localize('hover.cache.valueHeading')}\n\n${this.toMarkdownCodeBlock(cacheEntry.value)}`);
        }

        if (metadata.length !== 0) {
            blocks.push('---');
            blocks.push(metadata.join('\n'));
        }
        blocks.push(localize('hover.cache.note'));

        return blocks.join('\n\n');
    }

    private appendCacheEntryDetails(markdown: string, workspaceState: WorkspaceState, variableName: string | null): string {
        const cacheMarkdown = this.renderCacheEntryMarkdown(workspaceState, variableName);
        if (!cacheMarkdown) {
            return markdown;
        }

        return `${markdown}\n\n---\n\n${cacheMarkdown}`;
    }

    private getCacheVariableHover(workspaceState: WorkspaceState, variableName: string | null): Hover | null {
        const cacheMarkdown = this.renderCacheEntryMarkdown(workspaceState, variableName);
        if (!cacheMarkdown) {
            return null;
        }

        return { contents: { kind: 'markdown', value: cacheMarkdown } };
    }

    private getSnapshotEntityHover(
        _params: HoverParams,
        workspaceState: WorkspaceState,
        hoveredCommand: FlatCommand | null,
        word: string,
    ): Hover | null {
        if (!hoveredCommand) {
            return null;
        }

        const cursorTarget = resolveCursorTarget(hoveredCommand, word, _params.position);
        if (cursorTarget.text.length === 0) {
            return null;
        }

        const snapshot = workspaceState.cmakeToolsProjectSnapshot;
        if (!snapshot) {
            return null;
        }

        let entityLabel: string | null = null;
        let extraDetails: string[] = [];
        if (cursorTarget.semanticKind === ArgumentSemanticKind.Target && snapshot.targetNames.includes(cursorTarget.text)) {
            entityLabel = this.formatHoverLine('hover.entity.target', cursorTarget.text);
        } else if (cursorTarget.semanticKind === ArgumentSemanticKind.Test && snapshot.testNames.includes(cursorTarget.text)) {
            entityLabel = this.formatHoverLine('hover.entity.test', cursorTarget.text);
        } else if (cursorTarget.semanticKind === ArgumentSemanticKind.FindPackage) {
            const cacheEntry = workspaceState.fileApiRawSnapshot?.cacheEntriesByName[`${cursorTarget.text}_DIR`];
            if (cacheEntry) {
                entityLabel = this.formatHoverLine('hover.entity.package', cursorTarget.text);
                if (cacheEntry.type) {
                    extraDetails.push(this.formatHoverLine('hover.entity.cacheType', cacheEntry.type));
                }
                if (cacheEntry.value) {
                    extraDetails.push(this.formatHoverLine('hover.entity.packageDirectory', cacheEntry.value));
                }
                if (cacheEntry.help) {
                    extraDetails.push(this.formatHoverLine('hover.entity.cacheHelp', cacheEntry.help));
                }
            }
        } else if (cursorTarget.semanticKind === ArgumentSemanticKind.IncludeModule) {
            const moduleFileName = `${cursorTarget.text}.cmake`.toLowerCase();
            const matchedInput = workspaceState.fileApiRawSnapshot?.cmakeInputs.find((input) => {
                return path.isAbsolute(input.path)
                    && path.extname(input.path).toLowerCase() === '.cmake'
                    && path.basename(input.path).toLowerCase() === moduleFileName;
            });
            if (matchedInput) {
                entityLabel = this.formatHoverLine('hover.entity.module', cursorTarget.text);
                extraDetails.push(this.formatHoverLine('hover.entity.modulePath', matchedInput.path));
                if (matchedInput.isExternal !== undefined) {
                    extraDetails.push(this.formatHoverBooleanLine('hover.entity.externalInput', matchedInput.isExternal));
                }
                if (matchedInput.isGenerated !== undefined) {
                    extraDetails.push(this.formatHoverBooleanLine('hover.entity.generatedInput', matchedInput.isGenerated));
                }
            }
        }

        if (!entityLabel) {
            return null;
        }

        const details = [entityLabel, ...extraDetails];
        if (cursorTarget.semanticKind === ArgumentSemanticKind.Target) {
            const targetSnapshot = workspaceState.fileApiRawSnapshot?.targetsByName[cursorTarget.text];
            const toolchainSnapshot = workspaceState.fileApiRawSnapshot
                ? workspaceState.fileApiRawSnapshot.toolchainsByLanguage.CXX
                ?? workspaceState.fileApiRawSnapshot.toolchainsByLanguage.C
                ?? Object.values(workspaceState.fileApiRawSnapshot.toolchainsByLanguage)[0]
                : undefined;
            const targetFlags: string[] = [];
            if (targetSnapshot?.type) {
                details.push(this.formatHoverLine('hover.entity.fileApiType', targetSnapshot.type));
            }
            if (targetSnapshot?.imported) {
                targetFlags.push('IMPORTED');
            }
            if (targetSnapshot?.abstract) {
                targetFlags.push('ABSTRACT');
            }
            if (targetSnapshot?.symbolic) {
                targetFlags.push('SYMBOLIC');
            }
            if (targetSnapshot?.isGeneratorProvided) {
                targetFlags.push('GENERATOR_PROVIDED');
            }
            if (targetFlags.length) {
                details.push(this.formatHoverLine('hover.entity.targetProperties', targetFlags.join(', ')));
            }
            if (targetSnapshot?.folderName) {
                details.push(this.formatHoverLine('hover.entity.folderGroup', targetSnapshot.folderName));
            }
            if (targetSnapshot?.nameOnDisk) {
                details.push(this.formatHoverLine('hover.entity.onDiskName', targetSnapshot.nameOnDisk));
            }
            if (targetSnapshot?.generatedSourcePaths?.length) {
                details.push(this.formatHoverLine('hover.entity.generatedSources', targetSnapshot.generatedSourcePaths.length));
            }
            if (targetSnapshot?.includeDirectories?.length) {
                details.push(this.formatHoverLine('hover.entity.includeDirectories', targetSnapshot.includeDirectories.join(', ')));
            }
            if (targetSnapshot?.artifactPaths?.length) {
                details.push(this.formatHoverLine('hover.entity.artifacts', targetSnapshot.artifactPaths.join(', ')));
            }
            if (targetSnapshot?.compileDefinitions?.length) {
                details.push(this.formatHoverLine('hover.entity.compileDefinitions', targetSnapshot.compileDefinitions.join(', ')));
            }
            if (targetSnapshot?.backtraceFiles?.length) {
                details.push(this.formatHoverLine('hover.entity.backtraceFiles', targetSnapshot.backtraceFiles.join(', ')));
            }
            if (targetSnapshot?.backtraceCommands?.length) {
                details.push(this.formatHoverLine('hover.entity.backtraceCommands', targetSnapshot.backtraceCommands.join(', ')));
            }
            if (targetSnapshot?.dependencyIds?.length) {
                details.push(this.formatHoverLine('hover.entity.dependencyCount', targetSnapshot.dependencyIds.length));
            }
            if (toolchainSnapshot?.compilerId || toolchainSnapshot?.compilerVersion) {
                details.push(this.formatHoverLine('hover.entity.toolchain', `${toolchainSnapshot.language} ${toolchainSnapshot.compilerId ?? localize('common.unknown')} ${toolchainSnapshot.compilerVersion ?? ''}`.trim()));
            }
            if (toolchainSnapshot?.compilerCommandFragment) {
                details.push(this.formatHoverLine('hover.entity.compilerArgs', toolchainSnapshot.compilerCommandFragment));
            }
            if (toolchainSnapshot?.implicitIncludeDirectories?.length) {
                details.push(this.formatHoverLine('hover.entity.implicitIncludeDirectories', toolchainSnapshot.implicitIncludeDirectories.join(', ')));
            }
            if (toolchainSnapshot?.implicitLinkDirectories?.length) {
                details.push(this.formatHoverLine('hover.entity.implicitLinkDirectories', toolchainSnapshot.implicitLinkDirectories.join(', ')));
            }
            if (toolchainSnapshot?.implicitLinkLibraries?.length) {
                details.push(this.formatHoverLine('hover.entity.implicitLinkLibraries', toolchainSnapshot.implicitLinkLibraries.join(', ')));
            }
        }

        details.push(this.formatHoverBooleanLine('hover.entity.usePresets', snapshot.useCMakePresets));

        if (snapshot.codeModelSummary) {
            details.push(this.formatHoverAvailabilityLine('hover.entity.codeModel', snapshot.codeModelSummary.hasCodeModel));
        }

        if (snapshot.activeBuildType) {
            details.push(this.formatHoverLine('hover.entity.buildType', snapshot.activeBuildType));
        }

        if (snapshot.buildDirectory) {
            details.push(this.formatHoverLine('hover.entity.buildDirectory', snapshot.buildDirectory));
        }

        if (snapshot.configurePresetName) {
            details.push(this.formatHoverLine('hover.entity.configurePreset', snapshot.configurePresetName));
        }

        if (snapshot.buildPresetName) {
            details.push(this.formatHoverLine('hover.entity.buildPreset', snapshot.buildPresetName));
        }

        if (snapshot.testPresetName) {
            details.push(this.formatHoverLine('hover.entity.testPreset', snapshot.testPresetName));
        }

        if (snapshot.packagePresetName) {
            details.push(this.formatHoverLine('hover.entity.packagePreset', snapshot.packagePresetName));
        }

        return {
            contents: {
                kind: 'markdown',
                value: details.join('  \n'),
            }
        };
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
        // Ensure the parse tree is current for the latest document version. Without this,
        // FlatCommand token positions (especially RP) may be stale when the user edits the
        // document and immediately triggers completion before the diagnostics debounce timer
        // has re-parsed the file.
        await this.ensureParsedFile(params.textDocument.uri);
        throwIfCancelled(token);
        // Do NOT await full workspace indexing or dependency-graph resolution here.
        // Built-in symbols (commands, variables, modules, etc.) are always available
        // from the system cache, so completions work immediately. Workspace-level
        // symbols (user-defined variables, targets) are populated progressively by
        // background workspace indexing — no need for a separate fire-and-forget
        // dependency walk that would compete with the indexer and re-parse files
        // that diagnostics already cached without symbols.

        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        const entryFileSource = this.getEntryFilePath(params.textDocument.uri);

        const word = getWordAtPosition(document, params.position).text;
        const targetInfo = this.getProjectTargetInfoForCompletion(params.textDocument.uri, entryFileSource);
        throwIfCancelled(token);
        const snapshotTargetNames = workspaceState.cmakeToolsProjectSnapshot?.targetNames ?? [];
        const snapshotTestNames = workspaceState.cmakeToolsProjectSnapshot?.testNames ?? [];
        const completion = new Completion(
            this.flatCommandsMap,
            this.tokenStreams,
            targetInfo,
            word,
            this.logger,
            workspaceState.symbolIndex,
            params.textDocument.uri,
            entryFileSource,
            workspaceState.workspaceFolder.toString(),
            snapshotTargetNames,
            snapshotTestNames,
        );
        const startCompletion = Date.now();
        const result = await completion.onCompletion(params);
        const elapsed = Date.now() - startCompletion;
        const itemCount = Array.isArray(result) ? result.length : result?.items?.length ?? 0;
        const isIncomplete = !Array.isArray(result) && result?.isIncomplete ? ' (incomplete)' : '';
        this.logger.debug(
            `Completion returned ${itemCount} item(s)${isIncomplete} in ${elapsed}ms for ${params.textDocument.uri} (word="${word}", line=${params.position.line}, col=${params.position.character})`
        );
        return result;
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
            workspaceState.fileApiRawSnapshot,
            workspaceState.cmakeToolsProjectSnapshot?.buildDirectory,
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
            const environmentChanged = extSettings.cmakePath !== workspaceState.extSettings.cmakePath
                || extSettings.pkgConfigPath !== workspaceState.extSettings.pkgConfigPath;
            const workspaceIgnoreDirectoriesChanged = !this.haveSameStringEntries(
                this.getWorkspaceIgnoreDirectories(workspaceState.extSettings),
                this.getWorkspaceIgnoreDirectories(extSettings),
            );

            if (environmentChanged) {
                await this.startEnvironmentInitialization(folder, extSettings);
                this.clearWorkspaceFolderSnapshots(folder);
                await this.ensureWorkspaceFolderIndexed(folder);
                return;
            }
            workspaceState.extSettings = extSettings;
            this.logger.setLevel(extSettings.loggingLevel);

            if (workspaceIgnoreDirectoriesChanged) {
                this.clearWorkspaceFolderSnapshots(folder);
                await this.ensureWorkspaceFolderIndexed(folder);
            }
        }));
    }

    /**
     * The content of a text document has changed. This event is emitted
     *  when the text document first opened or when its content has changed.
     * 
     * @param event 
     */
    private async onDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
        this.scheduleDiagnosticsForDocument(event.document);
    }

    private scheduleDiagnosticsForDocument(document: TextDocument): void {
        const uri = document.uri;
        const existingTimer = this.diagnosticsTimerByUri.get(uri);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.diagnosticsRescheduledCount++;
        }

        const sequence = (this.diagnosticsSequenceByUri.get(uri) ?? 0) + 1;
        this.diagnosticsSequenceByUri.set(uri, sequence);
        const timer = setTimeout(() => {
            void this.runScheduledDiagnostics(uri, sequence);
        }, DIAGNOSTICS_DEBOUNCE_MS);
        this.diagnosticsTimerByUri.set(uri, timer);
    }

    private async runScheduledDiagnostics(uri: string, sequence: number): Promise<void> {
        if (this.diagnosticsSequenceByUri.get(uri) !== sequence) {
            this.diagnosticsDroppedStaleSequenceCount++;
            return;
        }
        this.diagnosticsTimerByUri.delete(uri);

        const document = this.documents.get(uri);
        if (!document) {
            return;
        }

        await this.publishDiagnosticsForDocument(document, sequence);
    }

    private computeTargetInfoStructureFingerprint(flatCommands: FlatCommand[]): string {
        const parts: string[] = [];
        for (const command of flatCommands) {
            const commandName = command.commandName.toLowerCase();
            if (!TARGET_INFO_STRUCTURE_COMMANDS.has(commandName)) {
                continue;
            }

            const args = command.argument_list().map(arg => arg.getText()).join('\u001f');
            parts.push(`${commandName}\u001e${args}`);
        }

        return parts.join('\u001d');
    }

    private updateTargetInfoStructureFingerprint(uri: string, flatCommands: FlatCommand[], markDirtyOnChange: boolean): void {
        const nextFingerprint = this.computeTargetInfoStructureFingerprint(flatCommands);
        const previousFingerprint = this.targetInfoStructureFingerprintByUri.get(uri);
        if (markDirtyOnChange && previousFingerprint !== undefined && previousFingerprint !== nextFingerprint) {
            this.markProjectTargetInfoDirty(uri);
        }

        this.targetInfoStructureFingerprintByUri.set(uri, nextFingerprint);
    }

    private async publishDiagnosticsForDocument(document: TextDocument, expectedSequence?: number): Promise<void> {
        const diagnosticsStart = Date.now();
        const startVersion = document.version;
        if (expectedSequence !== undefined && this.diagnosticsSequenceByUri.get(document.uri) !== expectedSequence) {
            this.diagnosticsDroppedStaleSequenceCount++;
            return;
        }

        const workspaceState = this.getWorkspaceStateForUri(document.uri);
        const ensureEnvironmentStart = Date.now();
        await this.ensureEnvironmentInitialized(document.uri);
        this.logger.debug(`Diagnostics environment check finished for ${document.uri} in ${Date.now() - ensureEnvironmentStart}ms`);

        const syntaxErrorListener = new SyntaxErrorListener();
        const parsedFile = this.parseCMakeFile(document, 'document change', parser => {
            parser.removeErrorListeners();
            parser.addErrorListener(syntaxErrorListener);
        });
        const { fileContext, flatCommands } = parsedFile;
        this.updateTargetInfoStructureFingerprint(document.uri, flatCommands, true);
        // Store parsed snapshot but skip recursive symbol extraction so that
        // diagnostics return quickly. The symbolIndex is populated by background
        // workspace indexing and does not need to block syntax/semantic checking.
        await this.storeParsedFileSnapshot(document.uri, parsedFile, undefined, true);

        const semanticListener = new SemanticDiagnosticsListener();
        ParseTreeWalker.DEFAULT.walk(semanticListener, fileContext);

        const pathDiagnosticsProvider = new PathDiagnosticsProvider({
            symbolIndex: workspaceState.symbolIndex,
            entryFile: URI.parse(this.getEntryFilePath(document.uri)),
            sourceUri: URI.parse(document.uri),
            getFlatCommands: this.getFlatCommandsAsync.bind(this),
            fileApiRawSnapshot: workspaceState.fileApiRawSnapshot,
            buildDirectory: workspaceState.cmakeToolsProjectSnapshot?.buildDirectory,
        });
        const pathDiagnosticsStart = Date.now();
        const pathDiagnostics = await pathDiagnosticsProvider.getDiagnostics(flatCommands);
        this.logger.debug(`Path diagnostics finished for ${document.uri} in ${Date.now() - pathDiagnosticsStart}ms with ${pathDiagnostics.length} item(s)`);

        const diagnostics = {
            uri: document.uri,
            diagnostics: [
                ...syntaxErrorListener.getSyntaxErrors(),
                ...semanticListener.getSemanticDiagnostics(),
                ...pathDiagnostics,
            ]
        };

        if (workspaceState.extSettings.cmdCaseDiagnostics) {
            const cmdCaseChecker = new CommandCaseChecker(workspaceState.symbolIndex);
            cmdCaseChecker.check(flatCommands);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDiagnostics());
        }

        const latestDocument = this.documents.get(document.uri);
        if (!latestDocument || latestDocument.version !== startVersion) {
            this.diagnosticsDroppedStaleVersionCount++;
            return;
        }
        if (expectedSequence !== undefined && this.diagnosticsSequenceByUri.get(document.uri) !== expectedSequence) {
            this.diagnosticsDroppedStaleSequenceCount++;
            return;
        }

        this.connection.sendDiagnostics(diagnostics);
        this.diagnosticsPublishedCount++;
        const elapsedMs = Date.now() - diagnosticsStart;
        this.logger.debug(`Diagnostics published for ${document.uri}: ${diagnostics.diagnostics.length} items in ${elapsedMs}ms`);
        this.logDiagnosticsStatsIfNeeded();
    }

    private logDiagnosticsStatsIfNeeded(): void {
        const total = this.diagnosticsPublishedCount
            + this.diagnosticsDroppedStaleSequenceCount
            + this.diagnosticsDroppedStaleVersionCount;
        if (total === 0 || total % 50 !== 0) {
            return;
        }

        this.logger.info(
            `Diagnostics stats: published=${this.diagnosticsPublishedCount}, rescheduled=${this.diagnosticsRescheduledCount}, dropped(stale-sequence)=${this.diagnosticsDroppedStaleSequenceCount}, dropped(stale-version)=${this.diagnosticsDroppedStaleVersionCount}`
        );
    }

    private async refreshOpenDocumentDiagnosticsForWorkspace(workspaceFolder: URI): Promise<void> {
        const startedAt = Date.now();
        let refreshedCount = 0;
        for (const document of this.documents.all()) {
            if (document.languageId !== 'cmake') {
                continue;
            }
            if (this.getWorkspaceFolderForUri(document.uri).toString() !== workspaceFolder.toString()) {
                continue;
            }

            await this.publishDiagnosticsForDocument(document);
            refreshedCount++;
        }

        this.logger.debug(`Refreshed diagnostics for ${refreshedCount} open CMake document(s) in ${Date.now() - startedAt}ms for ${workspaceFolder.fsPath}`);
    }

    private async onDocumentLinks(params: DocumentLinkParams, token: CancellationToken): Promise<DocumentLink[] | null> {
        const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
        throwIfCancelled(token);
        await this.ensureParsedFile(params.textDocument.uri);
        throwIfCancelled(token);
        await this.populateIndexTopDownAsync(params.textDocument.uri, new Set<string>(), token);
        throwIfCancelled(token);
        const commands = this.getFlatCommands(params.textDocument.uri);
        const linkInfo = await DocumentLinkInfo.create(
            commands,
            params.textDocument.uri,
            workspaceState.symbolIndex,
            this.getEntryFilePath(params.textDocument.uri),
            this.getWorkspaceFolderForUri(params.textDocument.uri).fsPath,
            this.getFlatCommandsAsync.bind(this),
            workspaceState.fileApiRawSnapshot,
            workspaceState.cmakeToolsProjectSnapshot?.buildDirectory,
        );
        throwIfCancelled(token);
        return linkInfo.links;
    }

    private async onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        const uri = event.document.uri;
        const diagnosticsTimer = this.diagnosticsTimerByUri.get(uri);
        if (diagnosticsTimer) {
            clearTimeout(diagnosticsTimer);
            this.diagnosticsTimerByUri.delete(uri);
        }
        this.diagnosticsSequenceByUri.delete(uri);
        this.targetInfoStructureFingerprintByUri.delete(uri);
        tokenBuilders.delete(uri);
        this.fileContexts.delete(uri);
        this.tokenStreams.delete(uri);
        this.commentsMap.delete(uri);
        this.parsedDocumentVersionsByUri.delete(uri);
        const docUri = URI.parse(uri);
        const workspaceFolderUri = this.getWorkspaceFolderForUri(uri);
        const isPersistedWorkspaceFile = this.isUriInsideWorkspace(docUri, workspaceFolderUri) && fs.existsSync(docUri.fsPath);

        if (isPersistedWorkspaceFile) {
            await this.indexWorkspaceFile(uri);
        } else {
            this.flatCommandsMap.delete(uri);
            this.getWorkspaceState(workspaceFolderUri).symbolIndex.deleteCache(uri);
        }

        const workspaceState = this.getWorkspaceState(workspaceFolderUri);
        this.resetProjectTargetInfo(workspaceState, false);
    }

    private onShutdown() {
        for (const timer of this.diagnosticsTimerByUri.values()) {
            clearTimeout(timer);
        }
        this.diagnosticsTimerByUri.clear();
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }

    // #endregion

    private markProjectTargetInfoDirty(docUri: string) {
        const workspaceState = this.getWorkspaceStateForUri(docUri);
        workspaceState.projectTargetInfoDirty = true;
        workspaceState.projectTargetInfoVersion++;
    }

    private resetProjectTargetInfo(workspaceState: WorkspaceState, dirty: boolean) {
        workspaceState.projectTargetInfo = undefined;
        workspaceState.projectTargetInfoDirty = dirty;
        workspaceState.projectTargetInfoVersion++;
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

    private haveSameStringEntries(left: string[], right: string[]): boolean {
        if (left.length !== right.length) {
            return false;
        }

        const leftSet = new Set(left);
        if (leftSet.size !== right.length) {
            return false;
        }

        return right.every(entry => leftSet.has(entry));
    }

    private getWorkspaceIgnoreDirectories(settings: ExtensionSettings): string[] {
        return settings.workspaceIgnoreDirectories ?? this.defaultExtSettings.workspaceIgnoreDirectories ?? [];
    }

    private clearWorkspaceFolderSnapshots(workspaceFolder: URI): void {
        for (const uri of [...this.fileContexts.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.fileContexts.delete(uri);
            }
        }

        for (const uri of [...this.tokenStreams.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.tokenStreams.delete(uri);
            }
        }

        for (const uri of [...this.flatCommandsMap.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.flatCommandsMap.delete(uri);
            }
        }

        for (const uri of [...this.commentsMap.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.commentsMap.delete(uri);
            }
        }

        for (const uri of [...this.parsedDocumentVersionsByUri.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.parsedDocumentVersionsByUri.delete(uri);
            }
        }

        for (const uri of [...this.targetInfoStructureFingerprintByUri.keys()]) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.targetInfoStructureFingerprintByUri.delete(uri);
            }
        }

        const workspaceState = this.getWorkspaceState(workspaceFolder);
        workspaceState.symbolIndex.deleteCachesInDirectory(workspaceFolder.fsPath);
        this.resetWorkspaceIndexState(workspaceState);
        this.resetProjectTargetInfo(workspaceState, false);
    }

    private async ensureAllWorkspaceFoldersIndexed(): Promise<void> {
        await Promise.all(this.getWorkspaceFolders().map(folder => this.ensureWorkspaceFolderIndexed(folder)));
    }

    private async ensureWorkspaceIndexedForUri(docUri: string): Promise<void> {
        await this.ensureWorkspaceFolderIndexed(this.getWorkspaceFolderForUri(docUri));
    }

    private resetWorkspaceIndexState(workspaceState: WorkspaceState): void {
        workspaceState.workspaceIndexing = undefined;
        workspaceState.workspaceIndexingGeneration = undefined;
        workspaceState.workspaceIndexedGeneration = undefined;
    }

    private ensureWorkspaceFolderIndexed(workspaceFolder: URI): Promise<void> {
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const generation = workspaceState.environmentGeneration;
        if (workspaceState.workspaceIndexedGeneration === generation) {
            return Promise.resolve();
        }

        const existing = workspaceState.workspaceIndexing;
        if (existing && workspaceState.workspaceIndexingGeneration === generation) {
            return existing;
        }

        const indexing = this.indexWorkspaceFolder(workspaceFolder, generation)
            .then(completed => {
                if (completed && this.isEnvironmentGenerationCurrent(workspaceFolder, generation)) {
                    workspaceState.workspaceIndexedGeneration = generation;
                }
            })
            .catch(error => {
                this.logger.error(`Failed to index workspace folder ${workspaceFolder.fsPath}`, error as Error);
            })
            .finally(() => {
                if (workspaceState.workspaceIndexing === indexing) {
                    workspaceState.workspaceIndexing = undefined;
                    workspaceState.workspaceIndexingGeneration = undefined;
                }
            });
        workspaceState.workspaceIndexing = indexing;
        workspaceState.workspaceIndexingGeneration = generation;
        return indexing;
    }

    private async indexWorkspaceFolder(workspaceFolder: URI, generation: number): Promise<boolean> {
        const start = Date.now();
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const collectStart = Date.now();
        const files = await this.collectWorkspaceCMakeFiles(
            workspaceFolder.fsPath,
            this.getWorkspaceIgnoreDirectories(workspaceState.extSettings),
        );
        this.logger.debug(`Collected ${files.length} workspace CMake files in ${Date.now() - collectStart}ms for ${workspaceFolder.fsPath}`);

        const progress = await this.connection.window.createWorkDoneProgress();
        progress.begin('CMake: Indexing workspace', 0, `0 / ${files.length}`);
        try {
            for (let i = 0; i < files.length; i++) {
                if (!this.isEnvironmentGenerationCurrent(workspaceFolder, generation)) {
                    return false;
                }
                await this.indexWorkspaceFile(URI.file(files[i]).toString(), generation);
                progress.report(Math.round(((i + 1) / files.length) * 100), `${i + 1} / ${files.length}`);
            }

            if (!this.isEnvironmentGenerationCurrent(workspaceFolder, generation)) {
                return false;
            }

            const elapsedMs = Date.now() - start;
            this.logger.info(
                `Finished parsing workspace CMake files: ${files.length} files in ${elapsedMs}ms (${workspaceFolder.fsPath})`
            );
            return true;
        } finally {
            progress.done();
        }
    }

    private isEnvironmentGenerationCurrent(workspaceFolder: URI, generation: number): boolean {
        return this.getWorkspaceState(workspaceFolder).environmentGeneration === generation;
    }

    private async collectWorkspaceCMakeFiles(rootPath: string, ignoredDirectoryNames: readonly string[]): Promise<string[]> {
        const results: string[] = [];
        const ignoredDirectories = new Set(ignoredDirectoryNames);

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

    private async indexWorkspaceFile(uri: string, generation?: number): Promise<void> {
        const text = await getFileContent(this.documents, URI.parse(uri));
        const parsedFile = this.parseCMakeFile({ uri, getText: () => text }, 'workspace index');
        await this.storeParsedFileSnapshot(uri, parsedFile, generation);
    }

    private async storeParsedFileSnapshot(uri: string, parsedFile: ParsedCMakeFile, generation?: number, skipSymbolExtraction?: boolean) {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        if (generation !== undefined && workspaceState.environmentGeneration !== generation) {
            return;
        }
        this.fileContexts.set(uri, parsedFile.fileContext);
        this.tokenStreams.set(uri, parsedFile.tokenStream);
        this.flatCommandsMap.set(uri, parsedFile.flatCommands);
        this.updateTargetInfoStructureFingerprint(uri, parsedFile.flatCommands, false);

        // Set comments and document-version tracking BEFORE extractSymbols so that
        // hasCurrentParsedSnapshot returns true for re-entrant calls during
        // dependency resolution (e.g. A includes B, B includes A).
        const commentsChannel = CMakeLexer.channelNames.indexOf("COMMENTS");
        this.commentsMap.set(uri, parsedFile.tokenStream.tokens.filter(token => token.channel === commentsChannel));

        const openDocument = this.documents.get(uri);
        if (openDocument) {
            this.parsedDocumentVersionsByUri.set(uri, openDocument.version);
        } else {
            this.parsedDocumentVersionsByUri.delete(uri);
        }

        // Symbol extraction can recursively parse dependency files and is expensive
        // for large projects. Skip it during diagnostics so that syntax/semantic
        // checking returns quickly; symbolIndex is populated by background indexing.
        if (skipSymbolExtraction) {
            return;
        }

        const baseDir = URI.file(path.dirname(URI.parse(uri).fsPath));
        const fileSymbolCache = await extractSymbols(uri, parsedFile.flatCommands, baseDir, workspaceState.symbolIndex, {
            entryFile: this.getEntryFilePath(uri),
            getFlatCommands: async (targetUri) => {
                if (targetUri === uri) {
                    return parsedFile.flatCommands;
                }

                return this.getFlatCommandsAsync(targetUri);
            },
        });
        workspaceState.symbolIndex.setCache(uri, fileSymbolCache);
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
        // On-demand parsing (triggered by hover, completion, etc.) stores parse
        // caches only. Symbol extraction is deferred to background workspace
        // indexing to avoid recursively parsing the entire dependency tree on
        // every cache miss.
        await this.storeParsedFileSnapshot(uri, parsedFile, undefined, true);
        return parsedFile;
    }

    private hasCurrentParsedSnapshot(uri: string): boolean {
        const hasCachedSnapshot = this.fileContexts.has(uri)
            && this.tokenStreams.has(uri)
            && this.flatCommandsMap.has(uri)
            && this.commentsMap.has(uri);
        if (!hasCachedSnapshot) {
            return false;
        }

        const openDocument = this.documents.get(uri);
        if (!openDocument) {
            return true;
        }

        const parsedVersion = this.parsedDocumentVersionsByUri.get(uri);
        if (parsedVersion === undefined) {
            // The snapshot was indexed from disk while the file was not open as a document.
            // The initial document version (1) always reflects the same on-disk content,
            // so the cached snapshot is valid and there is no need to re-parse.
            return openDocument.version === 1;
        }
        return parsedVersion === openDocument.version;
    }

    private async ensureParsedFile(uri: string): Promise<void> {
        while (!this.hasCurrentParsedSnapshot(uri)) {
            let request = this.parsedFileRequestsByUri.get(uri);
            if (!request) {
                request = this.parseAndStoreFileAsync(uri)
                    .finally(() => {
                        if (this.parsedFileRequestsByUri.get(uri) === request) {
                            this.parsedFileRequestsByUri.delete(uri);
                        }
                    });
                this.parsedFileRequestsByUri.set(uri, request);
            }

            await request;
        }
    }

    private async populateIndexTopDownAsync(uri: string, visited: Set<string>, token?: CancellationToken): Promise<void> {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        await populateIndexTopDown({
            rootUri: uri,
            visited,
            symbolIndex: workspaceState.symbolIndex,
            loadFlatCommands: this.getFlatCommandsAsync.bind(this),
            shouldCancel: () => token?.isCancellationRequested ?? false,
            onDependencyError: async (dependencyUri, error): Promise<'continue'> => {
                this.logger.error(`Failed to parse dependency during completion: ${dependencyUri}`, error as Error);
                return 'continue';
            },
        });
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
        return targetInfoListener.targetInfo;
    }

    private scheduleProjectTargetInfoRebuild(
        workspaceState: WorkspaceState,
        workspaceFolder: URI,
        docUri: string,
        entryUri?: string,
    ): void {
        if (workspaceState.projectTargetInfoBuild) {
            return;
        }

        void this.startProjectTargetInfoRebuild(workspaceState, workspaceFolder, docUri, entryUri, 'background')
            .catch(error => {
                const normalizedError = error instanceof Error ? error : new Error(String(error));
                this.logger.error(`Background project target info rebuild failed for ${workspaceFolder.fsPath}`, normalizedError);
            });
    }

    private getProjectTargetInfoForCompletion(docUri: string, entryUri?: string): ProjectTargetInfo {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);

        if (workspaceState.projectTargetInfo) {
            if (workspaceState.projectTargetInfoDirty) {
                this.scheduleProjectTargetInfoRebuild(workspaceState, workspaceFolder, docUri, entryUri);
            }

            return workspaceState.projectTargetInfo;
        }

        this.scheduleProjectTargetInfoRebuild(workspaceState, workspaceFolder, docUri, entryUri);
        return {} as ProjectTargetInfo;
    }

    private async getProjectTargetInfoForUri(docUri: string, entryUri?: string): Promise<ProjectTargetInfo> {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        if (workspaceState.projectTargetInfo) {
            if (workspaceState.projectTargetInfoDirty && !workspaceState.projectTargetInfoBuild) {
                this.scheduleProjectTargetInfoRebuild(workspaceState, workspaceFolder, docUri, entryUri);
            }
            return workspaceState.projectTargetInfo;
        }

        return await this.startProjectTargetInfoRebuild(workspaceState, workspaceFolder, docUri, entryUri, 'foreground');
    }

    private startProjectTargetInfoRebuild(
        workspaceState: WorkspaceState,
        workspaceFolder: URI,
        docUri: string,
        entryUri?: string,
        mode: 'foreground' | 'background' = 'foreground',
    ): Promise<ProjectTargetInfo> {
        if (workspaceState.projectTargetInfoBuild) {
            return workspaceState.projectTargetInfoBuild;
        }

        const startMs = Date.now();
        if (mode === 'background') {
            this.targetInfoBackgroundRebuildCount++;
        } else {
            this.targetInfoForegroundRebuildCount++;
        }

        const buildPromise = this.buildProjectTargetInfoForUri(workspaceState, workspaceFolder, docUri, entryUri)
            .then(result => {
                const elapsedMs = Date.now() - startMs;
                this.logger.debug(`Project target info rebuild (${mode}) finished in ${elapsedMs}ms for ${workspaceFolder.fsPath}`);
                this.logTargetInfoStatsIfNeeded();
                return result;
            })
            .finally(() => {
                if (workspaceState.projectTargetInfoBuild === buildPromise) {
                    workspaceState.projectTargetInfoBuild = undefined;
                }
            });
        workspaceState.projectTargetInfoBuild = buildPromise;
        return buildPromise;
    }

    private logTargetInfoStatsIfNeeded(): void {
        const total = this.targetInfoForegroundRebuildCount + this.targetInfoBackgroundRebuildCount;
        if (total === 0 || total % 20 !== 0) {
            return;
        }

        this.logger.info(
            `Project target info rebuild stats: foreground=${this.targetInfoForegroundRebuildCount}, background=${this.targetInfoBackgroundRebuildCount}`
        );
    }

    private async buildProjectTargetInfoForUri(
        workspaceState: WorkspaceState,
        workspaceFolder: URI,
        docUri: string,
        entryUri?: string,
    ): Promise<ProjectTargetInfo> {
        const targetInfoVersion = workspaceState.projectTargetInfoVersion;

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
                await targetInfoListener.processCommands(commands);                const targetInfo = targetInfoListener.targetInfo;
                if (targetInfoVersion === workspaceState.projectTargetInfoVersion) {
                    workspaceState.projectTargetInfo = targetInfo;
                    workspaceState.projectTargetInfoDirty = false;
                }
                return targetInfo;
            }
        }

        const targetInfo = await this.rebuildProjectTargetInfoForUri(docUri);
        if (targetInfoVersion === workspaceState.projectTargetInfoVersion) {
            workspaceState.projectTargetInfo = targetInfo;
            workspaceState.projectTargetInfoDirty = false;
        }
        return targetInfo;
    }

    private async getExtSettings(scopeUri?: string): Promise<ExtensionSettings> {
        const [currentSettings, legacySettings] = await this.connection.workspace.getConfiguration([
            { section: CONFIGURATION_SECTION, scopeUri },
            { section: LEGACY_CONFIGURATION_SECTION, scopeUri },
        ]);

        return resolveExtensionSettings(currentSettings, legacySettings, this.defaultExtSettings);
    }

    private async initializeEnvironment(workspaceFolder: URI, settings?: ExtensionSettings): Promise<void> {
        const initializeStart = Date.now();
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const generation = ++workspaceState.environmentGeneration;
        workspaceState.environmentReady = false;
        const settingsStart = Date.now();
        workspaceState.extSettings = settings ?? await this.getExtSettings(workspaceFolder.toString());
        this.logger.debug(`Loaded extension settings for ${workspaceFolder.fsPath} in ${Date.now() - settingsStart}ms`);
        this.logger.setLevel(workspaceState.extSettings.loggingLevel);
        this.resetWorkspaceIndexState(workspaceState);
        this.resetProjectTargetInfo(workspaceState, false);
        workspaceState.cmakeHelpCache.clear();
        const previousModulePath = workspaceState.symbolIndex.cmakeModulePath;
        if (previousModulePath) {
            workspaceState.symbolIndex.deleteCachesInDirectory(previousModulePath);
        }
        workspaceState.symbolIndex.clearBuiltinModuleCommandCatalog();
        try {
            const environmentSetupStart = Date.now();
            await initializeCMakeEnvironment(
                workspaceState.extSettings,
                workspaceState.symbolIndex,
                (stats: BuiltinEntriesLoadStats) => {
                    this.logger.debug(`Loaded cmake builtin help entries from ${stats.source} in ${stats.durationMs}ms`);
                },
                (stats) => {
                    this.logger.debug(`Environment phase ${stats.phase} finished in ${stats.durationMs}ms${stats.detail ? ` (${stats.detail})` : ''}`);
                },
            );
            this.logger.debug(`CMake environment core initialization finished in ${Date.now() - environmentSetupStart}ms for ${workspaceFolder.fsPath}`);
            if (workspaceState.symbolIndex.cmakeModulePath) {
                const catalogStart = Date.now();
                const catalog = await loadBuiltinModuleCommandCatalog({
                    symbolIndex: workspaceState.symbolIndex,
                    cmakePath: workspaceState.symbolIndex.cmakePath,
                    cmakeFingerprint: workspaceState.symbolIndex.cmakeFingerprint,
                    cmakeModulePath: workspaceState.symbolIndex.cmakeModulePath,
                });
                if (catalog.length > 0) {
                    this.logger.debug(`Loaded builtin module command catalog in ${Date.now() - catalogStart}ms: commands=${catalog.length}`);
                }
            }
            if (generation === workspaceState.environmentGeneration) {
                workspaceState.environmentReady = true;
            }
        } catch (e: any) {
            this.logger.error('Failed to initialize CMake environment', e instanceof Error ? e : new Error(String(e)));
            this.connection.window.showErrorMessage(e.message);
            workspaceState.environmentReady = false;
        }

        this.logger.debug(`Environment initialization finished in ${Date.now() - initializeStart}ms for ${workspaceFolder.fsPath} (generation=${generation}, ready=${workspaceState.environmentReady})`);

        void this.warmBuiltinModuleCachesInBackground(workspaceState, generation);
    }

    private async warmBuiltinModuleCachesInBackground(workspaceState: WorkspaceState, generation: number): Promise<void> {
        const cmakeModulePath = workspaceState.symbolIndex.cmakeModulePath;
        if (!cmakeModulePath) {
            return;
        }

        try {
            this.logger.debug(`Starting standard library warmup for ${cmakeModulePath}`);
            const result = await warmBuiltinModuleCaches({
                symbolIndex: workspaceState.symbolIndex,
                cmakePath: workspaceState.symbolIndex.cmakePath,
                cmakeFingerprint: workspaceState.symbolIndex.cmakeFingerprint,
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
        if (workspaceState.environmentReady) {
            return;
        }

        await this.startEnvironmentInitialization(workspaceFolder);
    }

    private async startEnvironmentInitialization(workspaceFolder: URI, settings?: ExtensionSettings): Promise<void> {
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        if (workspaceState.environmentInitialization) {
            await workspaceState.environmentInitialization;
            if (!workspaceState.environmentReady) {
                throw new Error(`Failed to initialize CMake environment for ${workspaceFolder.fsPath}`);
            }
            return;
        }

        const initialization = this.initializeEnvironment(workspaceFolder, settings)
            .finally(() => {
                if (workspaceState.environmentInitialization === initialization) {
                    workspaceState.environmentInitialization = undefined;
                }
            });
        workspaceState.environmentInitialization = initialization;
        await initialization;
        if (!workspaceState.environmentReady) {
            throw new Error(`Failed to initialize CMake environment for ${workspaceFolder.fsPath}`);
        }
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
        if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) {
            return existing.request;
        }
        if (existing) {
            workspaceState.cmakeHelpCache.delete(cacheKey);
        }

        const cacheEntry: HelpCacheEntry = {
            request: Promise.resolve(null),
        };
        cacheEntry.request = execFilePromise(workspaceState.symbolIndex.cmakePath, [helpArg, label])
            .then(({ stdout }) => rstToMarkdown(stdout))
            .catch((error: ExecFileFailure) => {
                if (logErrors) {
                    this.logger.error(`Failed to get help for ${label}: ${error.stderr ?? ''}`);
                }
                // Only evict the cache when cmake ran but reported "topic not found"
                // (exit code is a number).  For OS-level spawn errors (code is a string,
                // e.g. 'EINVAL' when cmake is a .bat file) keep the null result cached
                // so we don't retry on every hover and flood the user with errors,
                // but still eventually retry in case the executable/environment changed.
                if (typeof error.code === 'number') {
                    workspaceState.cmakeHelpCache.delete(cacheKey);
                } else {
                    cacheEntry.expiresAt = Date.now() + CMAKE_HELP_NULL_CACHE_TTL_MS;
                }
                return null;
            });

        workspaceState.cmakeHelpCache.set(cacheKey, cacheEntry);
        return cacheEntry.request;
    }
}

new CMakeLanguageServer();
