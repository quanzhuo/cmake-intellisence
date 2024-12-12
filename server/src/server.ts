import { CharStreams, CommonTokenStream, ParseTreeWalker, Token } from 'antlr4';
import { exec } from 'child_process';
import * as fs from 'fs';
import { CompletionParams, DefinitionParams, Disposable, DocumentFormattingParams, DocumentLinkParams, DocumentSymbolParams } from 'vscode-languageserver-protocol';
import { Range, TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { CodeAction, Command, CompletionItem, CompletionList, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, Position, SemanticTokens, SemanticTokensDelta, SignatureHelp, SymbolInformation } from 'vscode-languageserver-types';
import { CodeActionKind, CodeActionParams, DidChangeConfigurationNotification, DidChangeConfigurationParams, HoverParams, InitializeParams, InitializeResult, InitializedParams, ProposedFeatures, SemanticTokensDeltaParams, SemanticTokensParams, SemanticTokensRangeParams, SignatureHelpParams, TextDocumentChangeEvent, TextDocumentSyncKind, TextDocuments, createConnection } from 'vscode-languageserver/node';
import { URI, Utils } from 'vscode-uri';
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo, ProjectInfoListener } from './cmakeInfo';
import Completion, { CompletionItemType, ProjectInfo, findCommandAtPosition, inComments } from './completion';
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
import { SemanticTokenListener, getTokenBuilder, getTokenModifiers, getTokenTypes, tokenBuilders } from './semanticTokens';
import { getFileContent } from './utils';

