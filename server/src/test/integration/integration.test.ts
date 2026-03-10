import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { CMakeInfo, ExtensionSettings } from '../../cmakeInfo';
import {
    CompletionItemKind,
    CompletionRequest,
    DidOpenTextDocumentNotification,
    DocumentFormattingRequest,
    DocumentLinkRequest,
    DocumentSymbolRequest,
    ExitNotification,
    HoverRequest,
    InitializeRequest,
    InitializeParams,
    InitializedNotification,
    IPCMessageReader,
    IPCMessageWriter,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    SemanticTokensRequest,
    ShutdownRequest,
    SignatureHelpRequest,
    ProtocolConnection,
    createProtocolConnection,
} from 'vscode-languageserver-protocol/node';

suite('LSP Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let cmakeInfo: CMakeInfo;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();
    const extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        pkgConfigPath: '',
        cmdCaseDiagnostics: true,
        loggingLevel: 'off'
    };

    suiteSetup(async function () {
        cmakeInfo = new CMakeInfo(extSettings);
        await cmakeInfo.init();

        const serverModule = path.resolve(__dirname, '..', '..', 'server.js');
        const debugArgs = process.execArgv.some(arg => /--inspect/.test(arg)) ? ['--inspect-brk=6009'] : [];
        serverProcess = cp.fork(serverModule, ['--node-ipc'], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            execArgv: debugArgs,
        });

        connection = createProtocolConnection(
            new IPCMessageReader(serverProcess),
            new IPCMessageWriter(serverProcess)
        );
        connection.listen();

        let configurationRequested: () => void;
        const configurationPromise = new Promise<void>(resolve => {
            configurationRequested = resolve;
        });

        // Handle server-initiated requests that would otherwise crash the server
        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest('workspace/configuration', () => {
            configurationRequested();
            return [
                extSettings.cmakePath,
                extSettings.loggingLevel,
                extSettings.cmdCaseDiagnostics,
                extSettings.pkgConfigPath
            ];
        });

        // Collect diagnostics via EventEmitter so each test can wait independently
        connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
            diagnosticEmitter.emit(params.uri, params);
        });

        const initParams: InitializeParams = {
            processId: process.pid,
            capabilities: {
                textDocument: {
                    completion: {
                        completionItem: { snippetSupport: true }
                    }
                }
            },
            rootUri: 'file:///test-workspace',
            locale: 'en',
            workspaceFolders: [
                { uri: 'file:///test-workspace', name: 'test' }
            ]
        };

        const result = await connection.sendRequest(InitializeRequest.type, initParams);
        assert(result.capabilities);
        assert(result.capabilities.completionProvider);
        assert(result.capabilities.hoverProvider);
        assert(result.capabilities.documentFormattingProvider);
        assert(result.capabilities.documentSymbolProvider);
        assert(result.capabilities.definitionProvider);
        assert(result.capabilities.signatureHelpProvider);
        assert(result.capabilities.documentLinkProvider);
        assert(result.capabilities.semanticTokensProvider);
        assert(result.capabilities.codeActionProvider);

        connection.sendNotification(InitializedNotification.type, {});
        await configurationPromise;
        // give it some time to finish cmakeInfo.init
        await new Promise(resolve => setTimeout(resolve, 3000));
    });

    suiteTeardown(async function () {
        if (connection) {
            await connection.sendRequest(ShutdownRequest.type);
            connection.sendNotification(ExitNotification.type);
            connection.dispose();
        }
        if (serverProcess) {
            serverProcess.kill();
        }
    });

    function openDocument(uri: string, content: string): void {
        docVersion++;
        connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri,
                languageId: 'cmake',
                version: docVersion,
                text: content
            }
        });
    }

    function waitForDiagnostics(uri: string, timeout = 5000): Promise<PublishDiagnosticsParams> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                diagnosticEmitter.removeListener(uri, handler);
                reject(new Error(`Timeout waiting for diagnostics on ${uri}`));
            }, timeout);
            function handler(params: PublishDiagnosticsParams) {
                clearTimeout(timer);
                resolve(params);
            }
            diagnosticEmitter.once(uri, handler);
        });
    }

    //#region  ── Completion ─────────────────────────────────────────────

    test('should suggest all builtin commands', async function () {
        const uri = 'file:///test-workspace/completion-all-cmds.txt';
        openDocument(uri, '');

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 0 }
        });

        assert(result !== null);
        const items = Array.isArray(result) ? result : result!.items;
        assert(items.length > 0, 'Should return completion items');

        cmakeInfo.commands.forEach(cmd => {
            const suggest = items.find(i => i.label === cmd);
            assert(suggest !== undefined, `Should suggest "${cmd}" command`);
            assert.strictEqual(suggest.kind, CompletionItemKind.Function);
        });
        assert(items.length > cmakeInfo.commands.size, 'Should have additional completion items beyond builtin commands');
    });

    test('should provide completion for empty document', async function () {
        const uri = 'file:///test-workspace/completion-empty.txt';
        openDocument(uri, '');

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 0 }
        });

        assert(result !== null);
        const items = Array.isArray(result) ? result : result!.items;
        assert(items.length > 0, 'Should return completion items');

        const projectCmd = items.find(i => i.label === 'project');
        assert(projectCmd !== undefined, 'Should suggest "project" command');
        assert.strictEqual(projectCmd.kind, CompletionItemKind.Function);

        const cmakeMinReq = items.find(i => i.label === 'cmake_minimum_required');
        assert(cmakeMinReq !== undefined, 'Should suggest "cmake_minimum_required"');
    });

    test('should provide completion for partial command', async function () {
        const uri = 'file:///test-workspace/completion-partial.txt';
        openDocument(uri, 'cmake_mini');

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 10 }
        });

        assert(result !== null);
        const items = Array.isArray(result) ? result : result!.items;
        const match = items.find(i => i.label === 'cmake_minimum_required');
        assert(match !== undefined, 'Should suggest "cmake_minimum_required" for partial input');
    });

    test('should provide keyword completion for all builtin commands', async function () {
        this.timeout(120000);
        const cmds: Record<string, { keyword?: string[] }> = require('../../builtin-cmds.json');

        // These commands always override keyword completion with custom suggestions
        const skipCommands = new Set([
            'pkg_check_modules',      // always returns pkg-config suggestions
            'target_link_libraries',  // always returns custom items at index > 0
        ]);

        // Block commands need proper wrapping to satisfy the CMake parser grammar
        function buildContent(cmdName: string): { content: string; line: number } {
            const cmdLine = `${cmdName}(x y z )`;
            switch (cmdName) {
                case 'if': return { content: `${cmdLine}\nendif()`, line: 0 };
                case 'elseif': return { content: `if(cond)\n${cmdLine}\nendif()`, line: 1 };
                case 'foreach': return { content: `${cmdLine}\nendforeach()`, line: 0 };
                case 'while': return { content: `${cmdLine}\nendwhile()`, line: 0 };
                default: return { content: cmdLine, line: 0 };
            }
        }

        for (const [cmdName, cmdInfo] of Object.entries(cmds)) {
            if (!cmdInfo.keyword || cmdInfo.keyword.length === 0) { continue; }
            if (skipCommands.has(cmdName)) { continue; }

            const { content, line } = buildContent(cmdName);
            // Cursor at the space before ')' in `cmdName(x y z )`
            const cursorChar = cmdName.length + 1 + 'x y z '.length - 1;
            const uri = `file:///test-workspace/kw-${cmdName}.txt`;
            openDocument(uri, content);

            const result = await connection.sendRequest(CompletionRequest.type, {
                textDocument: { uri },
                position: { line, character: cursorChar }
            });

            assert(result !== null, `${cmdName}: completion should not be null`);
            const items = Array.isArray(result) ? result : result!.items;
            const labels = new Set(items.map(i => i.label));

            for (const kw of cmdInfo.keyword) {
                assert(labels.has(kw), `${cmdName}: should suggest keyword '${kw}'`);
            }
        }
    });

    //#endregion ── Completion ─────────────────────────────────────────────

    //#region    ── Hover ──────────────────────────────────────────────────

    test('should provide hover information for commands', async function () {
        const uri = 'file:///test-workspace/hover.txt';
        openDocument(uri, 'add_subdirectory(Subdir)');

        const result = await connection.sendRequest(HoverRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 3 }
        });

        assert(result !== null, 'Hover result should not be null');
        assert(result!.contents !== undefined);
    });

    //#endregion ── Hover ──────────────────────────────────────────────────

    //#region ── Formatting ─────────────────────────────────────────────

    test('should format document', async function () {
        const uri = 'file:///test-workspace/format.txt';
        const unformatted = 'if(TRUE)\nproject(MyProject)\nendif()';
        openDocument(uri, unformatted);

        const edits = await connection.sendRequest(DocumentFormattingRequest.type, {
            textDocument: { uri },
            options: { tabSize: 4, insertSpaces: true }
        });

        assert(edits !== null);
        assert(Array.isArray(edits));
        assert(edits.length > 0);

        const formatted = edits[0].newText;
        assert(formatted.includes('    project'), 'Nested command should be indented');
    });

    //#endregion ── Formatting ─────────────────────────────────────────────

    //#region ── Document Symbols ───────────────────────────────────────

    test('should provide document symbols', async function () {
        const uri = 'file:///test-workspace/symbols.txt';
        const content = [
            'function(my_func arg1)',
            '  message(STATUS "hello")',
            'endfunction()',
            '',
            'macro(my_macro)',
            '  set(MY_VAR "value")',
            'endmacro()',
        ].join('\n');
        openDocument(uri, content);

        const symbols = await connection.sendRequest(DocumentSymbolRequest.type, {
            textDocument: { uri }
        });

        assert(symbols !== null);
        assert(Array.isArray(symbols));
        assert(symbols.length >= 2, 'Should find at least 2 symbols (function + macro)');

        const funcSymbol = symbols.find((s: any) => s.name === 'my_func');
        assert(funcSymbol !== undefined, 'Should find my_func symbol');
        const macroSymbol = symbols.find((s: any) => s.name === 'my_macro');
        assert(macroSymbol !== undefined, 'Should find my_macro symbol');
    });

    //#endregion ── Document Symbols ───────────────────────────────────────

    //#region ── Signature Help ─────────────────────────────────────────

    test('should provide signature help', async function () {
        const uri = 'file:///test-workspace/signature.txt';
        openDocument(uri, 'project(MyProject)');

        const result = await connection.sendRequest(SignatureHelpRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 8 }
        });

        assert(result !== null, 'Signature help should not be null');
        assert(result!.signatures.length > 0, 'Should have at least one signature');
    });

    //#endregion ── Signature Help ─────────────────────────────────────────

    //#region ── Document Links ─────────────────────────────────────────

    test('should provide document links', async function () {
        const uri = 'file:///test-workspace/links.txt';
        openDocument(uri, 'include(CMakePrintHelpers)');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null);
        assert(Array.isArray(links));
    });

    //#endregion ── Document Links ─────────────────────────────────────────

    //#region ── Diagnostics ────────────────────────────────────────────

    test('should publish diagnostics on document open', async function () {
        const uri = 'file:///test-workspace/diag-clean.txt';
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'project(MyProject)');

        const result = await diagPromise;
        assert(result !== undefined);
        assert(Array.isArray(result.diagnostics));
        // A well-formed file should have no errors
        const errors = result.diagnostics.filter(d => d.severity === 1);
        assert.strictEqual(errors.length, 0, 'Well-formed file should have no errors');
    });

    test('should report command case diagnostics for uppercase commands', async function () {
        const uri = 'file:///test-workspace/diag-case.txt';
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'PROJECT(MyProject)');

        const result = await diagPromise;
        assert(result !== undefined);
        // DIAG_CODE_CMD_CASE = 0
        const caseDiags = result.diagnostics.filter(d => d.code === 0 && d.source === 'cmake-intellisence');
        assert(caseDiags.length > 0, 'Should report command case diagnostic for uppercase "PROJECT"');
    });

    test('should report syntax error diagnostics', async function () {
        const uri = 'file:///test-workspace/diag-syntax.txt';
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'if(TRUE)\n');

        const result = await diagPromise;
        assert(result !== undefined);
        assert(result.diagnostics.length > 0, 'Unclosed if() should produce diagnostics');
    });

    //#endregion ── Diagnostics ────────────────────────────────────────────

    //#region ── Semantic Tokens ────────────────────────────────────────

    test('should provide semantic tokens', async function () {
        const uri = 'file:///test-workspace/semantic.txt';
        openDocument(uri, 'set(MY_VAR "hello")\nmessage(STATUS ${MY_VAR})');

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(result !== null);
        assert(result!.data !== undefined);
        assert(result!.data.length > 0, 'Should have semantic token data');
    });

    //#endregion ── Semantic Tokens ────────────────────────────────────────
});
