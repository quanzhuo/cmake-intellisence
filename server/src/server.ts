import { ParseTreeWalker } from 'antlr4';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { Range, TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { CodeAction, Command, CompletionItem, CompletionList, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, SignatureHelp, SymbolInformation } from 'vscode-languageserver-types';
import { CancellationToken, CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, DidChangeWatchedFilesParams, FileChangeType, HoverParams, InitializeParams, InitializeResult, InitializedParams, LSPErrorCodes, ProposedFeatures, ReferenceParams, RenameParams, ResponseError, SemanticTokensDeltaParams, SemanticTokensParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, WorkspaceEdit, WorkspaceFoldersChangeEvent, WorkspaceSymbolParams, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import { ArgumentSemanticKind, DefinitionSubject, resolveCursorTarget } from './argumentSemantics';
import { loadBuiltinModuleCommandCatalog, warmBuiltinModuleCaches } from './builtinModuleIndex';
import { isCancellationError, throwIfCancelled, waitForCancellation } from './cancellation';
import { CMakeCacheEntriesByName, getCacheEntryByName, loadCMakeCacheEntries } from './cmakeCache';
import { BuiltinEntriesLoadStats, ExtensionSettings, initializeCMakeEnvironment } from './cmakeEnvironment';
import { CONFIGURATION_SECTION, resolveExtensionSettings } from './config';
import Completion, { CMakeCompletionType, CompletionItemType, findCommandAtPosition, findRecoveredCommandInfoAtPosition, getCompletionHelpLabel, getCompletionInfoAtCursor, getCompletionItemType, getCompletionWorkspaceKey, inComments } from './completion';
import { DefinitionResolver } from './definition';
import { analyzeDependencyStructure, DependencyStructureAnalysis } from './dependencyStructure';
import SemanticDiagnosticsListener, { CommandCaseChecker, DIAG_CODE_CMD_CASE } from './diagnostics';
import { DocumentLinkInfo } from './docLink';
import { loadFileApiRawSnapshot } from './fileApiLoader';
import { SymbolListener } from './docSymbols';
import { FileApiCacheEntrySnapshot, FileApiRawSnapshot } from './fileApiSnapshot';
import { FlatCommand } from './flatCommands';
import { Formatter } from './format';
import localize, { localizeInitializer } from './localize';
import { Logger, createLogger } from './logging';
import { ExecFileFailure, execFilePromise } from './processUtils';
import { PathDiagnosticsProvider } from './pathDiagnostics';
import { ReferenceResolver } from './references';
import { RenameResolver } from './rename';
import { rstToMarkdown } from './rstToMarkdown';
import { SemanticTokenListener, createTokenBuilder, deleteTokenBuilder, getTokenBuilder, getTokenModifiers, getTokenTypes } from './semanticTokens';
import { buildSignatureHelp, buildSignatureHelpForInvocation } from './signatureHelp';
import { textOffsetAtPosition } from './sourcePosition';
import { ReferenceBinding, SymbolBindingResolver } from './symbolBinding';
import { extractSymbols } from './symbolExtractor';
import { SymbolIndex, SymbolOccurrence } from './symbolIndex';
import { populateIndexTopDown } from './symbolIndexManager';
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, CMakeToolsProjectSnapshot, CMakeToolsProjectSnapshotNotificationParams, READY_NOTIFICATION } from './cmakeToolsSnapshot';
import { PathExpressionResolver } from './pathExpressionResolver';
import { ParsedFileSnapshot, ParsedFileStore, SourceRevision, sourceRevisionKey, sourceRevisionsEqual } from './parsedFileStore';
import { isPathEqualOrInside } from './pathUtils';
import { parseCMakeText } from './utils';
import { findVariableReferences } from './variableReferences';
import { WorkspaceSymbolResolver } from './workspaceSymbol';
import { WorkspaceCMakeFilePolicy } from './workspaceScanner';

type Word = {
    text: string,
    line: number,
    col: number
};

type DependencyStructureFingerprint = Pick<
    DependencyStructureAnalysis,
    'directFingerprint' | 'variableFingerprints'
>;

type ProjectReindexRequest = {
    trigger: string;
    rebuildContexts: boolean;
};

type ProjectGenerationSnapshot = {
    entryFile: string;
    generation: number;
};

type RecoveredDefinitionResult = {
    locations: Location[] | null;
    usedWorkspaceFallback: boolean;
};

type WorkspaceState = {
    workspaceFolder: URI;
    symbolIndex: SymbolIndex;
    cmakeToolsProjectSnapshot?: CMakeToolsProjectSnapshot;
    cmakeToolsUpdateSequence: number;
    cmakeToolsUpdate?: Promise<void>;
    fileApiRawSnapshot?: FileApiRawSnapshot;
    cmakeCacheEntriesByName?: CMakeCacheEntriesByName;
    cmakeCacheBuildDirectory?: string;
    workspaceIndexing?: Promise<void>;
    workspaceIndexSequence: number;
    workspaceIndexingId?: number;
    workspaceIndexingTrigger?: string;
    workspaceIndexingGeneration?: number;
    workspaceIndexedGeneration?: number;
    cmakeHelpCache: Map<string, HelpCacheEntry>;
    environmentInitialization?: Promise<void>;
    environmentGeneration: number;
    analysisGeneration: number;
    cmakeSnapshotGeneration: number;
    workspaceSymbolGeneration: number;
    projectGenerations: Map<string, number>;
    environmentReady: boolean;
    extSettings: ExtensionSettings;
    pendingWatchedFileChanges: Map<string, DidChangeWatchedFilesParams['changes'][number]>;
    watchedFileFlushTimer?: ReturnType<typeof setTimeout>;
    watchedFileProcessing?: Promise<void>;
    affectedProjectEntriesByUri: Map<string, Set<string>>;
    affectedProjectDependencyInputsByUri: Map<string, Map<string, Set<string>>>;
    pendingProjectReindexEntries: Map<string, ProjectReindexRequest>;
    projectReindexTimer?: ReturnType<typeof setTimeout>;
    projectReindexing?: Promise<void>;
};

type HelpCacheEntry = {
    request: Promise<string | null>;
    expiresAt?: number;
};

const CMAKE_HELP_NULL_CACHE_TTL_MS = 5 * 60 * 1000;
const DIAGNOSTICS_DEBOUNCE_MS = 220;
const PROJECT_REINDEX_DEBOUNCE_MS = 220;
const WATCHED_FILES_DEBOUNCE_MS = 400;
const MAX_CLOSED_PARSED_FILE_SNAPSHOTS = 128;
const ALL_PROJECT_ENTRIES = '\0all-project-entries';

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
    private parsedFiles = new ParsedFileStore();
    private symbolIndexRequests: Map<string, Promise<void>> = new Map();
    private structureFingerprintsByUri: Map<string, DependencyStructureFingerprint> = new Map();
    private workspaceStates: Map<string, WorkspaceState> = new Map();
    private workspaceFolders: URI[] = [];
    private logger: Logger = createLogger('cmake-intelli', 'off');
    private diagnosticsTimerByUri: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private diagnosticsSequenceByUri: Map<string, number> = new Map();
    private diagnosticsRescheduledCount = 0;
    private diagnosticsDroppedStaleSequenceCount = 0;
    private diagnosticsDroppedStaleVersionCount = 0;
    private diagnosticsPublishedCount = 0;

    private readonly defaultExtSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
        workspaceIgnoreDirectories: ['.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'cmake-build-debug', 'cmake-build-release'],
        excludeCMakeBuildDirectories: true,
    };

    constructor() {
        this.disposables.push(
            this.connection.onInitialize(this.wrapRequestRethrow('initialize', this.onInitialize.bind(this))),
            this.connection.onInitialized(this.wrapNotification('initialized', this.onInitialized.bind(this))),
            this.connection.onHover(this.wrapRequest('hover', this.onHover.bind(this), null)),
            this.connection.onCompletion(this.wrapRequest('completion', this.onCompletion.bind(this), null)),
            this.connection.onCompletionResolve(this.wrapRequest('completionResolve', this.onCompletionResolve.bind(this), item => item)),
            this.connection.onSignatureHelp(this.wrapRequest('signatureHelp', this.onSignatureHelp.bind(this), null)),
            this.connection.onDocumentFormatting(this.wrapRequest('documentFormatting', this.onDocumentFormatting.bind(this), null)),
            this.connection.onDocumentSymbol(this.wrapRequest('documentSymbol', this.onDocumentSymbol.bind(this), null)),
            this.connection.onDefinition(this.wrapRequest('definition', this.onDefinition.bind(this), null)),
            this.connection.onReferences(this.wrapRequest('references', this.onReferences.bind(this), null)),
            this.connection.onRenameRequest(this.wrapRequest('rename', this.onRename.bind(this), null)),
            this.connection.onWorkspaceSymbol(this.wrapRequest('workspaceSymbol', this.onWorkspaceSymbol.bind(this), null)),
            this.connection.onCodeAction(this.wrapRequest('codeAction', this.onCodeAction.bind(this), [])),
            this.connection.onDidChangeConfiguration(this.wrapNotification('didChangeConfiguration', this.onDidChangeConfiguration.bind(this))),
            this.connection.onDidChangeWatchedFiles(this.wrapNotification('didChangeWatchedFiles', this.onDidChangeWatchedFiles.bind(this))),
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
            cmakeToolsUpdateSequence: 0,
            cmakeHelpCache: new Map<string, HelpCacheEntry>(),
            environmentGeneration: 0,
            analysisGeneration: 0,
            cmakeSnapshotGeneration: 0,
            workspaceSymbolGeneration: 0,
            projectGenerations: new Map(),
            workspaceIndexSequence: 0,
            environmentReady: false,
            extSettings: { ...this.defaultExtSettings },
            pendingWatchedFileChanges: new Map(),
            affectedProjectEntriesByUri: new Map(),
            affectedProjectDependencyInputsByUri: new Map(),
            pendingProjectReindexEntries: new Map(),
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
        fallback: TResult | ((...args: TArgs) => TResult),
    ): (...args: TArgs) => Promise<TResult> {
        return async (...args: TArgs): Promise<TResult> => {
            try {
                const token = args[1] as CancellationToken | undefined;
                throwIfCancelled(token);
                return await waitForCancellation(Promise.resolve(handler(...args)), token);
            } catch (error) {
                if (isCancellationError(error)) {
                    throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled');
                }
                if (error instanceof ResponseError) {
                    throw error;
                }
                this.logUnhandledHandlerError(handlerName, error);
                return typeof fallback === 'function'
                    ? (fallback as (...fallbackArgs: TArgs) => TResult)(...args)
                    : fallback;
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
        this.workspaceFolders = params.workspaceFolders?.map(folder => URI.parse(folder.uri))
            ?? (params.rootUri ? [URI.parse(params.rootUri)] : []);
        localizeInitializer.init(params.locale || 'en');

        const result: InitializeResult = {
            capabilities: {
                // The server still performs whole-file ANTLR analysis, but range-based
                // synchronization avoids transferring the complete document on every edit.
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

    private async onInitialized(_params: InitializedParams) {
        this.connection.client.register(DidChangeConfigurationNotification.type, undefined);
        if (this.initParams?.capabilities.workspace?.workspaceFolders) {
            this.disposables.push(
                this.connection.workspace.onDidChangeWorkspaceFolders(
                    this.wrapNotification('didChangeWorkspaceFolders', this.onDidChangeWorkspaceFolders.bind(this))
                )
            );
        }
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
        // initialized. Workspace file indexing continues in the background, while
        // interactive handlers index only the current or reachable files on demand.
        this.connection.sendNotification(READY_NOTIFICATION);

        const workspaceIndexStart = Date.now();
        void this.ensureAllWorkspaceFoldersIndexed('server initialized')
            .then(() => {
                this.logger.debug(`Initial workspace indexing finished in ${Date.now() - workspaceIndexStart}ms`);
            })
            .catch((error: unknown) => {
                this.logger.error('Initial workspace indexing failed', error instanceof Error ? error : new Error(String(error)));
            });
    }

    private onCMakeToolsProjectSnapshotChanged(params: CMakeToolsProjectSnapshotNotificationParams): Promise<void> {
        const workspaceFolder = URI.parse(params.workspaceFolderUri);
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const updateSequence = ++workspaceState.cmakeToolsUpdateSequence;

        let update: Promise<void>;
        update = this.processCMakeToolsProjectSnapshotChanged(
            params,
            workspaceFolder,
            workspaceState,
            updateSequence,
        ).finally(() => {
            if (workspaceState.cmakeToolsUpdate === update) {
                workspaceState.cmakeToolsUpdate = undefined;
            }
        });
        workspaceState.cmakeToolsUpdate = update;
        return update;
    }

    private async processCMakeToolsProjectSnapshotChanged(
        params: CMakeToolsProjectSnapshotNotificationParams,
        workspaceFolder: URI,
        workspaceState: WorkspaceState,
        updateSequence: number,
    ): Promise<void> {
        const startedAt = Date.now();
        const previousSnapshot = workspaceState.cmakeToolsProjectSnapshot;
        const previousFileApiRawSnapshot = workspaceState.fileApiRawSnapshot;
        const nextSnapshot = params.snapshot ?? undefined;
        let nextFileApiRawSnapshot = previousFileApiRawSnapshot;
        if (this.shouldResetFileApiRawSnapshot(previousSnapshot, nextSnapshot)) {
            nextFileApiRawSnapshot = undefined;
        }

        if (nextSnapshot?.buildDirectory) {
            const fileApiLoadStart = Date.now();
            try {
                nextFileApiRawSnapshot = await loadFileApiRawSnapshot(nextSnapshot.buildDirectory) ?? undefined;
                this.logger.debug(`Loaded File API snapshot for ${workspaceFolder.fsPath} in ${Date.now() - fileApiLoadStart}ms`);
            } catch (error) {
                nextFileApiRawSnapshot = undefined;
                this.logger.debug(`Failed to load File API snapshot for ${workspaceFolder.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const cmakeCacheLoadStart = Date.now();
        const nextCMakeCacheEntriesByName = nextSnapshot?.buildDirectory
            ? await loadCMakeCacheEntries(nextSnapshot.buildDirectory)
            : undefined;
        this.logger.debug(`Loaded CMake cache snapshot for ${workspaceFolder.fsPath} in ${Date.now() - cmakeCacheLoadStart}ms`);

        if (workspaceState.cmakeToolsUpdateSequence !== updateSequence) {
            this.logger.debug(`Discarded superseded CMake Tools snapshot update for ${workspaceFolder.fsPath}`);
            return;
        }

        workspaceState.cmakeToolsProjectSnapshot = nextSnapshot;
        workspaceState.fileApiRawSnapshot = nextFileApiRawSnapshot;
        workspaceState.cmakeCacheEntriesByName = nextCMakeCacheEntriesByName;
        workspaceState.cmakeCacheBuildDirectory = nextSnapshot?.buildDirectory;
        workspaceState.cmakeSnapshotGeneration++;
        // The observable snapshot is now committed atomically. Requests may use
        // it while the follow-up diagnostics refresh continues.
        workspaceState.cmakeToolsUpdate = undefined;

        if (this.didFileApiRawSnapshotChange(previousFileApiRawSnapshot, nextFileApiRawSnapshot)) {
            const diagnosticsRefreshStart = Date.now();
            void this.refreshOpenDocumentDiagnosticsForWorkspace(workspaceFolder)
                .then(() => {
                    this.logger.debug(`Refreshed open-document diagnostics for ${workspaceFolder.fsPath} in ${Date.now() - diagnosticsRefreshStart}ms after snapshot change`);
                })
                .catch(error => {
                    this.logger.error(
                        `Failed to refresh diagnostics after CMake Tools snapshot update for ${workspaceFolder.fsPath}`,
                        error instanceof Error ? error : new Error(String(error)),
                    );
                });
        }

        this.logger.debug(`Processed CMake Tools snapshot update for ${workspaceFolder.fsPath} in ${Date.now() - startedAt}ms`);
        this.logger.debug(`Updated CMake Tools snapshot for ${workspaceFolder.fsPath}`, JSON.stringify(params.snapshot));
    }

    private async ensureCMakeToolsStateReady(workspaceState: WorkspaceState): Promise<void> {
        while (workspaceState.cmakeToolsUpdate) {
            const update = workspaceState.cmakeToolsUpdate;
            try {
                await update;
            } catch {
                // The notification wrapper records the error. Requests continue
                // with the last fully committed snapshot.
            }
            if (workspaceState.cmakeToolsUpdate === update) {
                return;
            }
        }
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
        throwIfCancelled(token);
        await this.ensureEnvironmentInitialized(params.textDocument.uri);

        while (this.documents.get(params.textDocument.uri)) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
            await this.ensureCMakeToolsStateReady(workspaceState);
            throwIfCancelled(token);
            const analysisGeneration = workspaceState.analysisGeneration;
            const cmakeSnapshotGeneration = workspaceState.cmakeSnapshotGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, params.textDocument.uri);
            const snapshot = await this.ensureParsedFile(params.textDocument.uri, 'hover');
            if (!await this.ensureFileIndexedAsync(params.textDocument.uri, snapshot, analysisGeneration)
                || workspaceState.analysisGeneration !== analysisGeneration
                || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
                || !this.isProjectGenerationCurrent(workspaceState, params.textDocument.uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }

            const result = await this.computeHover(params, token, workspaceState, snapshot);
            if (workspaceState.analysisGeneration === analysisGeneration
                && workspaceState.cmakeSnapshotGeneration === cmakeSnapshotGeneration
                && this.isProjectGenerationCurrent(workspaceState, params.textDocument.uri, projectGeneration)
                && await this.isParsedSnapshotCurrent(snapshot)) {
                return result;
            }
        }

        return null;
    }

    private async computeHover(
        params: HoverParams,
        token: CancellationToken,
        workspaceState: WorkspaceState,
        snapshot: ParsedFileSnapshot,
    ): Promise<Hover | null> {
        const comments = snapshot.comments;
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands = snapshot.flatCommands;
        const tokenStream = snapshot.tokenStream;
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

        const systemCache = workspaceState.symbolIndex.getSystemCache();
        const commandName = (hoveredCommand?.ID().symbol.text ?? recoveredCommandName ?? '').toLowerCase();
        const cursorTarget = hoveredCommand
            ? resolveCursorTarget(hoveredCommand, word, params.position)
            : null;
        const hoveredVariableName = cursorTarget?.subject === DefinitionSubject.Variable
            && cursorTarget.text.length !== 0
            && this.hasVariableOccurrence(workspaceState, params.textDocument.uri, params.position, cursorTarget)
            ? cursorTarget.text
            : null;
        let helpRequest: { arg: string; category: string; label: string } | null = null;
        if (recoveredCommandInfo?.isOnCommandName && systemCache.commands.has(commandName)) {
            helpRequest = { arg: '--help-command', category: 'command', label: commandName };
        } else if (cursorTarget?.subject === DefinitionSubject.Command) {
            const label = cursorTarget.text.toLowerCase();
            if (systemCache.commands.has(label)
                && !this.hasUserCommandBinding(workspaceState, params.textDocument.uri, params.position)) {
                helpRequest = { arg: '--help-command', category: 'command', label };
            }
        } else if (cursorTarget?.subject === DefinitionSubject.IncludeModule
            && systemCache.modules.has(cursorTarget.text)) {
            helpRequest = { arg: '--help-module', category: 'module', label: cursorTarget.text };
        } else if (commandName === 'cmake_policy' && systemCache.policies.has(cursorTarget?.text ?? word)) {
            helpRequest = { arg: '--help-policy', category: 'policy', label: cursorTarget?.text ?? word };
        } else if (cursorTarget?.subject === DefinitionSubject.Variable
            && hoveredVariableName !== null
            && systemCache.variables.has(cursorTarget.text)) {
            helpRequest = { arg: '--help-variable', category: 'variable', label: cursorTarget.text };
        } else if (cursorTarget?.subject === DefinitionSubject.Property
            && systemCache.properties.has(cursorTarget.text)) {
            helpRequest = { arg: '--help-property', category: 'property', label: cursorTarget.text };
        }

        if (helpRequest) {
            try {
                throwIfCancelled(token);
                let helpLabel = helpRequest.label;
                let stdout = await this.getCMakeHelp(workspaceState, helpRequest.arg, helpLabel);
                throwIfCancelled(token);
                const languagePlaceholderPattern = /_(CXX|C)(_)?$/;
                if (stdout === null && languagePlaceholderPattern.test(helpLabel)) {
                    const modifiedLabel = helpLabel.replace(languagePlaceholderPattern, '_<LANG>$2');
                    stdout = await this.getCMakeHelp(workspaceState, helpRequest.arg, modifiedLabel);
                    throwIfCancelled(token);
                    if (stdout !== null) {
                        this.logger.debug(`Hover help fallback succeeded for ${helpLabel} -> ${modifiedLabel}`);
                    }
                }

                if (stdout !== null) {
                    return {
                        contents: {
                            kind: 'markdown',
                            value: helpRequest.category === 'variable'
                                ? this.appendCacheEntryDetails(stdout, workspaceState, hoveredVariableName)
                                : stdout,
                        }
                    };
                }

            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }
                this.logger.debug(`Hover help lookup failed for ${helpRequest.category} ${helpRequest.label}: ${error instanceof Error ? error.message : String(error)}`);
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

    private hasUserCommandBinding(
        workspaceState: WorkspaceState,
        uri: string,
        position: Position,
    ): boolean {
        const resolver = new SymbolBindingResolver(
            workspaceState.symbolIndex,
            this.getEntryFilePath(uri),
            uri,
        );
        const occurrence = resolver.findOccurrenceAt(position, 'command');
        return !!occurrence && resolver.resolveDefinitions(occurrence, false).declarations.length > 0;
    }

    private hasVariableOccurrence(
        workspaceState: WorkspaceState,
        uri: string,
        position: Position,
        cursorTarget: ReturnType<typeof resolveCursorTarget>,
    ): boolean {
        const resolver = new SymbolBindingResolver(
            workspaceState.symbolIndex,
            this.getEntryFilePath(uri),
            uri,
        );
        const indexedOccurrence = !!resolver.findOccurrenceAt(position, 'variable')
            || !!resolver.findOccurrenceAt(position, 'cache-variable')
            || !!resolver.findOccurrenceAt(position, 'environment-variable');
        if (indexedOccurrence) {
            return true;
        }

        const argumentSpan = cursorTarget.argumentSpan;
        if (!argumentSpan) {
            return false;
        }
        const cursorOffset = textOffsetAtPosition(argumentSpan.start, argumentSpan.text, position);
        return cursorOffset !== null && findVariableReferences(
            argumentSpan.text,
            argumentSpan.allowsVariableExpansion,
        ).some(reference => reference.name === cursorTarget.text
            && cursorOffset >= reference.referenceStartOffset
            && cursorOffset <= reference.referenceEndOffset);
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
        if (snapshot?.buildDirectory && isPathEqualOrInside(snapshot.buildDirectory, resolvedUri.fsPath)) {
            details.push(this.formatHoverBooleanLine('hover.file.inBuildDirectory', true));
        }

        return {
            contents: {
                kind: 'markdown',
                value: details.join('  \n'),
            }
        };
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
        if (docUri === entryCMakeLists.toString()) {
            return entryCMakeLists.toString();
        }

        if (fs.existsSync(entryCMakeLists.fsPath)
            && workspaceState.symbolIndex.getCache(entryCMakeLists.toString())
            && workspaceState.symbolIndex.getReachableFiles(entryCMakeLists.toString()).includes(docUri)) {
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
        throwIfCancelled(token);
        await this.ensureEnvironmentInitialized(params.textDocument.uri);

        while (true) {
            throwIfCancelled(token);
            const document = this.documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }

            const workspaceState = this.getWorkspaceStateForUri(document.uri);
            await this.ensureCMakeToolsStateReady(workspaceState);
            throwIfCancelled(token);
            const analysisGeneration = workspaceState.analysisGeneration;
            const cmakeSnapshotGeneration = workspaceState.cmakeSnapshotGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, document.uri);
            const workspaceSymbolGeneration = workspaceState.workspaceSymbolGeneration;
            // Only the current document is on completion's foreground path. Other
            // open documents are refreshed by their debounced diagnostics.
            const snapshot = await this.ensureParsedFile(document.uri, 'completion');
            if (!await this.ensureFileIndexedAsync(document.uri, snapshot, analysisGeneration)
                || workspaceState.analysisGeneration !== analysisGeneration
                || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
                || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }
            throwIfCancelled(token);

            const entryFileSource = this.getEntryFilePath(document.uri);
            const word = getWordAtPosition(document, params.position).text;
            const snapshotTargetNames = workspaceState.cmakeToolsProjectSnapshot?.targetNames ?? [];
            const snapshotTestNames = workspaceState.cmakeToolsProjectSnapshot?.testNames ?? [];
            const completion = new Completion(
                snapshot.flatCommands,
                snapshot.tokenStream,
                snapshotTargetNames,
                word,
                this.logger,
                workspaceState.symbolIndex,
                document.uri,
                entryFileSource,
                workspaceState.workspaceFolder.toString(),
                snapshotTestNames,
            );
            const startCompletion = Date.now();
            const result = await completion.onCompletion(params);
            throwIfCancelled(token);
            if (workspaceState.analysisGeneration !== analysisGeneration
                || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
                || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
                || (completion.usedWorkspaceSymbols
                    && workspaceState.workspaceSymbolGeneration !== workspaceSymbolGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }

            const elapsed = Date.now() - startCompletion;
            const itemCount = Array.isArray(result) ? result.length : result?.items?.length ?? 0;
            const isIncomplete = !Array.isArray(result) && result?.isIncomplete ? ' (incomplete)' : '';
            this.logger.debug(
                `Completion returned ${itemCount} item(s)${isIncomplete} in ${elapsed}ms for ${document.uri} (word="${word}", line=${params.position.line}, col=${params.position.character})`
            );
            return result;
        }
    }

    private async onCompletionResolve(item: CompletionItem, token: CancellationToken): Promise<CompletionItem> {
        throwIfCancelled(token);
        const workspaceState = this.getWorkspaceStateByKey(getCompletionWorkspaceKey(item.data));
        const completionType = getCompletionItemType(item.data);
        if (completionType === undefined) {
            return item;
        }

        if (completionType === CompletionItemType.PkgConfigModules) {
            item.documentation = workspaceState?.symbolIndex.pkgConfigModules.get(item.label);
            return item;
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
                return item;
        }
        const helpLabel = getCompletionHelpLabel(item.data) ?? item.label;
        if (!workspaceState) {
            return item;
        }

        const stdout = await this.getCMakeHelp(workspaceState, helpArg, helpLabel, true);
        throwIfCancelled(token);
        if (stdout !== null) {
            item.documentation = {
                kind: 'markdown',
                value: stdout,
            };
        }
        return item;
    }

    private async onSignatureHelp(params: SignatureHelpParams, token: CancellationToken): Promise<SignatureHelp | null> {
        throwIfCancelled(token);
        const pos = params.position;
        const uri = params.textDocument.uri;
        const snapshot = await this.ensureParsedFile(uri, 'signature help');
        throwIfCancelled(token);
        const commands = snapshot.flatCommands;
        const tokenStream = snapshot.tokenStream;
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

    private async onDocumentFormatting(params: DocumentFormattingParams, token: CancellationToken): Promise<TextEdit[] | null> {
        throwIfCancelled(token);
        const uri = params.textDocument.uri;
        const document = this.documents.get(uri);
        if (!document) {
            return null;
        }

        const documentVersion = document.version;
        const originalText = document.getText();
        const snapshot = await this.ensureParsedFile(uri, 'formatting');
        throwIfCancelled(token);
        const currentDocument = this.documents.get(uri);
        if (
            !currentDocument ||
            currentDocument.version !== documentVersion ||
            !sourceRevisionsEqual(snapshot.revision, { kind: 'document', version: documentVersion })
        ) {
            this.logger.debug(`Skipped formatting stale document: ${uri}`);
            return null;
        }

        if (snapshot.syntaxDiagnostics.length > 0) {
            this.logger.debug(`Skipped formatting document with syntax errors: ${uri}`);
            return null;
        }

        const tabSize = params.options.tabSize;
        const formatListener = new Formatter(tabSize, snapshot.tokenStream);
        try {
            formatListener.format(snapshot.flatCommands);
        } catch (error) {
            this.logger.error(`Failed to format document: ${error}`);
            return null;
        }

        if (this.documents.get(uri)?.version !== documentVersion) {
            this.logger.debug(`Discarded formatting result for changed document: ${uri}`);
            return null;
        }

        if (formatListener.formatted === originalText) {
            return [];
        }

        const range: Range = {
            start: { line: 0, character: 0 },
            end: document.positionAt(originalText.length)
        };

        return [
            {
                range: range,
                newText: formatListener.formatted
            }
        ];
    }

    private async onDocumentSymbol(params: DocumentSymbolParams, token: CancellationToken): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
        throwIfCancelled(token);
        const snapshot = await this.ensureParsedFile(params.textDocument.uri, 'document symbols');
        throwIfCancelled(token);
        const symbolListener = new SymbolListener();
        ParseTreeWalker.DEFAULT.walk(symbolListener, snapshot.fileContext);
        throwIfCancelled(token);
        return symbolListener.getSymbols();
    }

    private async onDefinition(params: DefinitionParams, token: CancellationToken): Promise<Location | Location[] | LocationLink[] | null> {
        const uri: string = params.textDocument.uri;
        while (true) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(uri);
            await this.ensureCMakeToolsStateReady(workspaceState);
            throwIfCancelled(token);
            const analysisGeneration = workspaceState.analysisGeneration;
            const cmakeSnapshotGeneration = workspaceState.cmakeSnapshotGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, uri);
            const workspaceSymbolGeneration = workspaceState.workspaceSymbolGeneration;
            const snapshot = await this.ensureParsedFile(uri, 'definition');
            await this.ensureOpenDocumentIndexes(workspaceState);
            if (workspaceState.analysisGeneration !== analysisGeneration
                || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
                || !this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }
            throwIfCancelled(token);
            if (inComments(params.position, snapshot.comments)) {
                return null;
            }

            const command = findCommandAtPosition(snapshot.flatCommands, params.position);
            if (command === null) {
                const recovered = await this.resolveRecoveredCommandDefinition(workspaceState, snapshot, params, token);
                if (workspaceState.analysisGeneration === analysisGeneration
                    && workspaceState.cmakeSnapshotGeneration === cmakeSnapshotGeneration
                    && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                    && (!recovered.usedWorkspaceFallback
                        || workspaceState.workspaceSymbolGeneration === workspaceSymbolGeneration)
                    && await this.isParsedSnapshotCurrent(snapshot)) {
                    return recovered.locations;
                }
                continue;
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
                this.ensureFileIndexedForEntry.bind(this),
            );
            const result = await resolver.resolve(params);
            if (workspaceState.analysisGeneration === analysisGeneration
                && workspaceState.cmakeSnapshotGeneration === cmakeSnapshotGeneration
                && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                && (!resolver.usedWorkspaceFallback
                    || workspaceState.workspaceSymbolGeneration === workspaceSymbolGeneration)
                && await this.isParsedSnapshotCurrent(snapshot)) {
                return result;
            }
        }
    }

    private async onReferences(params: ReferenceParams, token: CancellationToken): Promise<Location[] | null> {
        const uri: string = params.textDocument.uri;
        while (true) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(uri);
            const analysisGeneration = workspaceState.analysisGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, uri);
            const snapshot = await this.ensureParsedFile(uri, 'references');
            await this.ensureOpenDocumentIndexes(workspaceState);
            if (workspaceState.analysisGeneration !== analysisGeneration
                || !this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }
            throwIfCancelled(token);
            if (inComments(params.position, snapshot.comments)) {
                return null;
            }

            const command = findCommandAtPosition(snapshot.flatCommands, params.position);
            if (command === null) {
                const binding = await this.resolveRecoveredCommandReferences(workspaceState, snapshot, params, token);
                if (workspaceState.analysisGeneration === analysisGeneration
                    && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                    && await this.isParsedSnapshotCurrent(snapshot)) {
                    return binding && binding.locations.length > 0 ? binding.locations : null;
                }
                continue;
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
                this.ensureFileIndexedForEntry.bind(this),
            );
            const result = await resolver.resolve(params);
            if (workspaceState.analysisGeneration === analysisGeneration
                && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                && await this.isParsedSnapshotCurrent(snapshot)) {
                return result;
            }
        }
    }

    private async onRename(params: RenameParams, token: CancellationToken): Promise<WorkspaceEdit | null> {
        const uri: string = params.textDocument.uri;
        while (true) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(uri);
            const analysisGeneration = workspaceState.analysisGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, uri);
            const snapshot = await this.ensureParsedFile(uri, 'rename');
            await this.ensureOpenDocumentIndexes(workspaceState);
            if (workspaceState.analysisGeneration !== analysisGeneration
                || !this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }
            throwIfCancelled(token);
            if (inComments(params.position, snapshot.comments)) {
                return null;
            }

            const command = findCommandAtPosition(snapshot.flatCommands, params.position);
            if (command === null) {
                const binding = await this.resolveRecoveredCommandReferences(
                    workspaceState,
                    snapshot,
                    {
                        textDocument: params.textDocument,
                        position: params.position,
                        context: { includeDeclaration: true },
                    },
                    token,
                );
                const result = binding
                    && binding.complete
                    && binding.safeForRename
                    && binding.symbolId
                    ? this.createRenameWorkspaceEdit(binding.locations, params.newName)
                    : null;
                if (workspaceState.analysisGeneration === analysisGeneration
                    && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                    && await this.isParsedSnapshotCurrent(snapshot)) {
                    return result;
                }
                continue;
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
                this.ensureFileIndexedForEntry.bind(this),
            );
            const renameResolver = new RenameResolver(refResolver);
            const result = await renameResolver.resolve(params, () => token.isCancellationRequested);
            if (workspaceState.analysisGeneration === analysisGeneration
                && this.isProjectGenerationCurrent(workspaceState, uri, projectGeneration)
                && await this.isParsedSnapshotCurrent(snapshot)) {
                return result;
            }
        }
    }

    private async resolveRecoveredCommandDefinition(
        workspaceState: WorkspaceState,
        snapshot: ParsedFileSnapshot,
        params: DefinitionParams,
        token: CancellationToken,
    ): Promise<RecoveredDefinitionResult> {
        const context = await this.getRecoveredCommandBindingContext(workspaceState, snapshot, params.position, token);
        if (!context) {
            return { locations: null, usedWorkspaceFallback: false };
        }

        const binding = context.resolver.resolveDefinitions(context.occurrence);
        const locations = binding.declarations.map(declaration => ({
            uri: declaration.uri,
            range: declaration.range,
        }));
        return {
            locations: locations.length > 0 ? locations : null,
            usedWorkspaceFallback: binding.usedWorkspaceFallback,
        };
    }

    private async resolveRecoveredCommandReferences(
        workspaceState: WorkspaceState,
        snapshot: ParsedFileSnapshot,
        params: ReferenceParams,
        token: CancellationToken,
    ): Promise<ReferenceBinding | null> {
        const context = await this.getRecoveredCommandBindingContext(workspaceState, snapshot, params.position, token);
        return context?.resolver.findReferences(context.occurrence, params.context.includeDeclaration) ?? null;
    }

    private async getRecoveredCommandBindingContext(
        workspaceState: WorkspaceState,
        snapshot: ParsedFileSnapshot,
        position: Position,
        token: CancellationToken,
    ): Promise<{ resolver: SymbolBindingResolver; occurrence: SymbolOccurrence } | null> {
        const recoveredCommand = findRecoveredCommandInfoAtPosition(snapshot.tokenStream, position);
        if (!recoveredCommand?.isOnCommandName) {
            return null;
        }

        const entryFile = await this.ensureSymbolProjectEntry(snapshot.uri, workspaceState, token);
        const resolver = new SymbolBindingResolver(workspaceState.symbolIndex, entryFile, snapshot.uri);
        const occurrence = resolver.findOccurrenceAt(position, 'command');
        return occurrence ? { resolver, occurrence } : null;
    }

    private async ensureSymbolProjectEntry(
        uri: string,
        workspaceState: WorkspaceState,
        token: CancellationToken,
    ): Promise<string> {
        const rootEntry = Utils.joinPath(workspaceState.workspaceFolder, 'CMakeLists.txt').toString();
        if (fs.existsSync(URI.parse(rootEntry).fsPath)) {
            await this.populateIndexTopDownAsync(rootEntry, new Set(), token);
            if (workspaceState.symbolIndex.getReachableFiles(rootEntry).includes(uri)) {
                return rootEntry;
            }
        }

        const entryFile = workspaceState.symbolIndex.findEntryFile(uri) ?? uri;
        await this.populateIndexTopDownAsync(entryFile, new Set(), token);
        return entryFile;
    }

    private createRenameWorkspaceEdit(locations: Location[], newName: string): WorkspaceEdit {
        const changes: NonNullable<WorkspaceEdit['changes']> = {};
        for (const location of locations) {
            (changes[location.uri] ??= []).push({ range: location.range, newText: newName });
        }
        return { changes };
    }

    private async onWorkspaceSymbol(
        params: WorkspaceSymbolParams,
        token: CancellationToken,
    ): Promise<SymbolInformation[] | null> {
        while (true) {
            throwIfCancelled(token);
            const workspaceFolders = this.getWorkspaceFolders();
            const workspaceSymbolGenerations = new Map(workspaceFolders.map(folder => {
                const state = this.getWorkspaceState(folder);
                return [folder.toString(), state.workspaceSymbolGeneration] as const;
            }));

            await Promise.all(workspaceFolders.map(folder =>
                this.ensureOpenDocumentIndexes(this.getWorkspaceState(folder))
            ));
            await this.ensureAllWorkspaceFoldersIndexed('workspace symbol request');
            throwIfCancelled(token);

            const currentWorkspaceKeys = new Set(this.getWorkspaceFolders().map(folder => folder.toString()));
            if (currentWorkspaceKeys.size !== workspaceFolders.length
                || workspaceFolders.some(folder => !currentWorkspaceKeys.has(folder.toString()))
                || workspaceFolders.some(folder =>
                    this.getWorkspaceState(folder).workspaceSymbolGeneration
                        !== workspaceSymbolGenerations.get(folder.toString())
                )) {
                continue;
            }

            const results = workspaceFolders.map(folder => {
                const resolver = new WorkspaceSymbolResolver(
                    this.getWorkspaceState(folder).symbolIndex,
                    folder.toString(),
                );
                return resolver.resolve(params) ?? [];
            });
            return results.flat();
        }
    }

    private async onSemanticTokens(params: SemanticTokensParams, token: CancellationToken): Promise<SemanticTokens> {
        throwIfCancelled(token);
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { data: [] };
        }

        while (this.documents.get(document.uri)) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(document.uri);
            const analysisGeneration = workspaceState.analysisGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, document.uri);
            const snapshot = await this.ensureParsedFile(document.uri, 'semantic tokens');
            throwIfCancelled(token);
            if (!await this.ensureFileIndexedAsync(document.uri, snapshot, analysisGeneration)
                || workspaceState.analysisGeneration !== analysisGeneration
                || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }

            const docUri = URI.parse(document.uri);
            const entryUri = this.getEntryFilePath(document.uri);
            const builder = createTokenBuilder(document.uri);
            const semanticListener = new SemanticTokenListener(docUri.toString(), workspaceState.symbolIndex, entryUri, builder);
            ParseTreeWalker.DEFAULT.walk(semanticListener, snapshot.fileContext);
            throwIfCancelled(token);
            return semanticListener.getSemanticTokens();
        }

        return { data: [] };
    }

    private async onSemanticTokensDelta(params: SemanticTokensDeltaParams, token: CancellationToken): Promise<SemanticTokens | SemanticTokensDelta> {
        throwIfCancelled(token);
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return { edits: [] };
        }

        while (this.documents.get(document.uri)) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(document.uri);
            const analysisGeneration = workspaceState.analysisGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, document.uri);
            const snapshot = await this.ensureParsedFile(document.uri, 'semantic tokens delta');
            throwIfCancelled(token);
            if (!await this.ensureFileIndexedAsync(document.uri, snapshot, analysisGeneration)
                || workspaceState.analysisGeneration !== analysisGeneration
                || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }

            const builder = getTokenBuilder(document.uri);
            builder.previousResult(params.previousResultId);
            const docUri = URI.parse(document.uri);
            const entryUri = this.getEntryFilePath(document.uri);
            const semanticListener = new SemanticTokenListener(docUri.toString(), workspaceState.symbolIndex, entryUri, builder);
            ParseTreeWalker.DEFAULT.walk(semanticListener, snapshot.fileContext);
            throwIfCancelled(token);
            return semanticListener.buildEdits();
        }

        return { edits: [] };
    }

    private onCodeAction(params: CodeActionParams): (Command | CodeAction)[] | null {
        if (params.context.only
            && !params.context.only.some(kind => kind === CodeActionKind.Empty
                || kind === CodeActionKind.QuickFix)) {
            return [];
        }

        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        return params.context.diagnostics
            .filter(diagnostic => diagnostic.code === DIAG_CODE_CMD_CASE
                && diagnostic.source === 'cmake-intellisense')
            .map(diagnostic => {
                const commandName = document.getText(diagnostic.range);
                return {
                    title: localize('codeAction.cmdCase', commandName),
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diagnostic],
                    isPreferred: true,
                    edit: {
                        changes: {
                            [params.textDocument.uri]: [{
                                range: diagnostic.range,
                                newText: commandName.toLowerCase(),
                            }]
                        }
                    }
                };
            });
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
    private async onDidChangeConfiguration(_params: DidChangeConfigurationParams) {
        await Promise.all(this.getWorkspaceFolders().map(async folder => {
            const workspaceState = this.getWorkspaceState(folder);
            const extSettings = await this.getExtSettings(folder.toString());
            const environmentChanged = extSettings.cmakePath !== workspaceState.extSettings.cmakePath
                || extSettings.pkgConfigPath !== workspaceState.extSettings.pkgConfigPath;
            const workspaceIgnoreDirectoriesChanged = !this.haveSameStringEntries(
                this.getWorkspaceIgnoreDirectories(workspaceState.extSettings),
                this.getWorkspaceIgnoreDirectories(extSettings),
            );
            const excludeCMakeBuildDirectoriesChanged = extSettings.excludeCMakeBuildDirectories
                !== workspaceState.extSettings.excludeCMakeBuildDirectories;

            if (environmentChanged) {
                await this.startEnvironmentInitialization(folder, extSettings);
                await this.ensureWorkspaceFolderIndexed(folder, 'CMake environment configuration changed');
                return;
            }
            workspaceState.extSettings = extSettings;
            this.logger.setLevel(extSettings.loggingLevel);

            if (workspaceIgnoreDirectoriesChanged || excludeCMakeBuildDirectoriesChanged) {
                this.clearWorkspaceFolderSnapshots(folder, 'workspace scan policy changed');
                await this.ensureWorkspaceFolderIndexed(folder, 'workspace scan policy changed');
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
        // Never expose symbols from a previous document version as if they were
        // current. Dependency contexts are retained separately so parser recovery
        // cannot temporarily disconnect the stable project graph.
        const workspaceState = this.getWorkspaceStateForUri(event.document.uri);
        const affectedEntries = this.getAffectedProjectEntries(workspaceState, event.document.uri);
        this.rememberAffectedProjectEntries(workspaceState, event.document.uri, affectedEntries);
        this.bumpProjectGenerations(workspaceState, affectedEntries);
        workspaceState.symbolIndex.deleteCache(event.document.uri, {
            retainDependencyContexts: true,
        });
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

    private rescheduleDiagnosticsIfVersionIsCurrent(uri: string, version: number): void {
        const latestDocument = this.documents.get(uri);
        if (latestDocument?.version === version) {
            this.scheduleDiagnosticsForDocument(latestDocument);
        }
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
        await this.ensureCMakeToolsStateReady(workspaceState);
        this.logger.debug(`Diagnostics environment check finished for ${document.uri} in ${Date.now() - ensureEnvironmentStart}ms`);

        const analysisGeneration = workspaceState.analysisGeneration;
        const cmakeSnapshotGeneration = workspaceState.cmakeSnapshotGeneration;
        const projectGeneration = this.captureProjectGeneration(workspaceState, document.uri);
        const snapshot = await this.ensureParsedFile(document.uri, 'document diagnostics');
        if (!sourceRevisionsEqual(snapshot.revision, { kind: 'document', version: startVersion })) {
            this.diagnosticsDroppedStaleVersionCount++;
            return;
        }
        if (!await this.ensureFileIndexedAsync(
            document.uri,
            snapshot,
            analysisGeneration,
        )
            || workspaceState.analysisGeneration !== analysisGeneration
            || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
            || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
            || !await this.isParsedSnapshotCurrent(snapshot)) {
            this.diagnosticsDroppedStaleVersionCount++;
            this.rescheduleDiagnosticsIfVersionIsCurrent(document.uri, startVersion);
            return;
        }
        const { fileContext, flatCommands } = snapshot;

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
                ...snapshot.syntaxDiagnostics,
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
        if (workspaceState.analysisGeneration !== analysisGeneration
            || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
            || !this.isProjectGenerationCurrent(workspaceState, document.uri, projectGeneration)
            || !await this.isParsedSnapshotCurrent(snapshot)) {
            this.diagnosticsDroppedStaleVersionCount++;
            this.rescheduleDiagnosticsIfVersionIsCurrent(document.uri, startVersion);
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
        while (true) {
            throwIfCancelled(token);
            const workspaceState = this.getWorkspaceStateForUri(params.textDocument.uri);
            await this.ensureCMakeToolsStateReady(workspaceState);
            throwIfCancelled(token);
            const analysisGeneration = workspaceState.analysisGeneration;
            const cmakeSnapshotGeneration = workspaceState.cmakeSnapshotGeneration;
            const projectGeneration = this.captureProjectGeneration(workspaceState, params.textDocument.uri);
            const snapshot = await this.ensureParsedFile(params.textDocument.uri, 'document links');
            await this.populateIndexTopDownAsync(params.textDocument.uri, new Set<string>(), token);
            if (workspaceState.analysisGeneration !== analysisGeneration
                || workspaceState.cmakeSnapshotGeneration !== cmakeSnapshotGeneration
                || !this.isProjectGenerationCurrent(
                    workspaceState,
                    params.textDocument.uri,
                    projectGeneration,
                )
                || !await this.isParsedSnapshotCurrent(snapshot)) {
                continue;
            }
            throwIfCancelled(token);
            const linkInfo = await DocumentLinkInfo.create(
                snapshot.flatCommands,
                params.textDocument.uri,
                workspaceState.symbolIndex,
                this.getEntryFilePath(params.textDocument.uri),
                this.getWorkspaceFolderForUri(params.textDocument.uri).fsPath,
                this.getFlatCommandsAsync.bind(this),
                workspaceState.fileApiRawSnapshot,
                workspaceState.cmakeToolsProjectSnapshot?.buildDirectory,
            );
            throwIfCancelled(token);
            if (workspaceState.analysisGeneration === analysisGeneration
                && workspaceState.cmakeSnapshotGeneration === cmakeSnapshotGeneration
                && this.isProjectGenerationCurrent(
                    workspaceState,
                    params.textDocument.uri,
                    projectGeneration,
                )
                && await this.isParsedSnapshotCurrent(snapshot)) {
                return linkInfo.links;
            }
        }
    }

    private async onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        const uri = event.document.uri;
        const diagnosticsTimer = this.diagnosticsTimerByUri.get(uri);
        if (diagnosticsTimer) {
            clearTimeout(diagnosticsTimer);
            this.diagnosticsTimerByUri.delete(uri);
        }
        this.diagnosticsSequenceByUri.delete(uri);
        deleteTokenBuilder(uri);
        this.parsedFiles.delete(uri);
        const docUri = URI.parse(uri);
        const workspaceFolderUri = this.getWorkspaceFolderForUri(uri);
        const workspaceState = this.getWorkspaceState(workspaceFolderUri);
        const affectedEntries = this.getAffectedProjectEntries(workspaceState, uri);
        this.bumpProjectGenerations(workspaceState, affectedEntries);
        const isPersistedWorkspaceFile = this.isUriInsideWorkspace(docUri, workspaceFolderUri) && fs.existsSync(docUri.fsPath);

        if (isPersistedWorkspaceFile) {
            this.rememberAffectedProjectEntries(workspaceState, uri, affectedEntries);
            await this.indexWorkspaceFile(uri);
        } else {
            this.structureFingerprintsByUri.delete(uri);
            workspaceState.affectedProjectEntriesByUri.delete(uri);
            workspaceState.affectedProjectDependencyInputsByUri.delete(uri);
            workspaceState.symbolIndex.deleteCache(uri);
            this.scheduleProjectReindex(
                workspaceState,
                affectedEntries,
                `closed non-persisted CMake file ${uri}`,
            );
        }

    }

    private onDidChangeWatchedFiles(params: DidChangeWatchedFilesParams): void {
        const touchedWorkspaceStates = new Set<WorkspaceState>();
        for (const change of params.changes) {
            const parsedUri = URI.parse(change.uri);
            if (parsedUri.scheme !== 'file') {
                continue;
            }
            const workspaceFolder = this.getWorkspaceFolderForUri(change.uri);
            if (!this.isUriInsideWorkspace(parsedUri, workspaceFolder)) {
                continue;
            }

            const workspaceState = this.getWorkspaceState(workspaceFolder);
            workspaceState.pendingWatchedFileChanges.set(change.uri, change);
            touchedWorkspaceStates.add(workspaceState);
        }

        for (const workspaceState of touchedWorkspaceStates) {
            if (workspaceState.watchedFileFlushTimer) {
                clearTimeout(workspaceState.watchedFileFlushTimer);
            }
            workspaceState.watchedFileFlushTimer = setTimeout(() => {
                workspaceState.watchedFileFlushTimer = undefined;
                this.enqueueWatchedFileChanges(workspaceState);
            }, WATCHED_FILES_DEBOUNCE_MS);
        }
    }

    private enqueueWatchedFileChanges(workspaceState: WorkspaceState): void {
        const previousProcessing = workspaceState.watchedFileProcessing;
        const processing = (previousProcessing
            ? previousProcessing.catch(() => undefined).then(() => this.processPendingWatchedFileChanges(workspaceState))
            : this.processPendingWatchedFileChanges(workspaceState)
        ).catch(error => {
            this.logger.error(
                `Failed to process watched CMake files for ${workspaceState.workspaceFolder.fsPath}`,
                error instanceof Error ? error : new Error(String(error)),
            );
        }).finally(() => {
            if (workspaceState.watchedFileProcessing === processing) {
                workspaceState.watchedFileProcessing = undefined;
            }
        });
        workspaceState.watchedFileProcessing = processing;
    }

    private async processPendingWatchedFileChanges(workspaceState: WorkspaceState): Promise<void> {
        const latestChanges = Array.from(workspaceState.pendingWatchedFileChanges.values());
        workspaceState.pendingWatchedFileChanges.clear();
        const filePolicy = this.getWorkspaceCMakeFilePolicy(workspaceState);

        for (const change of latestChanges) {
            // Open documents are authoritative; their didChange stream will update
            // the snapshot and symbol cache independently of disk notifications.
            if (this.documents.get(change.uri)) {
                continue;
            }

            const parsedUri = URI.parse(change.uri);
            if (parsedUri.scheme !== 'file') {
                continue;
            }
            if (!await filePolicy.accepts(parsedUri.fsPath)) {
                continue;
            }

            const affectedEntries = this.getAffectedProjectEntries(workspaceState, change.uri);
            this.rememberAffectedProjectEntries(workspaceState, change.uri, affectedEntries);
            this.bumpProjectGenerations(workspaceState, affectedEntries);
            this.parsedFiles.delete(change.uri);
            if (change.type === FileChangeType.Deleted) {
                this.structureFingerprintsByUri.delete(change.uri);
                workspaceState.symbolIndex.deleteCache(change.uri);
                workspaceState.affectedProjectEntriesByUri.delete(change.uri);
                workspaceState.affectedProjectDependencyInputsByUri.delete(change.uri);
                this.scheduleProjectReindex(
                    workspaceState,
                    affectedEntries,
                    `deleted CMake file ${change.uri}`,
                );
                continue;
            }

            try {
                await this.indexWorkspaceFile(
                    change.uri,
                    undefined,
                    this.selectProjectEntry(change.uri, affectedEntries),
                    'watched CMake file changed',
                );
                if (change.type === FileChangeType.Created) {
                    workspaceState.affectedProjectEntriesByUri.delete(change.uri);
                    workspaceState.affectedProjectDependencyInputsByUri.delete(change.uri);
                    this.scheduleProjectReindex(
                        workspaceState,
                        [ALL_PROJECT_ENTRIES],
                        `created CMake file ${change.uri}`,
                        true,
                    );
                }
            } catch (error) {
                this.logger.error(
                    `Failed to incrementally index watched CMake file ${change.uri}`,
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }
    }

    private getAffectedProjectEntries(workspaceState: WorkspaceState, uri: string): Set<string> {
        const entries = new Set(workspaceState.affectedProjectEntriesByUri.get(uri));
        for (const entryFile of workspaceState.symbolIndex.getProjectEntriesForUri(uri)) {
            entries.add(entryFile);
        }
        if (entries.size === 0) {
            entries.add(this.getEntryFilePath(uri));
        }
        return entries;
    }

    private captureProjectGeneration(
        workspaceState: WorkspaceState,
        uri: string,
    ): ProjectGenerationSnapshot {
        const entryFile = this.getEntryFilePath(uri);
        return {
            entryFile,
            generation: workspaceState.projectGenerations.get(entryFile) ?? 0,
        };
    }

    private isProjectGenerationCurrent(
        workspaceState: WorkspaceState,
        uri: string,
        snapshot: ProjectGenerationSnapshot,
    ): boolean {
        return this.getEntryFilePath(uri) === snapshot.entryFile
            && (workspaceState.projectGenerations.get(snapshot.entryFile) ?? 0) === snapshot.generation;
    }

    private bumpProjectGenerations(workspaceState: WorkspaceState, entries: Iterable<string>): void {
        let changed = false;
        for (const entryFile of new Set(entries)) {
            workspaceState.projectGenerations.set(
                entryFile,
                (workspaceState.projectGenerations.get(entryFile) ?? 0) + 1,
            );
            changed = true;
        }
        if (changed) {
            workspaceState.workspaceSymbolGeneration++;
        }
    }

    private rememberAffectedProjectEntries(
        workspaceState: WorkspaceState,
        uri: string,
        entries = this.getAffectedProjectEntries(workspaceState, uri),
    ): void {
        const remembered = workspaceState.affectedProjectEntriesByUri.get(uri) ?? new Set<string>();
        for (const entryFile of entries) {
            remembered.add(entryFile);
        }
        workspaceState.affectedProjectEntriesByUri.set(uri, remembered);

        const inputsByEntry = workspaceState.affectedProjectDependencyInputsByUri.get(uri)
            ?? new Map<string, Set<string>>();
        for (const entryFile of remembered) {
            if (!inputsByEntry.has(entryFile)) {
                inputsByEntry.set(
                    entryFile,
                    workspaceState.symbolIndex.getProjectDependencyInputVariables(entryFile),
                );
            }
        }
        workspaceState.affectedProjectDependencyInputsByUri.set(uri, inputsByEntry);
    }

    private selectProjectEntry(uri: string, entries: ReadonlySet<string>): string {
        const preferredEntry = this.getEntryFilePath(uri);
        return entries.has(preferredEntry)
            ? preferredEntry
            : entries.values().next().value ?? preferredEntry;
    }

    private scheduleProjectReindex(
        workspaceState: WorkspaceState,
        entries: Iterable<string>,
        trigger: string,
        rebuildContexts = false,
    ): void {
        if (!workspaceState.environmentReady) {
            return;
        }

        let scheduled = false;
        for (const entryFile of entries) {
            const existing = workspaceState.pendingProjectReindexEntries.get(entryFile);
            workspaceState.pendingProjectReindexEntries.set(entryFile, {
                trigger,
                rebuildContexts: rebuildContexts || existing?.rebuildContexts === true,
            });
            scheduled = true;
        }
        if (!scheduled) {
            return;
        }

        if (workspaceState.projectReindexTimer) {
            clearTimeout(workspaceState.projectReindexTimer);
        }
        workspaceState.projectReindexTimer = setTimeout(() => {
            workspaceState.projectReindexTimer = undefined;
            this.enqueueProjectReindex(workspaceState);
        }, PROJECT_REINDEX_DEBOUNCE_MS);
        this.logger.debug(
            `[Project index] scheduled folder=${workspaceState.workspaceFolder.fsPath}, entries=${workspaceState.pendingProjectReindexEntries.size}, trigger=${trigger}, delay=${PROJECT_REINDEX_DEBOUNCE_MS}ms`
        );
    }

    private enqueueProjectReindex(workspaceState: WorkspaceState): void {
        if (workspaceState.projectReindexing || workspaceState.pendingProjectReindexEntries.size === 0) {
            return;
        }

        let processing: Promise<void>;
        processing = (async () => {
            while (workspaceState.pendingProjectReindexEntries.size > 0) {
                const activeWorkspaceScan = workspaceState.workspaceIndexing;
                if (activeWorkspaceScan) {
                    this.logger.debug(
                        `[Project index] waiting for workspace scan #${workspaceState.workspaceIndexingId ?? 'unknown'} in ${workspaceState.workspaceFolder.fsPath}`
                    );
                    await activeWorkspaceScan;
                }

                const allEntriesRequest = workspaceState.pendingProjectReindexEntries.get(ALL_PROJECT_ENTRIES);
                if (allEntriesRequest) {
                    workspaceState.pendingProjectReindexEntries.delete(ALL_PROJECT_ENTRIES);
                    const knownEntries = new Set(workspaceState.symbolIndex.getProjectEntries());
                    const workspaceRootEntry = Utils.joinPath(
                        workspaceState.workspaceFolder,
                        'CMakeLists.txt',
                    ).toString();
                    if (fs.existsSync(URI.parse(workspaceRootEntry).fsPath)) {
                        knownEntries.add(workspaceRootEntry);
                    }
                    for (const entryFile of knownEntries) {
                        const existing = workspaceState.pendingProjectReindexEntries.get(entryFile);
                        workspaceState.pendingProjectReindexEntries.set(entryFile, {
                            trigger: allEntriesRequest.trigger,
                            rebuildContexts: allEntriesRequest.rebuildContexts
                                || existing?.rebuildContexts === true,
                        });
                    }
                }

                const entries = Array.from(workspaceState.pendingProjectReindexEntries.entries());
                workspaceState.pendingProjectReindexEntries.clear();
                const generation = workspaceState.analysisGeneration;
                this.bumpProjectGenerations(workspaceState, entries.map(([entryFile]) => entryFile));

                for (const [entryFile, request] of entries) {
                    if (!this.isAnalysisGenerationCurrent(workspaceState.workspaceFolder, generation)) {
                        break;
                    }

                    const entryUri = URI.parse(entryFile);
                    if (request.rebuildContexts) {
                        workspaceState.symbolIndex.clearProjectContext(entryFile);
                    }
                    if (entryUri.scheme === 'file' && !fs.existsSync(entryUri.fsPath)) {
                        continue;
                    }

                    const startedAt = Date.now();
                    try {
                        await this.populateIndexTopDownAsync(
                            entryFile,
                            new Set(),
                            undefined,
                            `project refresh after ${request.trigger}`,
                            generation,
                        );
                        this.logger.info(
                            `[Project index] refreshed entry=${entryFile}, mode=${request.rebuildContexts ? 'rebuild' : 'reconcile'}, trigger=${request.trigger}, duration=${Date.now() - startedAt}ms`
                        );
                    } catch (error) {
                        if (isCancellationError(error)) {
                            break;
                        }
                        this.logger.error(
                            `Failed to refresh CMake project entry ${entryFile}`,
                            error instanceof Error ? error : new Error(String(error)),
                        );
                    }
                }
            }
        })().finally(() => {
            if (workspaceState.projectReindexing === processing) {
                workspaceState.projectReindexing = undefined;
            }
            if (workspaceState.pendingProjectReindexEntries.size > 0) {
                this.enqueueProjectReindex(workspaceState);
            }
        });
        workspaceState.projectReindexing = processing;
    }

    private async onDidChangeWorkspaceFolders(event: WorkspaceFoldersChangeEvent): Promise<void> {
        const removedKeys = new Set(event.removed.map(folder => folder.uri));
        for (const removed of event.removed) {
            const folderUri = URI.parse(removed.uri);
            const workspaceState = this.workspaceStates.get(folderUri.toString());
            if (workspaceState?.watchedFileFlushTimer) {
                clearTimeout(workspaceState.watchedFileFlushTimer);
            }
            workspaceState?.pendingWatchedFileChanges.clear();
            this.clearWorkspaceFolderSnapshots(folderUri, 'workspace folder removed');
            this.workspaceStates.delete(folderUri.toString());
        }

        this.workspaceFolders = this.workspaceFolders.filter(folder => !removedKeys.has(folder.toString()));
        for (const added of event.added) {
            const folderUri = URI.parse(added.uri);
            if (!this.workspaceFolders.some(folder => folder.toString() === folderUri.toString())) {
                this.workspaceFolders.push(folderUri);
            }
        }

        await Promise.all(event.added.map(async added => {
            const folderUri = URI.parse(added.uri);
            await this.ensureEnvironmentInitialized(folderUri);
            void this.ensureWorkspaceFolderIndexed(folderUri, 'workspace folder added');
        }));
    }

    private onShutdown() {
        for (const timer of this.diagnosticsTimerByUri.values()) {
            clearTimeout(timer);
        }
        this.diagnosticsTimerByUri.clear();
        for (const workspaceState of this.workspaceStates.values()) {
            if (workspaceState.watchedFileFlushTimer) {
                clearTimeout(workspaceState.watchedFileFlushTimer);
                workspaceState.watchedFileFlushTimer = undefined;
            }
            if (workspaceState.projectReindexTimer) {
                clearTimeout(workspaceState.projectReindexTimer);
                workspaceState.projectReindexTimer = undefined;
            }
            workspaceState.pendingWatchedFileChanges.clear();
            workspaceState.pendingProjectReindexEntries.clear();
            workspaceState.affectedProjectEntriesByUri.clear();
            workspaceState.affectedProjectDependencyInputsByUri.clear();
        }
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }

    // #endregion

    private getWorkspaceFolderForUri(docUri: string): URI {
        const documentUri = URI.parse(docUri);
        const workspaceFolders = this.getWorkspaceFolders();

        if (workspaceFolders.length === 0) {
            return URI.file(path.dirname(documentUri.fsPath));
        }

        let bestMatch: URI | undefined;
        for (const workspaceFolder of workspaceFolders) {
            if (!isPathEqualOrInside(workspaceFolder.fsPath, documentUri.fsPath)) {
                continue;
            }
            if (!bestMatch || workspaceFolder.fsPath.length > bestMatch.fsPath.length) {
                bestMatch = workspaceFolder;
            }
        }

        return bestMatch ?? workspaceFolders[0];
    }

    private getWorkspaceFolders(): URI[] {
        return [...this.workspaceFolders];
    }

    private isUriInsideWorkspace(documentUri: URI, workspaceFolder: URI): boolean {
        return isPathEqualOrInside(workspaceFolder.fsPath, documentUri.fsPath);
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

    private getWorkspaceCMakeFilePolicy(workspaceState: WorkspaceState): WorkspaceCMakeFilePolicy {
        const buildDirectory = workspaceState.cmakeToolsProjectSnapshot?.buildDirectory;
        const excludeBuildDirectories = workspaceState.extSettings.excludeCMakeBuildDirectories !== false;
        return new WorkspaceCMakeFilePolicy(workspaceState.workspaceFolder.fsPath, {
            ignoredDirectoryNames: this.getWorkspaceIgnoreDirectories(workspaceState.extSettings),
            excludeCMakeBuildDirectories: excludeBuildDirectories,
            excludedDirectoryPaths: excludeBuildDirectories && buildDirectory ? [buildDirectory] : [],
        });
    }

    private clearWorkspaceFolderSnapshots(workspaceFolder: URI, trigger: string): void {
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const previousGeneration = workspaceState.analysisGeneration;
        this.logger.debug(
            `[Workspace scan] invalidating folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${previousGeneration}->${previousGeneration + 1}, activeScan=${workspaceState.workspaceIndexingId ?? 'none'}, indexedGeneration=${workspaceState.workspaceIndexedGeneration ?? 'none'}`
        );
        if (workspaceState.projectReindexTimer) {
            clearTimeout(workspaceState.projectReindexTimer);
            workspaceState.projectReindexTimer = undefined;
        }
        workspaceState.pendingProjectReindexEntries.clear();
        workspaceState.affectedProjectEntriesByUri.clear();
        workspaceState.affectedProjectDependencyInputsByUri.clear();
        this.parsedFiles.deleteWhere(uri => this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder));
        for (const uri of this.structureFingerprintsByUri.keys()) {
            if (this.isUriInsideWorkspace(URI.parse(uri), workspaceFolder)) {
                this.structureFingerprintsByUri.delete(uri);
            }
        }

        workspaceState.cmakeToolsUpdateSequence++;
        workspaceState.analysisGeneration++;
        workspaceState.cmakeSnapshotGeneration++;
        workspaceState.workspaceSymbolGeneration++;
        workspaceState.projectGenerations.clear();
        workspaceState.symbolIndex.deleteCachesInDirectory(workspaceFolder.fsPath);
        workspaceState.symbolIndex.clearProjectContexts();
        this.resetWorkspaceIndexState(workspaceState);
    }

    private async ensureAllWorkspaceFoldersIndexed(trigger: string): Promise<void> {
        const workspaceFolders = this.getWorkspaceFolders();
        this.logger.debug(`[Workspace scan] batch request trigger=${trigger}, folders=${workspaceFolders.length}`);
        await Promise.all(workspaceFolders.map(folder => this.ensureWorkspaceFolderIndexed(folder, trigger)));
    }

    private resetWorkspaceIndexState(workspaceState: WorkspaceState): void {
        workspaceState.workspaceIndexedGeneration = undefined;
    }

    private ensureWorkspaceFolderIndexed(workspaceFolder: URI, trigger: string): Promise<void> {
        if (!this.workspaceFolders.some(folder => folder.toString() === workspaceFolder.toString())) {
            this.logger.debug(
                `[Workspace scan] skipped removed folder=${workspaceFolder.fsPath}, trigger=${trigger}`
            );
            return Promise.resolve();
        }
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const generation = workspaceState.analysisGeneration;
        this.logger.debug(
            `[Workspace scan] request folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${generation}, indexedGeneration=${workspaceState.workspaceIndexedGeneration ?? 'none'}, activeScan=${workspaceState.workspaceIndexingId ?? 'none'}, activeGeneration=${workspaceState.workspaceIndexingGeneration ?? 'none'}`
        );
        if (workspaceState.workspaceIndexedGeneration === generation) {
            this.logger.debug(`[Workspace scan] skipped already-indexed folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${generation}`);
            return Promise.resolve();
        }

        const existing = workspaceState.workspaceIndexing;
        if (existing) {
            if (workspaceState.workspaceIndexingGeneration === generation) {
                this.logger.debug(
                    `[Workspace scan] joined active scan #${workspaceState.workspaceIndexingId ?? 'unknown'} for folder=${workspaceFolder.fsPath}, requestedTrigger=${trigger}, activeTrigger=${workspaceState.workspaceIndexingTrigger ?? 'unknown'}, generation=${generation}`
                );
                return existing;
            }
            this.logger.debug(
                `[Workspace scan] queued behind active scan #${workspaceState.workspaceIndexingId ?? 'unknown'} for folder=${workspaceFolder.fsPath}, requestedTrigger=${trigger}, requestedGeneration=${generation}, activeGeneration=${workspaceState.workspaceIndexingGeneration ?? 'unknown'}`
            );
            return existing.then(() => this.ensureWorkspaceFolderIndexed(workspaceFolder, trigger));
        }

        const scanId = ++workspaceState.workspaceIndexSequence;
        const indexing = this.indexWorkspaceFolder(workspaceFolder, generation, scanId, trigger)
            .then(completed => {
                if (completed && this.isAnalysisGenerationCurrent(workspaceFolder, generation)) {
                    workspaceState.workspaceIndexedGeneration = generation;
                    this.logger.debug(`[Workspace scan #${scanId}] committed indexed generation=${generation} for folder=${workspaceFolder.fsPath}`);
                } else if (completed) {
                    this.logger.debug(`[Workspace scan #${scanId}] result was not committed because generation=${generation} is stale for folder=${workspaceFolder.fsPath}`);
                }
            })
            .catch(error => {
                this.logger.error(`Workspace scan #${scanId} failed for ${workspaceFolder.fsPath} (trigger=${trigger}, generation=${generation})`, error as Error);
            })
            .finally(() => {
                if (workspaceState.workspaceIndexing === indexing) {
                    workspaceState.workspaceIndexing = undefined;
                    workspaceState.workspaceIndexingId = undefined;
                    workspaceState.workspaceIndexingTrigger = undefined;
                    workspaceState.workspaceIndexingGeneration = undefined;
                }
            });
        workspaceState.workspaceIndexing = indexing;
        workspaceState.workspaceIndexingId = scanId;
        workspaceState.workspaceIndexingTrigger = trigger;
        workspaceState.workspaceIndexingGeneration = generation;
        return indexing;
    }

    private async indexWorkspaceFolder(
        workspaceFolder: URI,
        generation: number,
        scanId: number,
        trigger: string,
    ): Promise<boolean> {
        const start = Date.now();
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const parseTrigger = `workspace scan #${scanId}`;
        const abort = (phase: string, processedFiles: number, totalFiles: number): false => {
            const currentGeneration = this.workspaceStates.get(workspaceFolder.toString())?.analysisGeneration;
            this.logger.info(
                `[Workspace scan #${scanId}] aborted folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${generation}, currentGeneration=${currentGeneration ?? 'removed'}, phase=${phase}, processed=${processedFiles}/${totalFiles}, duration=${Date.now() - start}ms`
            );
            return false;
        };

        this.logger.info(
            `[Workspace scan #${scanId}] started folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${generation}`
        );
        this.logger.debug(
            `[Workspace scan #${scanId}] policy ignoredDirectories=${JSON.stringify(this.getWorkspaceIgnoreDirectories(workspaceState.extSettings))}, excludeBuildDirectories=${workspaceState.extSettings.excludeCMakeBuildDirectories !== false}, CMakeToolsBuildDirectory=${workspaceState.cmakeToolsProjectSnapshot?.buildDirectory ?? 'none'}`
        );
        const collectStart = Date.now();
        const files = await this.getWorkspaceCMakeFilePolicy(workspaceState).collectFiles();
        this.logger.info(
            `[Workspace scan #${scanId}] discovery finished folder=${workspaceFolder.fsPath}, files=${files.length}, duration=${Date.now() - collectStart}ms`
        );
        if (!this.isAnalysisGenerationCurrent(workspaceFolder, generation)) {
            return abort('after discovery', 0, files.length);
        }

        const progress = await this.connection.window.createWorkDoneProgress();
        progress.begin('CMake: Indexing workspace', 0, `0 / ${files.length}`);
        try {
            const workspaceFileUris = new Set(files.map(file => URI.file(file).toString()));
            const coveredFiles = new Set<string>();
            let projectEntries = 0;
            let standaloneFiles = 0;
            const indexProject = async (entryFile: string): Promise<void> => {
                projectEntries++;
                await this.populateIndexTopDownAsync(
                    entryFile,
                    new Set(),
                    undefined,
                    parseTrigger,
                    generation,
                );
                for (const reachableFile of workspaceState.symbolIndex.getReachableFiles(entryFile)) {
                    if (workspaceFileUris.has(reachableFile)) {
                        coveredFiles.add(reachableFile);
                    }
                }
            };

            const rootEntry = Utils.joinPath(workspaceFolder, 'CMakeLists.txt').toString();
            if (workspaceFileUris.has(rootEntry)) {
                await indexProject(rootEntry);
            }

            for (let i = 0; i < files.length; i++) {
                if (!this.isAnalysisGenerationCurrent(workspaceFolder, generation)) {
                    return abort('indexing', i, files.length);
                }
                const uri = URI.file(files[i]).toString();
                if (!coveredFiles.has(uri)) {
                    if (path.basename(files[i]) === 'CMakeLists.txt') {
                        await indexProject(uri);
                    } else {
                        await this.indexWorkspaceFile(uri, generation, uri, parseTrigger);
                        standaloneFiles++;
                        coveredFiles.add(uri);
                    }
                }
                progress.report(Math.round(((i + 1) / files.length) * 100), `${i + 1} / ${files.length}`);
                // ANTLR analysis is synchronous. Yield between files so pending
                // interactive LSP messages can run before the next background parse.
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (!this.isAnalysisGenerationCurrent(workspaceFolder, generation)) {
                return abort('final validation', files.length, files.length);
            }

            const elapsedMs = Date.now() - start;
            this.logger.info(
                `[Workspace scan #${scanId}] finished folder=${workspaceFolder.fsPath}, trigger=${trigger}, generation=${generation}, discovered=${files.length}, covered=${coveredFiles.size}, projectEntries=${projectEntries}, standaloneFiles=${standaloneFiles}, duration=${elapsedMs}ms`
            );
            return true;
        } catch (error) {
            if (isCancellationError(error)) {
                return abort('cancelled dependency traversal', 0, files.length);
            }
            throw error;
        } finally {
            progress.done();
        }
    }

    private isAnalysisGenerationCurrent(workspaceFolder: URI, generation: number): boolean {
        return this.workspaceStates.get(workspaceFolder.toString())?.analysisGeneration === generation;
    }

    private async indexWorkspaceFile(
        uri: string,
        generation?: number,
        entryFile?: string,
        parseTrigger = 'workspace file index',
    ): Promise<void> {
        const snapshot = await this.ensureParsedFile(uri, parseTrigger);
        const indexed = await this.ensureFileIndexedAsync(uri, snapshot, generation, entryFile, parseTrigger);

        // Closed workspace files only need their compact FileSymbolCache after
        // indexing. Reparse them on demand for features that require an ANTLR tree.
        if (indexed && !this.documents.get(uri) && this.parsedFiles.isCurrent(uri, snapshot.revision)) {
            this.parsedFiles.delete(uri);
        }
    }

    private async loadFileSource(uri: string): Promise<{ text: string; revision: SourceRevision }> {
        const openDocument = this.documents.get(uri);
        if (openDocument) {
            return {
                text: openDocument.getText(),
                revision: {
                    kind: 'document',
                    version: openDocument.version,
                },
            };
        }

        const parsedUri = URI.parse(uri);
        if (parsedUri.scheme !== 'file') {
            return {
                text: '',
                revision: { kind: 'missing' },
            };
        }

        try {
            // A save can replace or rewrite a file while it is being read. Only
            // publish a revision when metadata is stable around the read.
            while (true) {
                const before = await fs.promises.stat(parsedUri.fsPath);
                if (!before.isFile()) {
                    return {
                        text: '',
                        revision: { kind: 'missing' },
                    };
                }
                const text = await fs.promises.readFile(parsedUri.fsPath, 'utf8');
                const after = await fs.promises.stat(parsedUri.fsPath);
                if (before.mtimeMs !== after.mtimeMs
                    || before.ctimeMs !== after.ctimeMs
                    || before.size !== after.size) {
                    continue;
                }

                return {
                    text,
                    revision: {
                        kind: 'disk',
                        mtimeMs: after.mtimeMs,
                        ctimeMs: after.ctimeMs,
                        size: after.size,
                    },
                };
            }
        } catch {
            return {
                text: '',
                revision: { kind: 'missing' },
            };
        }
    }

    private async isSourceRevisionCurrent(uri: string, revision: SourceRevision): Promise<boolean> {
        const openDocument = this.documents.get(uri);
        if (openDocument) {
            return revision.kind === 'document' && revision.version === openDocument.version;
        }

        if (revision.kind === 'document') {
            return false;
        }

        const parsedUri = URI.parse(uri);
        if (parsedUri.scheme !== 'file') {
            return revision.kind === 'missing';
        }

        try {
            const stats = await fs.promises.stat(parsedUri.fsPath);
            return revision.kind === 'disk'
                && stats.isFile()
                && stats.mtimeMs === revision.mtimeMs
                && stats.ctimeMs === revision.ctimeMs
                && stats.size === revision.size;
        } catch {
            return revision.kind === 'missing';
        }
    }

    private async isParsedSnapshotCurrent(snapshot: ParsedFileSnapshot): Promise<boolean> {
        return this.parsedFiles.isCurrent(snapshot.uri, snapshot.revision)
            && await this.isSourceRevisionCurrent(snapshot.uri, snapshot.revision);
    }

    private onParsedSnapshotCommitted(next: ParsedFileSnapshot): void {
        const workspaceState = this.getWorkspaceStateForUri(next.uri);
        const affectedEntries = workspaceState.affectedProjectEntriesByUri.get(next.uri);
        const previousDependencyInputsByEntry = workspaceState
            .affectedProjectDependencyInputsByUri
            .get(next.uri);
        const hasSyntaxErrors = next.syntaxDiagnostics.length > 0;
        if (!hasSyntaxErrors) {
            const previousFingerprints = this.structureFingerprintsByUri.get(next.uri);
            const nextStructure = next.dependencyStructure;
            this.structureFingerprintsByUri.set(next.uri, {
                directFingerprint: nextStructure.directFingerprint,
                variableFingerprints: nextStructure.variableFingerprints,
            });

            let projectRefreshScheduled = false;
            if (previousFingerprints !== undefined) {
                const entries = affectedEntries ?? this.getAffectedProjectEntries(workspaceState, next.uri);
                if (previousFingerprints.directFingerprint !== nextStructure.directFingerprint) {
                    this.scheduleProjectReindex(
                        workspaceState,
                        entries,
                        `dependency commands changed in ${next.uri}`,
                    );
                    projectRefreshScheduled = true;
                }

                const changedVariables = new Set<string>();
                const variableNames = new Set([
                    ...previousFingerprints.variableFingerprints.keys(),
                    ...nextStructure.variableFingerprints.keys(),
                ]);
                for (const variableName of variableNames) {
                    if (previousFingerprints.variableFingerprints.get(variableName)
                        !== nextStructure.variableFingerprints.get(variableName)) {
                        changedVariables.add(variableName);
                    }
                }
                const dependsOnChangedVariable = (inputs: ReadonlySet<string>): boolean => {
                    return changedVariables.has('*')
                        || Array.from(changedVariables).some(variableName => inputs.has(variableName));
                };

                if (changedVariables.size > 0) {
                    if (dependsOnChangedVariable(nextStructure.dependencyInputVariables)) {
                        this.scheduleProjectReindex(
                            workspaceState,
                            entries,
                            `dependency input variable changed in ${next.uri}`,
                        );
                        projectRefreshScheduled = true;
                    }

                    const entriesToRebuild: string[] = [];
                    for (const entryFile of entries) {
                        const dependencyInputs = new Set(
                            previousDependencyInputsByEntry?.get(entryFile)
                                ?? workspaceState.symbolIndex.getProjectDependencyInputVariables(entryFile),
                        );
                        const pendingInputs = Array.from(dependencyInputs);
                        for (let index = 0; index < pendingInputs.length; index++) {
                            for (const referencedVariable of nextStructure.variableReferences.get(pendingInputs[index]) ?? []) {
                                if (!dependencyInputs.has(referencedVariable)) {
                                    dependencyInputs.add(referencedVariable);
                                    pendingInputs.push(referencedVariable);
                                }
                            }
                        }
                        if (dependsOnChangedVariable(dependencyInputs)) {
                            entriesToRebuild.push(entryFile);
                        }
                    }
                    if (entriesToRebuild.length > 0) {
                        this.scheduleProjectReindex(
                            workspaceState,
                            entriesToRebuild,
                            `project dependency variable changed in ${next.uri}`,
                            true,
                        );
                        projectRefreshScheduled = true;
                    }
                }
            }

            if (!projectRefreshScheduled && affectedEntries) {
                void this.refreshFileProjectContexts(next, workspaceState, affectedEntries);
            }
            workspaceState.affectedProjectEntriesByUri.delete(next.uri);
            workspaceState.affectedProjectDependencyInputsByUri.delete(next.uri);
        } else if (affectedEntries) {
            // Parser recovery is useful for local editing features, but its partial
            // command list must not invalidate a stable project dependency graph.
            void this.refreshFileProjectContexts(next, workspaceState, affectedEntries);
        }

        this.parsedFiles.evictClosedSnapshots(
            uri => this.documents.get(uri) !== undefined,
            MAX_CLOSED_PARSED_FILE_SNAPSHOTS,
        );
    }

    private async refreshFileProjectContexts(
        snapshot: ParsedFileSnapshot,
        workspaceState: WorkspaceState,
        entries: Iterable<string>,
    ): Promise<void> {
        const generation = workspaceState.analysisGeneration;
        try {
            for (const entryFile of entries) {
                if (!this.isAnalysisGenerationCurrent(workspaceState.workspaceFolder, generation)
                    || !await this.isParsedSnapshotCurrent(snapshot)) {
                    return;
                }
                await this.ensureFileIndexedAsync(
                    snapshot.uri,
                    snapshot,
                    generation,
                    entryFile,
                    'changed file context refresh',
                );
            }
        } catch (error) {
            this.logger.error(
                `Failed to refresh project contexts for ${snapshot.uri}`,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }

    private parseCMakeFile(
        uri: string,
        text: string,
        revision: SourceRevision,
        trigger: string,
    ): ParsedFileSnapshot {
        const start = Date.now();
        const parsedFile = parseCMakeText(text);
        const elapsedMs = Date.now() - start;
        const tokenCount = Math.max(parsedFile.tokenStream.tokens.length - 1, 0);

        this.logger.info(
            `Parsed CMake file: ${uri} (trigger=${trigger}, revision=${sourceRevisionKey(revision)}, duration=${elapsedMs}ms, commands=${parsedFile.flatCommands.length}, tokens=${tokenCount})`
        );

        return {
            ...parsedFile,
            uri,
            revision,
            dependencyStructure: analyzeDependencyStructure(parsedFile.flatCommands),
        };
    }

    private async ensureParsedFile(uri: string, trigger = 'on-demand cache miss'): Promise<ParsedFileSnapshot> {
        while (true) {
            const source = await this.loadFileSource(uri);
            const cached = this.parsedFiles.getCurrent(uri, source.revision);
            if (cached) {
                return cached;
            }

            const snapshot = await this.parsedFiles.getOrCreate(
                uri,
                source.revision,
                () => this.parseCMakeFile(uri, source.text, source.revision, trigger),
                this.onParsedSnapshotCommitted.bind(this),
            );
            if (await this.isSourceRevisionCurrent(uri, snapshot.revision)
                && this.parsedFiles.isCurrent(uri, snapshot.revision)) {
                return snapshot;
            }
        }
    }

    private async ensureFileIndexedAsync(
        uri: string,
        snapshot?: ParsedFileSnapshot,
        generation?: number,
        entryFile?: string,
        parseTrigger = 'symbol index',
    ): Promise<boolean> {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        const expectedGeneration = generation ?? workspaceState.analysisGeneration;
        if (workspaceState.analysisGeneration !== expectedGeneration) {
            return false;
        }

        const currentSnapshot = snapshot ?? await this.ensureParsedFile(uri, parseTrigger);
        const revisionKey = sourceRevisionKey(currentSnapshot.revision);
        const effectiveEntryFile = entryFile ?? this.getEntryFilePath(uri);
        if (workspaceState.symbolIndex.hasCurrentCache(uri, revisionKey, effectiveEntryFile)) {
            const revisionCurrent = await this.isSourceRevisionCurrent(uri, currentSnapshot.revision);
            return revisionCurrent
                && workspaceState.analysisGeneration === expectedGeneration
                && workspaceState.symbolIndex.hasCurrentCache(uri, revisionKey, effectiveEntryFile);
        }

        const requestKey = `${workspaceState.workspaceFolder.toString()}\0${uri}\0${expectedGeneration}\0${revisionKey}\0${effectiveEntryFile}`;
        const existing = this.symbolIndexRequests.get(requestKey);
        if (existing) {
            await existing;
            const revisionCurrent = await this.isSourceRevisionCurrent(uri, currentSnapshot.revision);
            return revisionCurrent
                && workspaceState.analysisGeneration === expectedGeneration
                && workspaceState.symbolIndex.hasCurrentCache(uri, revisionKey, effectiveEntryFile);
        }

        let request: Promise<void>;
        request = (async (): Promise<void> => {
            const baseDir = URI.file(path.dirname(URI.parse(uri).fsPath));
            const fileSymbolCache = await extractSymbols(
                uri,
                currentSnapshot.flatCommands,
                baseDir,
                workspaceState.symbolIndex,
                {
                    entryFile: effectiveEntryFile,
                    tokenStream: currentSnapshot.tokenStream,
                    dependencyStructure: currentSnapshot.dependencyStructure,
                    getFlatCommands: async (targetUri) => {
                        if (targetUri === uri) {
                            return currentSnapshot.flatCommands;
                        }

                        return (await this.ensureParsedFile(targetUri, parseTrigger)).flatCommands;
                    },
                }
            );

            if (workspaceState.analysisGeneration !== expectedGeneration) {
                return;
            }
            if (!await this.isSourceRevisionCurrent(uri, currentSnapshot.revision)) {
                return;
            }
            if (workspaceState.analysisGeneration !== expectedGeneration) {
                return;
            }

            workspaceState.symbolIndex.setCache(
                uri,
                fileSymbolCache,
                revisionKey,
                effectiveEntryFile,
                {
                    preserveDependencyContexts: currentSnapshot.syntaxDiagnostics.length > 0,
                },
            );
        })().finally(() => {
            if (this.symbolIndexRequests.get(requestKey) === request) {
                this.symbolIndexRequests.delete(requestKey);
            }
        });

        this.symbolIndexRequests.set(requestKey, request);
        await request;
        const revisionCurrent = await this.isSourceRevisionCurrent(uri, currentSnapshot.revision);
        return revisionCurrent
            && workspaceState.analysisGeneration === expectedGeneration
            && workspaceState.symbolIndex.hasCurrentCache(uri, revisionKey, effectiveEntryFile);
    }

    private ensureFileIndexedForEntry(uri: string, entryFile: string): Promise<boolean> {
        return this.ensureFileIndexedAsync(uri, undefined, undefined, entryFile);
    }

    private async ensureOpenDocumentIndexes(workspaceState: WorkspaceState): Promise<void> {
        for (const document of this.documents.all()) {
            if (document.languageId !== 'cmake') {
                continue;
            }
            if (this.getWorkspaceFolderForUri(document.uri).toString() !== workspaceState.workspaceFolder.toString()) {
                continue;
            }

            while (this.documents.get(document.uri)) {
                const currentDocument = this.documents.get(document.uri);
                if (!currentDocument) {
                    break;
                }

                const revisionKey = sourceRevisionKey({
                    kind: 'document',
                    version: currentDocument.version,
                });
                const entryFile = this.getEntryFilePath(document.uri);
                if (workspaceState.symbolIndex.hasCurrentCache(document.uri, revisionKey, entryFile)) {
                    break;
                }

                const analysisGeneration = workspaceState.analysisGeneration;
                const snapshot = await this.ensureParsedFile(document.uri, 'open document index refresh');
                if (await this.ensureFileIndexedAsync(document.uri, snapshot, analysisGeneration, entryFile)
                    && workspaceState.analysisGeneration === analysisGeneration
                    && await this.isParsedSnapshotCurrent(snapshot)) {
                    break;
                }
            }
        }
    }

    private async populateIndexTopDownAsync(
        uri: string,
        visited: Set<string>,
        token?: CancellationToken,
        parseTrigger = 'dependency traversal',
        expectedGeneration?: number,
    ): Promise<void> {
        const workspaceState = this.getWorkspaceStateForUri(uri);
        await populateIndexTopDown({
            rootUri: uri,
            visited,
            symbolIndex: workspaceState.symbolIndex,
            loadFlatCommands: async targetUri => (await this.ensureParsedFile(targetUri, parseTrigger)).flatCommands,
            ensureFileIndexed: (targetUri, entryFile) => this.ensureFileIndexedAsync(
                targetUri,
                undefined,
                expectedGeneration,
                entryFile,
                parseTrigger,
            ),
            shouldCancel: () => (token?.isCancellationRequested ?? false)
                || (expectedGeneration !== undefined
                    && workspaceState.analysisGeneration !== expectedGeneration),
            onDependencyError: async (dependencyUri, error): Promise<'continue'> => {
                this.logger.error(`Failed to parse dependency (${parseTrigger}): ${dependencyUri}`, error as Error);
                return 'continue';
            },
        });
    }

    private async getExtSettings(scopeUri?: string): Promise<ExtensionSettings> {
        const settings = await this.connection.workspace.getConfiguration({
            section: CONFIGURATION_SECTION,
            scopeUri,
        });
        return resolveExtensionSettings(settings, this.defaultExtSettings);
    }

    private async initializeEnvironment(workspaceFolder: URI, settings?: ExtensionSettings): Promise<void> {
        const initializeStart = Date.now();
        const workspaceState = this.getWorkspaceState(workspaceFolder);
        const generation = ++workspaceState.environmentGeneration;
        workspaceState.environmentReady = false;
        this.clearWorkspaceFolderSnapshots(workspaceFolder, 'CMake environment initialization');
        const settingsStart = Date.now();
        workspaceState.extSettings = settings ?? await this.getExtSettings(workspaceFolder.toString());
        this.logger.debug(`Loaded extension settings for ${workspaceFolder.fsPath} in ${Date.now() - settingsStart}ms`);
        this.logger.setLevel(workspaceState.extSettings.loggingLevel);
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
            if (settings
                && (settings.cmakePath !== workspaceState.extSettings.cmakePath
                    || settings.pkgConfigPath !== workspaceState.extSettings.pkgConfigPath)) {
                await this.startEnvironmentInitialization(workspaceFolder, settings);
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

    private async getFlatCommandsAsync(uri: string): Promise<FlatCommand[]> {
        return (await this.ensureParsedFile(uri)).flatCommands;
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