type Word = {
    text: string,
    line: number,
    col: number
};

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    cmakeModulePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

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
    private extSettings: ExtensionSettings;
    private cmakeInfo: CMakeInfo;
    private disposables: Disposable[] = [];
    private fileContexts: Map<string, FileContext> = new Map();
    private tokenStreams: Map<string, CommonTokenStream> = new Map();
    private simpleTokenStreams: Map<string, CommonTokenStream> = new Map();
    private simpleFileContexts: Map<string, cmsp.FileContext> = new Map();
    private projectInfo?: ProjectInfo;

    /**
     * Files whose ProjectInfo is already parsed
     */
    private parsedFiles = new Set<string>();

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
        this.extSettings = initializationOptions.extSettings;
        this.cmakeInfo = new CMakeInfo(this.extSettings, this.connection);
        await this.cmakeInfo.init();
        logger = createLogger('cmake-intellisence', this.extSettings.loggingLevel);

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

    private onInitialized(params: InitializedParams) {
        this.connection.client.register(DidChangeConfigurationNotification.type, undefined);
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

        function execPromise(command: string): Promise<{ stdout: string, stderr: string }> {
            return new Promise((resolve, reject) => {
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        reject({ error, stderr });
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
            });
        }

        const commandToken: Token = hoveredCommand.ID().symbol;
        const commandName = commandToken.text.toLowerCase();
        // if hover on command name
        if ((params.position.line + 1 === commandToken.line) && (params.position.character <= commandToken.column + commandToken.text.length)) {
            if (this.cmakeInfo.commands.includes(commandName)) {
                const { stdout } = await execPromise(`"${this.cmakeInfo.cmakePath}" --help-command ${commandName}`);
                return {
                    contents: {
                        kind: 'plaintext',
                        value: stdout
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
                const command = `"${this.cmakeInfo.cmakePath}" ${arg} "${word}"`;
                try {
                    const { stdout } = await execPromise(command);
                    return {
                        contents: {
                            kind: 'plaintext',
                            value: stdout
                        }
                    };
                } catch (error) {
                    const pattern = /_(CXX|C)(_)?$/;
                    if (pattern.test(word)) {
                        const modifiedWord = word.replace(pattern, '_<LANG>$2');
                        const modifiedCommand = `"${this.cmakeInfo.cmakePath}" ${arg} "${modifiedWord}"`;
                        try {
                            const { stdout: modifiedStdout } = await execPromise(modifiedCommand);
                            return {
                                contents: {
                                    kind: 'plaintext',
                                    value: modifiedStdout
                                }
                            };
                        } catch (modifiedError) {
                            return null;
                        }
                    }
                    return null;
                }
            }
        }
        return null;
    }

    private onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        const completion = new Completion(this.initParams, this.connection, this.documents, this.cmakeInfo, this.simpleFileContexts, this.projectInfo);
        const fileContext = this.getSimpleFileContext(params.textDocument.uri);
        const simpleTokenStream = this.getSimpleTokenStream(params.textDocument.uri);
        return completion.onCompletion(params, fileContext, simpleTokenStream);
    }

    private onCompletionResolve(item: CompletionItem): Promise<CompletionItem> {
        // item.data can be BuintInCommand, which is 0, so we need to check if it is undefined
        if (item.data === undefined) {
            return Promise.resolve(item);
        }

        if (item.data === CompletionItemType.PkgConfigModules) {
            item.documentation = this.cmakeInfo.pkgConfigModules.get(item.label);
            return Promise.resolve(item);
        }

        let helpArg = '';
        switch (item.data) {
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
        const command = `"${this.cmakeInfo.cmakePath}" ${helpArg} "${item.label}"`;
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Failed to get help for ${item.label}: ${stderr}`);
                } else {
                    item.documentation = stdout;
                }
                resolve(item);
            });
        });
    }

    private onSignatureHelp(params: SignatureHelpParams): Promise<SignatureHelp | null> {
        const pos = params.position;
        const uri = params.textDocument.uri;
        const simpleFileContext = this.getSimpleFileContext(uri);
        const commands: cmsp.CommandContext[] = simpleFileContext.command_list();
        const command = findCommandAtPosition(commands, pos);
        if (!command) {
            return Promise.resolve(null);
        }

        const commandName = command.ID().getText().toLowerCase();
        if (!(commandName in builtinCmds)) {
            return Promise.resolve(null);
        }

        const sigsStrArr: string[] = builtinCmds[commandName]['sig'];
        if (sigsStrArr.length === 1) {
            return Promise.resolve({
                signatures: [
                    {
                        label: sigsStrArr[0]
                    }
                ],
                activeSignature: 0,
                activeParameter: 0
            });
        }

        function findActiveSignature(command: cmsp.CommandContext, sigs: string[]): number {
            const args = command.argument_list();
            const argsText: string[] = args.map(arg => arg.getText());

            let ret = 0;
            let maxMatched = 0;

            sigs.forEach((sig, index) => {
                const keywords = new Set<string>();
                const matches = sig.match(/[A-Z][A-Z_]*[A-Z]/g);
                if (matches) {
                    matches.forEach(keyword => keywords.add(keyword));
                }

                let matched = 0;
                argsText.forEach(arg => {
                    if (keywords.has(arg)) {
                        matched++;
                    }
                });

                if (matched > maxMatched) {
                    maxMatched = matched;
                    ret = index;
                }
            });

            return ret;
        }

        const activeSigIndex = findActiveSignature(command, sigsStrArr);
        return Promise.resolve({
            signatures: sigsStrArr.map(sig => { return { label: sig }; }),
            activeSignature: activeSigIndex,
            activeParameter: 0
        });
    }

    private onDocumentFormatting(params: DocumentFormattingParams): Promise<TextEdit[] | null> {
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

    private onDocumentSymbol(params: DocumentSymbolParams): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
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

    private onSemanticTokens(params: SemanticTokensParams): Promise<SemanticTokens | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return Promise.resolve({ data: [] });
        }
        const docUri: URI = URI.parse(params.textDocument.uri);
        const semanticListener = new SemanticTokenListener(docUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(params.textDocument.uri));
        return Promise.resolve(semanticListener.getSemanticTokens());
    }

    private onSemanticTokensDelta(params: SemanticTokensDeltaParams): Promise<SemanticTokens | SemanticTokensDelta | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (document === undefined) {
            return Promise.resolve({
                edits: []
            });
        }

        const builder = getTokenBuilder(document.uri);
        builder.previousResult(params.previousResultId);
        const docUri: URI = URI.parse(document.uri);
        const semanticListener = new SemanticTokenListener(docUri, this.cmakeInfo);
        ParseTreeWalker.DEFAULT.walk(semanticListener, this.getFileContext(document.uri));
        return Promise.resolve(semanticListener.buildEdits());
    }

    private onSemanticTokensRange(params: SemanticTokensRangeParams): Promise<SemanticTokens | null> {
        return Promise.resolve({
            data: []
        });
    }

    private onCodeAction(params: CodeActionParams): (Command | CodeAction)[] | null {
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
        const extSettings = await this.getExtSettings();
        if (extSettings.cmakeModulePath !== this.extSettings.cmakeModulePath ||
            extSettings.cmakePath !== this.extSettings.cmakePath
        ) {
            this.cmakeInfo = new CMakeInfo(extSettings, this.connection);
            await this.cmakeInfo.init();
        }
        this.extSettings = extSettings;
    }

    /**
     * The content of a text document has changed. This event is emitted
     *  when the text document first opened or when its content has changed.
     * 
     * @param event 
     */
    private onDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
        // check syntax errors
        const input = CharStreams.fromString(event.document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        parser.removeErrorListeners();
        const syntaxErrorListener = new SyntaxErrorListener();
        parser.addErrorListener(syntaxErrorListener);

        // FileContext
        const fileContext = parser.file();
        this.fileContexts.set(event.document.uri, fileContext);
        this.tokenStreams.set(event.document.uri, tokenStream);

        // cmsp.FileContext
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
            const cmdCaseChecker = new CommandCaseChecker(this.cmakeInfo);
            ParseTreeWalker.DEFAULT.walk(cmdCaseChecker, simpleFileContext);
            diagnostics.diagnostics.push(...cmdCaseChecker.getCmdCaseDdiagnostics());
        }
        this.connection.sendDiagnostics(diagnostics);

        this.buildProjectInfo(event);
    }

    /**
     * Build project info when file changed
     * 
     * @param event 
     */
    private buildProjectInfo(event: TextDocumentChangeEvent<TextDocument>) {
        if (!(this.initParams.workspaceFolders && this.initParams.workspaceFolders.length === 1)) {
            return;
        }

        const workspaceFolder = URI.parse(this.initParams.workspaceFolders[0].uri);
        let entryCMake: string = event.document.uri;
        const projectRootCMake: URI = Utils.joinPath(workspaceFolder, 'CMakeLists.txt');
        if (fs.existsSync(projectRootCMake.fsPath) && this.projectInfo === undefined) {
            entryCMake = projectRootCMake.toString();
        }

        const tree = this.getSimpleFileContext(entryCMake.toString());
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, entryCMake.toString(), workspaceFolder.fsPath, this.simpleFileContexts, this.documents, this.parsedFiles, workspaceFolder.fsPath);
        ParseTreeWalker.DEFAULT.walk(projectInfoListener, tree);
        if (!this.projectInfo) {
            this.projectInfo = ProjectInfoListener.projectInfo;
        } else {
            const newProjectInfo = ProjectInfoListener.projectInfo;
            for (const key in newProjectInfo) {
                if (newProjectInfo.hasOwnProperty(key)) {
                    if (newProjectInfo[key] instanceof Set) {
                        if (!this.projectInfo[key]) {
                            this.projectInfo[key] = new Set();
                        }
                        for (const value of newProjectInfo[key]) {
                            this.projectInfo[key].add(value);
                        }
                    } else {
                        this.projectInfo[key] = newProjectInfo[key];
                    }
                }
            }
        }
    }

    private onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[] | null> {
        const simpleFileContext = this.getSimpleFileContext(params.textDocument.uri);
        const linkInfo = new DocumentLinkInfo(simpleFileContext, params.textDocument.uri, this.cmakeInfo);
        return Promise.resolve(linkInfo.links);
    }

    private onDidClose(event: TextDocumentChangeEvent<TextDocument>) {
        tokenBuilders.delete(event.document.uri);
    }

    private async getExtSettings(): Promise<ExtensionSettings> {
        const [
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            cmakeModulePath,
            pkgConfigPath,
        ] = await this.connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath' },
            { section: 'cmakeIntelliSence.loggingLevel' },
            { section: 'cmakeIntelliSence.cmdCaseDiagnostics' },
            { section: 'cmakeIntelliSence.cmakeModulePath' },
            { section: 'cmakeIntelliSence.pkgConfigPath' },
        ]);

        return {
            cmakePath,
            loggingLevel,
            cmdCaseDiagnostics,
            cmakeModulePath,
            pkgConfigPath,
        };
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

new CMakeLanguageServer();
