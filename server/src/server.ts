import { CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { Range, TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { CodeAction, Command, CompletionItem, CompletionList, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, SignatureHelp, SymbolInformation } from 'vscode-languageserver-types';
import { CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, ReferenceParams, RenameParams, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, WorkspaceEdit, WorkspaceSymbolParams, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import { ExtensionSettings, ProjectTargetInfoListener, initializeCMakeEnvironment } from './cmakeEnvironment';
import Completion, { CompletionItemType, ProjectTargetInfo, findCommandAtPosition, getCompletionHelpLabel, getCompletionItemType, inComments } from './completion';
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
import { ReferenceResolver } from './references';
import { RenameResolver } from './rename';
import { rstToMarkdown } from './rstToMarkdown';
import { SemanticTokenListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import { buildSignatureHelp } from './signatureHelp';
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
    public symbolIndex: SymbolIndex = new SymbolIndex();
    private projectTargetInfos: Map<string, ProjectTargetInfo> = new Map();
    private dirtyProjectTargetInfos: Set<string> = new Set();
    private workspaceIndexing: Map<string, Promise<void>> = new Map();
    private cmakeHelpCache: Map<string, Promise<string | null>> = new Map();
    private logger: Logger = createLogger('cmake-intellisence', 'off');
    private environmentInitialization?: Promise<void>;

    private extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
    };

    constructor() {
        this.disposables.push(
            this.connection.onInitialize(this.onInitialize.bind(this)),
            this.connection.onInitialized(this.onInitialized.bind(this)),
            this.connection.onHover(this.onHover.bind(this)),
            this.connection.onCompletion(this.onCompletion.bind(this)),
            this.connection.onCompletionResolve(this.onCompletionResolve.bind(this)),
            this.connection.onSignatureHelp(this.onSignatureHelp.bind(this)),
            this.connection.onDocumentFormatting(this.onDocumentFormatting.bind(this)),
            this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this)),
            this.connection.onDefinition(this.onDefinition.bind(this)),
            this.connection.onReferences(this.onReferences.bind(this)),
            this.connection.onRenameRequest(this.onRename.bind(this)),
            this.connection.onWorkspaceSymbol(this.onWorkspaceSymbol.bind(this)),
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

    // #region: methods to process LSP requests and notifications

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
        this.environmentInitialization = this.initializeEnvironment();
        await this.environmentInitialization;
        await this.ensureAllWorkspaceFoldersIndexed();
        this.connection.sendNotification(READY_NOTIFICATION);
    }

    private async onHover(params: HoverParams): Promise<Hover | null> {
        await this.ensureEnvironmentInitialized();
        const comments = this.getComments(params.textDocument.uri);
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands: FlatCommand[] = this.getFlatCommands(params.textDocument.uri);
        const hoveredCommand = findCommandAtPosition(commands, params.position);
        if (hoveredCommand === null) {
            return null;
        }

        const commandToken: Token = hoveredCommand.ID().symbol;
        const commandName = commandToken.text.toLowerCase();
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }
        let word = getWordAtPosition(document, params.position).text;
        if (word.length === 0) {
            return null;
        }

        let arg = '', category = '';
        const systemCache = this.symbolIndex.getSystemCache();
        if ((params.position.line + 1 === commandToken.line) &&
            (params.position.character <= commandToken.column + commandToken.text.length) &&
            systemCache.commands.has(commandName.toLowerCase())) {
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
                const stdout = await this.getCMakeHelp(arg, word);
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
                const pattern = /_(CXX|C)(_)?$/;
                if (pattern.test(word)) {
                    const modifiedWord = word.replace(pattern, '_<LANG>$2');
                    const modifiedStdout = await this.getCMakeHelp(arg, modifiedWord);
                    if (modifiedStdout !== null) {
                        return {
                            contents: {
                                kind: 'markdown',
                                value: modifiedStdout,
                            }
                        };
                    }
                    return null;
                }
                return null;
            }
        }
        return null;
    }

    private getEntryFilePath(docUri: string): string {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const entryCMakeLists = Utils.joinPath(workspaceFolder, "CMakeLists.txt");
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            return entryCMakeLists.toString();
        }

        const indexedEntryFile = this.symbolIndex.findEntryFile(docUri);
        if (indexedEntryFile) {
            return indexedEntryFile;
        }

        return docUri;
    }

    private onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        return this.handleCompletion(params);
    }

    private async handleCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        await this.ensureEnvironmentInitialized();
        await this.ensureWorkspaceIndexedForUri(params.textDocument.uri);

        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        const entryFileSource = this.getEntryFilePath(params.textDocument.uri);

        // Ensure the index is somewhat populated top-down so we have visible files
        const populateIndexTopDown = (uri: string, visited: Set<string>) => {
            if (visited.has(uri)) { return; }
            visited.add(uri);

            this.getFlatCommands(uri); // Causes symbolIndex to cache this file
            for (const dep of this.symbolIndex.getAvailableDependencies(uri)) {
                populateIndexTopDown(dep.uri, visited);
            }
        };
        populateIndexTopDown(entryFileSource, new Set());

        const word = getWordAtPosition(document, params.position).text;
        const targetInfo = this.getProjectTargetInfoForUri(params.textDocument.uri, entryFileSource);
        const completion = new Completion(this.flatCommandsMap, this.tokenStreams, targetInfo, word, this.logger, this.symbolIndex, params.textDocument.uri, entryFileSource);
        return completion.onCompletion(params);
    }

    private onCompletionResolve(item: CompletionItem): Promise<CompletionItem> {
        const completionType = getCompletionItemType(item.data);
        if (completionType === undefined) {
            return Promise.resolve(item);
        }

        if (completionType === CompletionItemType.PkgConfigModules) {
            item.documentation = this.symbolIndex.pkgConfigModules.get(item.label);
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
        return this.getCMakeHelp(helpArg, helpLabel, true).then(stdout => {
            if (stdout !== null) {
                item.documentation = {
                    kind: 'markdown',
                    value: stdout,
                };
            }
            return item;
        });
    }

    private onSignatureHelp(params: SignatureHelpParams): Promise<SignatureHelp | null> {
        const pos = params.position;
        const uri = params.textDocument.uri;
        const commands: FlatCommand[] = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, pos);
        if (!command) {
            return Promise.resolve(null);
        }
        return Promise.resolve(buildSignatureHelp(command, pos, commands));
    }

    private onDocumentFormatting(params: DocumentFormattingParams): TextEdit[] | null {
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

    private onDocumentSymbol(params: DocumentSymbolParams): DocumentSymbol[] | SymbolInformation[] | null {
        const symbolListener = new SymbolListener();
        ParseTreeWalker.DEFAULT.walk(symbolListener, this.getFileContext(params.textDocument.uri));
        return symbolListener.getSymbols();
    }

    private onDefinition(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const uri: string = params.textDocument.uri;
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return Promise.resolve(null);
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return Promise.resolve(null);
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const resolver = new DefinitionResolver(
            this.documents,
            this.symbolIndex,
            this.getFlatCommands.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger
        );
        return resolver.resolve(params);
    }

    private onReferences(params: ReferenceParams): Promise<Location[] | null> {
        const uri: string = params.textDocument.uri;
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return Promise.resolve(null);
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return Promise.resolve(null);
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const resolver = new ReferenceResolver(
            this.documents,
            this.symbolIndex,
            this.getFlatCommands.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger
        );
        return resolver.resolve(params);
    }

    private onRename(params: RenameParams): Promise<WorkspaceEdit | null> {
        const uri: string = params.textDocument.uri;
        const comments = this.getComments(uri);
        if (inComments(params.position, comments)) {
            return Promise.resolve(null);
        }

        const commands = this.getFlatCommands(uri);
        const command = findCommandAtPosition(commands, params.position);
        if (command === null) {
            return Promise.resolve(null);
        }

        const workspaceFolder = this.getWorkspaceFolderForUri(uri).toString();
        const refResolver = new ReferenceResolver(
            this.documents,
            this.symbolIndex,
            this.getFlatCommands.bind(this),
            workspaceFolder,
            URI.parse(uri),
            command,
            this.logger
        );
        const renameResolver = new RenameResolver(refResolver);
        return renameResolver.resolve(params);
    }

    private async onWorkspaceSymbol(params: WorkspaceSymbolParams): Promise<SymbolInformation[] | null> {
        const resolve = async (): Promise<SymbolInformation[] | null> => {
            await this.ensureAllWorkspaceFoldersIndexed();
            const resolver = new WorkspaceSymbolResolver(this.symbolIndex);
            return resolver.resolve(params);
        };

        return resolve();
    }

    private onSemanticTokens(params: SemanticTokensParams): Promise<SemanticTokens> {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return Promise.resolve({ data: [] });
        }
        const docUri: URI = URI.parse(params.textDocument.uri);
        const entryUri = this.getEntryFilePath(params.textDocument.uri);
        const semanticListener = new SemanticTokenListener(docUri.toString(), this.symbolIndex, entryUri);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(params.textDocument.uri));
        return Promise.resolve(semanticListener.getSemanticTokens());
    }

    private onSemanticTokensDelta(params: SemanticTokensDeltaParams): Promise<SemanticTokens | SemanticTokensDelta> {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return Promise.resolve({ edits: [] });
        }

        const builder = getTokenBuilder(document.uri);
        builder.previousResult(params.previousResultId);
        const docUri: URI = URI.parse(document.uri);
        const entryUri = this.getEntryFilePath(document.uri);
        const semanticListener = new SemanticTokenListener(docUri.toString(), this.symbolIndex, entryUri);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(document.uri));
        return Promise.resolve(semanticListener.buildEdits());
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
        const extSettings = await this.getExtSettings();
        if (extSettings.cmakePath !== this.extSettings.cmakePath || extSettings.pkgConfigPath !== this.extSettings.pkgConfigPath) {
            this.environmentInitialization = this.initializeEnvironment(extSettings);
            await this.environmentInitialization;
            await this.ensureAllWorkspaceFoldersIndexed();
            return;
        }
        this.extSettings = extSettings;
        this.logger.setLevel(this.extSettings.loggingLevel);
    }

    /**
     * The content of a text document has changed. This event is emitted
     *  when the text document first opened or when its content has changed.
     * 
     * @param event 
     */
    private async onDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
        await this.ensureEnvironmentInitialized();

        // check syntax errors
        const syntaxErrorListener = new SyntaxErrorListener();
        const parsedFile = parseCMakeText(event.document.getText(), parser => {
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

        if (this.extSettings?.cmdCaseDiagnostics) {
            const cmdCaseChecker = new CommandCaseChecker(this.symbolIndex);
            cmdCaseChecker.check(flatCommands);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDiagnostics());
        }
        this.connection.sendDiagnostics(diagnostics);

        this.markProjectTargetInfoDirty(event.document.uri);
    }

    private onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[] | null> {
        const commands = this.getFlatCommands(params.textDocument.uri);
        const linkInfo = new DocumentLinkInfo(commands, params.textDocument.uri, this.symbolIndex);
        return Promise.resolve(linkInfo.links);
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
            this.symbolIndex.deleteCache(uri);
        }

        const workspaceFolderKey = workspaceFolderUri.toString();
        this.projectTargetInfos.delete(workspaceFolderKey);
        this.dirtyProjectTargetInfos.delete(workspaceFolderKey);
    }

    private onShutdown() {
        this.disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }

    // #endregion

    private markProjectTargetInfoDirty(docUri: string) {
        const workspaceKey = this.getWorkspaceFolderForUri(docUri).toString();
        this.dirtyProjectTargetInfos.add(workspaceKey);
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
        const workspaceKey = workspaceFolder.toString();
        const existing = this.workspaceIndexing.get(workspaceKey);
        if (existing) {
            return existing;
        }

        const indexing = this.indexWorkspaceFolder(workspaceFolder).catch(error => {
            this.workspaceIndexing.delete(workspaceKey);
            this.logger.error(`Failed to index workspace folder ${workspaceFolder.fsPath}`, error as Error);
        });
        this.workspaceIndexing.set(workspaceKey, indexing);
        return indexing;
    }

    private async indexWorkspaceFolder(workspaceFolder: URI): Promise<void> {
        const files = await this.collectWorkspaceCMakeFiles(workspaceFolder.fsPath);
        for (const filePath of files) {
            this.indexWorkspaceFile(URI.file(filePath).toString());
        }
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

    private indexWorkspaceFile(uri: string) {
        const text = getFileContent(this.documents, URI.parse(uri));
        const parsedFile = parseCMakeText(text);
        this.storeParsedFileSnapshot(uri, parsedFile);
    }

    private storeParsedFileSnapshot(uri: string, parsedFile: ParsedCMakeFile) {
        this.fileContexts.set(uri, parsedFile.fileContext);
        this.tokenStreams.set(uri, parsedFile.tokenStream);
        this.flatCommandsMap.set(uri, parsedFile.flatCommands);

        const baseDir = URI.file(path.dirname(URI.parse(uri).fsPath));
        const fileSymbolCache = extractSymbols(uri, parsedFile.flatCommands, baseDir, this.symbolIndex);
        this.symbolIndex.setCache(uri, fileSymbolCache);

        const commentsChannel = CMakeLexer.channelNames.indexOf("COMMENTS");
        this.commentsMap.set(uri, parsedFile.tokenStream.tokens.filter(token => token.channel === commentsChannel));
    }

    private parseAndStoreFile(uri: string): ParsedCMakeFile {
        const parsedFile = parseCMakeText(getFileContent(this.documents, URI.parse(uri)));
        this.storeParsedFileSnapshot(uri, parsedFile);
        return parsedFile;
    }

    private rebuildProjectTargetInfoForUri(docUri: string): ProjectTargetInfo {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceKey = workspaceFolder.toString();
        const projectRootCMake = Utils.joinPath(workspaceFolder, 'CMakeLists.txt');
        const entryCMake = fs.existsSync(projectRootCMake.fsPath)
            ? projectRootCMake.toString()
            : this.getEntryFilePath(docUri);
        const commands = this.getFlatCommands(entryCMake);
        const targetInfoListener = new ProjectTargetInfoListener(
            this.symbolIndex,
            entryCMake,
            workspaceFolder.fsPath,
            this.getFlatCommands.bind(this),
            new Set<string>(),
            workspaceFolder.fsPath,
        );
        targetInfoListener.processCommands(commands);
        this.projectTargetInfos.set(workspaceKey, targetInfoListener.targetInfo);
        this.dirtyProjectTargetInfos.delete(workspaceKey);
        return targetInfoListener.targetInfo;
    }

    private getProjectTargetInfoForUri(docUri: string, entryUri?: string): ProjectTargetInfo {
        const workspaceFolder = this.getWorkspaceFolderForUri(docUri);
        const workspaceKey = workspaceFolder.toString();
        const targetInfo = this.projectTargetInfos.get(workspaceKey);
        if (targetInfo && !this.dirtyProjectTargetInfos.has(workspaceKey)) {
            return targetInfo;
        }

        if (entryUri) {
            const projectRootCMake = Utils.joinPath(workspaceFolder, 'CMakeLists.txt');
            if (!fs.existsSync(projectRootCMake.fsPath) && entryUri !== docUri) {
                const commands = this.getFlatCommands(entryUri);
                const targetInfoListener = new ProjectTargetInfoListener(
                    this.symbolIndex,
                    entryUri,
                    workspaceFolder.fsPath,
                    this.getFlatCommands.bind(this),
                    new Set<string>(),
                    workspaceFolder.fsPath,
                );
                targetInfoListener.processCommands(commands);
                this.projectTargetInfos.set(workspaceKey, targetInfoListener.targetInfo);
                this.dirtyProjectTargetInfos.delete(workspaceKey);
                return targetInfoListener.targetInfo;
            }
        }

        return this.rebuildProjectTargetInfoForUri(docUri);
    }

    private async getExtSettings(): Promise<ExtensionSettings> {
        const [
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            pkgConfigPath,
        ] = await this.connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath' },
            { section: 'cmakeIntelliSence.loggingLevel' },
            { section: 'cmakeIntelliSence.cmdCaseDiagnostics' },
            { section: 'cmakeIntelliSence.pkgConfigPath' },
        ]);

        return {
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            pkgConfigPath,
        };
    }

    private async initializeEnvironment(settings?: ExtensionSettings): Promise<void> {
        this.extSettings = settings ?? await this.getExtSettings();
        this.workspaceIndexing.clear();
        this.projectTargetInfos.clear();
        this.dirtyProjectTargetInfos.clear();
        this.cmakeHelpCache.clear();
        try {
            await initializeCMakeEnvironment(this.extSettings, this.symbolIndex);
        } catch (e: any) {
            this.connection.window.showErrorMessage(e.message);
        }
        this.logger.setLevel(this.extSettings.loggingLevel);
    }

    private async ensureEnvironmentInitialized(): Promise<void> {
        if (this.environmentInitialization) {
            await this.environmentInitialization;
        }

        if (this.symbolIndex.getSystemCache().commands.size > 0) {
            return;
        }

        this.environmentInitialization = this.initializeEnvironment();
        await this.environmentInitialization;
    }

    public getFileContext(uri: string): FileContext {
        if (this.fileContexts.has(uri)) {
            return this.fileContexts.get(uri)!;
        }

        return this.parseAndStoreFile(uri).fileContext;
    }

    public getTokenStream(uri: string): CommonTokenStream {
        if (this.tokenStreams.has(uri)) {
            return this.tokenStreams.get(uri)!;
        }
        this.getFileContext(uri);
        return this.tokenStreams.get(uri)!;
    }

    public getFlatCommands(uri: string): FlatCommand[] {
        if (this.flatCommandsMap.has(uri)) {
            return this.flatCommandsMap.get(uri)!;
        }

        return this.parseAndStoreFile(uri).flatCommands;
    }

    private getComments(uri: string): Token[] {
        if (this.commentsMap.has(uri)) {
            return this.commentsMap.get(uri)!;
        }

        this.parseAndStoreFile(uri);
        return this.commentsMap.get(uri)!;
    }

    private execFilePromise(file: string, args: string[]): Promise<{ stdout: string, stderr: string }> {
        return new Promise((resolve, reject) => {
            execFile(file, args, (error, stdout, stderr) => {
                if (error) {
                    reject({ error, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    private getCMakeHelp(helpArg: string, label: string, logErrors = false): Promise<string | null> {
        const cacheKey = `${helpArg}\0${label}`;
        const existing = this.cmakeHelpCache.get(cacheKey);
        if (existing) {
            return existing;
        }

        const request = this.execFilePromise(this.symbolIndex.cmakePath, [helpArg, label])
            .then(({ stdout }) => rstToMarkdown(stdout))
            .catch((error: { stderr?: string }) => {
                if (logErrors) {
                    this.logger.error(`Failed to get help for ${label}: ${error.stderr ?? ''}`);
                }
                this.cmakeHelpCache.delete(cacheKey);
                return null;
            });

        this.cmakeHelpCache.set(cacheKey, request);
        return request;
    }
}

new CMakeLanguageServer();
