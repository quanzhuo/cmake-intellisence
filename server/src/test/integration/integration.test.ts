import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CodeActionRequest,
    CompletionItemKind,
    CompletionRequest,
    CompletionResolveRequest,
    DidChangeConfigurationNotification,
    DidChangeTextDocumentNotification,
    DidOpenTextDocumentNotification,
    DocumentFormattingRequest,
    DocumentLinkRequest,
    DocumentSymbolRequest,
    ExitNotification,
    HoverRequest,
    IPCMessageReader,
    IPCMessageWriter,
    InitializeParams,
    InitializeRequest,
    InitializedNotification,
    ProtocolConnection,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    SemanticTokensDeltaRequest,
    SemanticTokensRequest,
    ShutdownRequest,
    SignatureHelpRequest,
    createProtocolConnection,
} from 'vscode-languageserver-protocol/node';
import { URI } from 'vscode-uri';
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION } from '../../cmakeToolsSnapshot';
import { ExtensionSettings, initializeCMakeEnvironment } from '../../cmakeEnvironment';
import { SymbolIndex, SymbolKind } from '../../symbolIndex';
import { waitForServerReady } from './testUtils';

suite('LSP Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let symbolIndex: SymbolIndex;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();
    const configurationPullWaiters: Array<() => void> = [];
    const extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        pkgConfigPath: '',
        cmdCaseDiagnostics: true,
        loggingLevel: 'off'
    };

    suiteSetup(async function () {
        symbolIndex = new SymbolIndex();
        await initializeCMakeEnvironment(extSettings, symbolIndex);

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
        const readyPromise = waitForServerReady(connection);

        // Handle server-initiated requests that would otherwise crash the server
        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest('workspace/configuration', () => {
            configurationRequested();
            configurationPullWaiters.shift()?.();
            return [
                extSettings.cmakePath,
                extSettings.loggingLevel,
                extSettings.cmdCaseDiagnostics,
                extSettings.pkgConfigPath,
                extSettings.workspaceIgnoreDirectories,
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
        await readyPromise;
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

    function changeDocument(uri: string, content: string): void {
        docVersion++;
        connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: {
                uri,
                version: docVersion,
            },
            contentChanges: [{ text: content }]
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

    function waitForConfigurationPull(timeout = 5000): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = configurationPullWaiters.indexOf(handler);
                if (index >= 0) {
                    configurationPullWaiters.splice(index, 1);
                }
                reject(new Error('Timeout waiting for configuration pull'));
            }, timeout);

            const handler = () => {
                clearTimeout(timer);
                resolve();
            };

            configurationPullWaiters.push(handler);
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

        const builtinCommands = Array.from(symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinCommand));
        builtinCommands.forEach(cmd => {
            const suggest = items.find(i => i.label === cmd);
            assert(suggest !== undefined, `Should suggest "${cmd}" command`);
            assert.strictEqual(suggest.kind, CompletionItemKind.Function);
        });
        assert(items.length > builtinCommands.length, 'Should have additional completion items beyond builtin commands');
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

    test('should resolve builtin completion documentation', async function () {
        const uri = 'file:///test-workspace/completion-resolve.txt';
        openDocument(uri, 'add_sub');

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 7 }
        });

        assert(result !== null);
        const items = Array.isArray(result) ? result : result!.items;
        const match = items.find(i => i.label === 'add_subdirectory');
        assert(match !== undefined, 'Should suggest add_subdirectory');

        const resolved = await connection.sendRequest(CompletionResolveRequest.type, match!);
        assert(resolved.documentation !== undefined, 'Resolved completion should include documentation');
    });

    test('should suggest builtin include modules case-insensitively', async function () {
        const uri = 'file:///test-workspace/completion-include-module.txt';
        const content = 'include(cmakepri)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'include(cmakepri'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('CMakePrintHelpers'), 'include() should suggest builtin modules by case-insensitive match');
        assert(!labels.has('Threads'), 'include() should not suggest Find-modules without the Find prefix');
    });

    test('should suggest find_package modules from Find-modules only and resolve documentation', async function () {
        const uri = 'file:///test-workspace/completion-find-package.txt';
        const content = 'find_package(thr)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'find_package(thr'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const threadItem = items.find(i => i.label === 'Threads');
        const cpackItem = items.find(i => i.label === 'CPack');

        assert(threadItem !== undefined, 'find_package() should suggest package names from Find-modules');
        assert(cpackItem === undefined, 'find_package() should not suggest non-Find modules');

        const resolved = await connection.sendRequest(CompletionResolveRequest.type, threadItem!);
        assert(resolved.documentation !== undefined, 'Find-module completion should resolve documentation');
    });

    test('should suggest policies case-insensitively for cmake_policy', async function () {
        const uri = 'file:///test-workspace/completion-policy.txt';
        const content = 'cmake_policy(SET cmp00)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'cmake_policy(SET cmp00'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('CMP0001'), 'cmake_policy() should suggest policies with case-insensitive filtering');
    });

    test('should suggest target properties after PROPERTIES keyword', async function () {
        const defsUri = 'file:///test-workspace/completion-target-props-defs.txt';
        openDocument(defsUri, 'add_library(my_target INTERFACE)');

        const uri = 'file:///test-workspace/completion-target-props.txt';
        const content = 'set_target_properties(my_target PROPERTIES posi)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'set_target_properties(my_target PROPERTIES posi'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('POSITION_INDEPENDENT_CODE'), 'set_target_properties() should suggest property names after PROPERTIES');
    });

    test('should suggest source file properties in get_source_file_property', async function () {
        const uri = 'file:///test-workspace/completion-source-prop.txt';
        const content = 'get_source_file_property(out main.cpp locat)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'get_source_file_property(out main.cpp locat'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('LOCATION'), 'get_source_file_property() should suggest property names at the property position');
    });

    test('should suggest directory properties after optional DIRECTORY clause', async function () {
        const uri = 'file:///test-workspace/completion-directory-prop.txt';
        const content = 'get_directory_property(out DIRECTORY src definit)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'get_directory_property(out DIRECTORY src definit'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('DEFINITION'), 'get_directory_property() should still expose builtin keywords at optional positions');
    });

    test('should suggest configuration names inside CONFIG generator expressions', async function () {
        const uri = 'file:///test-workspace/completion-genex-config.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<CONFIG:De>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_compile_definitions(tgt PRIVATE $<CONFIG:De'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('Debug'), 'CONFIG genex should suggest common configuration names');
    });

    test('should suggest configuration names inside CONFIG generator expressions for incomplete commands', async function () {
        const uri = 'file:///test-workspace/completion-genex-config-incomplete.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<CONFIG:De';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_compile_definitions(tgt PRIVATE $<CONFIG:De'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('Debug'), 'Incomplete CONFIG genex should still suggest common configuration names');
    });

    test('should suggest targets inside TARGET_FILE generator expressions', async function () {
        const uri = 'file:///test-workspace/completion-genex-target-file.txt';
        const content = 'add_library(my_target INTERFACE)\ntarget_compile_definitions(tgt PRIVATE $<TARGET_FILE:my_>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 1, character: 'target_compile_definitions(tgt PRIVATE $<TARGET_FILE:my_'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('my_target'), 'TARGET_FILE genex should suggest visible targets');
    });

    test('should suggest STRING generator expression subcommands', async function () {
        const uri = 'file:///test-workspace/completion-genex-string.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<STRING:HA>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_compile_definitions(tgt PRIVATE $<STRING:HA'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('HASH'), 'STRING genex should suggest subcommands at the first argument');
    });

    test('should suggest LIST FILTER modes inside generator expressions', async function () {
        const uri = 'file:///test-workspace/completion-genex-list-filter.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<LIST:FILTER,my_list,IN>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_compile_definitions(tgt PRIVATE $<LIST:FILTER,my_list,IN'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('INCLUDE'), 'LIST FILTER genex should suggest INCLUDE/EXCLUDE modes');
    });

    test('should suggest PATH generator expression options', async function () {
        const uri = 'file:///test-workspace/completion-genex-path-option.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<PATH:CMAKE_PATH,NO>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_compile_definitions(tgt PRIVATE $<PATH:CMAKE_PATH,NO'.length }
        });

        assert(result !== null, 'Completion result should not be null');
        const items = Array.isArray(result) ? result : result!.items;
        const labels = new Set(items.map(i => i.label));

        assert(labels.has('NORMALIZE'), 'PATH genex should suggest NORMALIZE when the subcommand supports it');
    });

    test('should provide keyword completion for all builtin commands', async function () {
        this.timeout(120000);
        const cmds: Record<string, { keyword?: string[] }> = require('../../builtin-cmds.json');

        // These commands always override keyword completion with custom suggestions
        const skipCommands = new Set([
            'pkg_check_modules',      // always returns pkg-config suggestions
            'target_link_libraries',  // always returns custom items at index > 0
            'if',
            'elseif',
            'while',
            'find_package',
            'include',
            'cmake_policy',
            'target_compile_definitions',
            'target_compile_features',
            'target_compile_options',
            'target_include_directories',
            'target_link_directories',
            'target_link_options',
            'target_precompile_headers',
            'target_sources',
            'get_property',
            'set_property',
            'define_property',
            'get_target_property',
            'get_cmake_property',
            'get_test_property',
            'set_directory_properties',
            'set_target_properties',
            'set_tests_properties',
            'set_source_files_properties',
            'get_directory_property',
            'get_source_file_property',
            'set',
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

    test('should provide hover information for incomplete command names', async function () {
        const uri = 'file:///test-workspace/hover-incomplete.txt';
        openDocument(uri, 'if(');

        const result = await connection.sendRequest(HoverRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 1 }
        });

        assert(result !== null, 'Hover result should not be null for incomplete commands');
        assert(result!.contents !== undefined);
    });

    test('should provide hover information for snapshot-backed targets', async function () {
        const uri = 'file:///test-workspace/hover-target.txt';
        openDocument(uri, 'target_link_libraries(app PRIVATE ExtCore)');

        connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
            workspaceFolderUri: 'file:///test-workspace',
            snapshot: {
                workspaceFolderUri: 'file:///test-workspace',
                sourceUri: uri,
                projectId: 'test-project',
                buildDirectory: '/test-workspace/build',
                activeBuildType: 'Debug',
                useCMakePresets: true,
                configurePresetName: 'linux-debug',
                buildPresetName: 'linux-debug-build',
                targetNames: ['ExtCore'],
                testNames: [],
                codeModelSummary: { hasCodeModel: true },
                generation: 1,
                sourceKind: 'kylin-cmake-tools',
            },
        });

        const result = await connection.sendRequest(HoverRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'target_link_libraries(app PRIVATE Ext'.length },
        });

        assert(result !== null, 'Target hover result should not be null');
        const hoverContents = result!.contents;
        assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
        assert('kind' in hoverContents);
        assert.strictEqual(hoverContents.kind, 'markdown');
        assert.match(hoverContents.value, /Target: ExtCore/);
        assert.match(hoverContents.value, /Use CMake Presets: Yes/);
        assert.match(hoverContents.value, /Code Model: Available/);
        assert.match(hoverContents.value, /Build Type: Debug/);
        assert.match(hoverContents.value, /Configure Preset: linux-debug/);
        assert.match(hoverContents.value, /Build Preset: linux-debug-build/);
    });

    test('should provide hover information for snapshot-backed tests', async function () {
        const uri = 'file:///test-workspace/hover-test.txt';
        openDocument(uri, 'get_test_property(SmokeSuite PROPERTY TIMEOUT)');

        connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
            workspaceFolderUri: 'file:///test-workspace',
            snapshot: {
                workspaceFolderUri: 'file:///test-workspace',
                sourceUri: uri,
                projectId: 'test-project',
                buildDirectory: '/test-workspace/build',
                activeBuildType: 'Debug',
                useCMakePresets: true,
                testPresetName: 'linux-debug-test',
                packagePresetName: 'linux-debug-package',
                targetNames: [],
                testNames: ['SmokeSuite'],
                codeModelSummary: { hasCodeModel: false },
                generation: 1,
                sourceKind: 'kylin-cmake-tools',
            },
        });

        const result = await connection.sendRequest(HoverRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'get_test_property(Smoke'.length },
        });

        assert(result !== null, 'Test hover result should not be null');
        const hoverContents = result!.contents;
        assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
        assert('kind' in hoverContents);
        assert.strictEqual(hoverContents.kind, 'markdown');
        assert.match(hoverContents.value, /Test: SmokeSuite/);
        assert.match(hoverContents.value, /Use CMake Presets: Yes/);
        assert.match(hoverContents.value, /Code Model: Unavailable/);
        assert.match(hoverContents.value, /Build Type: Debug/);
        assert.match(hoverContents.value, /Test Preset: linux-debug-test/);
        assert.match(hoverContents.value, /Package Preset: linux-debug-package/);
    });

    test('should append cache information to builtin variable hover', async function () {
        const uri = 'file:///test-workspace/hover-cache-builtin-variable.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-cache-builtin-'));
        const content = 'message(STATUS "${CMAKE_BUILD_TYPE}")';

        fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), [
            '//Build type selected for the build.',
            'CMAKE_BUILD_TYPE:STRING=Debug',
        ].join('\n'), 'utf8');

        try {
            openDocument(uri, content);
            const refreshedDiagnostics = waitForDiagnostics(uri);
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-cache-builtin-hover',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: content.indexOf('CMAKE_BUILD_TYPE') + 2 },
            });

            assert(result !== null, 'builtin variable hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert(hoverContents.value.includes('**Cache Variable**: CMAKE\\_BUILD\\_TYPE'));
            assert.match(hoverContents.value, /Cache Type: STRING/);
            assert.match(hoverContents.value, /\*\*Cache Value\*\*[\s\S]*```text\nDebug\n```/);
            assert(hoverContents.value.includes('\n\n---\n\n- Cache Type: STRING'), 'cache metadata should be separated from the value block');
            assert(hoverContents.value.indexOf('```text\nDebug\n```') < hoverContents.value.indexOf('- Cache Type: STRING'), 'cache value should be shown before cache metadata');
            assert.match(hoverContents.value, /can be shadowed by a normal variable in the current scope/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for non-builtin cache variables', async function () {
        const uri = 'file:///test-workspace/hover-cache-custom-variable.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-cache-custom-'));
        const content = 'MY_CUSTOM_SDK';

        fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), [
            '//Path to the custom SDK.',
            'MY_CUSTOM_SDK:PATH=/opt/sdk',
        ].join('\n'), 'utf8');

        try {
            openDocument(uri, content);
            const refreshedDiagnostics = waitForDiagnostics(uri);
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-cache-custom-hover',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: content.indexOf('MY_CUSTOM_SDK') + 2 },
            });

            assert(result !== null, 'custom cache variable hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert(hoverContents.value.includes('**Cache Variable**: MY\\_CUSTOM\\_SDK'));
            assert.match(hoverContents.value, /Cache Type: PATH/);
            assert.match(hoverContents.value, /\*\*Cache Value\*\*[\s\S]*```text\n\/opt\/sdk\n```/);
            assert(hoverContents.value.includes('\n\n---\n\n- Cache Type: PATH'), 'custom cache metadata should be separated from the value block');
            assert(hoverContents.value.indexOf('```text\n/opt/sdk\n```') < hoverContents.value.indexOf('- Cache Type: PATH'), 'custom cache value should be shown before cache metadata');
            assert.match(hoverContents.value, /Cache Help: Path to the custom SDK\./);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should enrich snapshot-backed target hover with File API target details', async function () {
        const uri = 'file:///test-workspace/hover-target-file-api.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-file-api-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');

        fs.mkdirSync(replyDir, { recursive: true });
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'toolchains',
                    version: { major: 1, minor: 0 },
                    jsonFile: 'toolchains-v1.json',
                },
                {
                    kind: 'codemodel',
                    version: { major: 2, minor: 0 },
                    jsonFile: 'codemodel-v2.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'toolchains-v1.json'), JSON.stringify({
            toolchains: [
                {
                    language: 'CXX',
                    compiler: {
                        path: '/usr/bin/c++',
                        commandFragment: '--target x86_64-linux-gnu',
                        id: 'GNU',
                        version: '13.2.0',
                        target: 'x86_64-linux-gnu',
                        implicit: {
                            includeDirectories: ['/usr/include/c++/13', '/usr/local/include'],
                            linkDirectories: ['/usr/lib/gcc'],
                            linkFrameworkDirectories: [],
                            linkLibraries: ['stdc++', 'm'],
                        },
                    },
                    sourceFileExtensions: ['cc', 'cpp'],
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
            configurations: [
                {
                    targets: [
                        {
                            id: 'ExtCore::id',
                            name: 'ExtCore',
                            jsonFile: 'target-extcore.json',
                        },
                    ],
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'target-extcore.json'), JSON.stringify({
            id: 'ExtCore::id',
            name: 'ExtCore',
            type: 'STATIC_LIBRARY',
            imported: true,
            symbolic: true,
            isGeneratorProvided: true,
            folder: {
                name: 'libs',
            },
            paths: {
                source: '/test-workspace',
                build: buildDir,
            },
            nameOnDisk: 'ExtCore.a',
            sources: [
                {
                    path: 'generated/extcore_autogen.cpp',
                    isGenerated: true,
                },
            ],
            compileGroups: [
                {
                    includes: [
                        { path: 'include' },
                        { path: 'generated/include' },
                    ],
                },
            ],
            artifacts: [
                { path: 'lib/ExtCore.a' },
            ],
            dependencies: [
                { id: 'Base::id' },
                { id: 'Utils::id' },
            ],
            defines: [
                { define: 'EXTCORE_EXPORTS' },
            ],
            backtraceGraph: {
                files: ['CMakeLists.txt', 'cmake/ExtCore.cmake'],
                commands: ['add_library', 'target_link_libraries'],
            },
        }), 'utf8');

        try {
            openDocument(uri, 'target_link_libraries(app PRIVATE ExtCore)');

            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-file-api-hover',
                    buildDirectory: buildDir,
                    activeBuildType: 'RelWithDebInfo',
                    useCMakePresets: false,
                    targetNames: ['ExtCore'],
                    testNames: [],
                    codeModelSummary: { hasCodeModel: true },
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: 'target_link_libraries(app PRIVATE Ext'.length },
            });

            assert(result !== null, 'Target hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert(hoverContents.value.includes('Target: ExtCore'));
            assert(hoverContents.value.includes('File API Type: STATIC\\_LIBRARY'));
            assert(hoverContents.value.includes('Target Properties: IMPORTED, SYMBOLIC, GENERATOR\\_PROVIDED'));
            assert(hoverContents.value.includes('Folder Group: libs'));
            assert(hoverContents.value.includes('On-Disk Name: ExtCore.a'));
            assert(hoverContents.value.includes('Generated Sources: 1'));
            assert(hoverContents.value.includes('Include Directories: include, generated/include'));
            assert(hoverContents.value.includes('Artifacts: lib/ExtCore.a'));
            assert(hoverContents.value.includes('Compile Definitions: EXTCORE\\_EXPORTS'));
            assert(hoverContents.value.includes('Backtrace Files: CMakeLists.txt, cmake/ExtCore.cmake'));
            assert(hoverContents.value.includes('Backtrace Commands: add\\_library, target\\_link\\_libraries'));
            assert(hoverContents.value.includes('Dependency Count: 2'));
            assert(hoverContents.value.includes('Toolchain: CXX GNU 13.2.0'));
            assert(hoverContents.value.includes('Compiler Arguments: --target x86\\_64-linux-gnu'));
            assert(hoverContents.value.includes('Implicit Include Directories: /usr/include/c\\+\\+/13, /usr/local/include'));
            assert(hoverContents.value.includes('Implicit Link Directories: /usr/lib/gcc'));
            assert(hoverContents.value.includes('Implicit Link Libraries: stdc\\+\\+, m'));
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for File API backed find_package cache entries', async function () {
        const uri = 'file:///test-workspace/hover-find-package-file-api.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-package-file-api-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');

        fs.mkdirSync(replyDir, { recursive: true });
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'cache',
                    version: { major: 2, minor: 0 },
                    jsonFile: 'cache-v2.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'cache-v2.json'), JSON.stringify({
            entries: [
                {
                    name: 'Example_DIR',
                    type: 'PATH',
                    value: '/opt/example/lib/cmake/Example',
                    properties: [
                        { name: 'HELPSTRING', value: 'Directory containing ExampleConfig.cmake' },
                    ],
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'find_package(Example REQUIRED)');
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-file-api-package-hover',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: 'find_package(Exa'.length },
            });

            assert(result !== null, 'find_package hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert.match(hoverContents.value, /Package: Example/);
            assert.match(hoverContents.value, /Cache Type: PATH/);
            assert.match(hoverContents.value, /Package Directory: \/opt\/example\/lib\/cmake\/Example/);
            assert.match(hoverContents.value, /Cache Help: Directory containing ExampleConfig\.cmake/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for quoted File API backed find_package cache entries', async function () {
        const uri = 'file:///test-workspace/hover-find-package-file-api-quoted.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-package-file-api-quoted-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');

        fs.mkdirSync(replyDir, { recursive: true });
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'cache',
                    version: { major: 2, minor: 0 },
                    jsonFile: 'cache-v2.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'cache-v2.json'), JSON.stringify({
            entries: [
                {
                    name: 'Example_DIR',
                    type: 'PATH',
                    value: '/opt/example/lib/cmake/Example',
                    properties: [
                        {
                            name: 'HELPSTRING',
                            value: 'Directory containing ExampleConfig.cmake',
                        },
                    ],
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'find_package("Example" REQUIRED)');
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-file-api-package-hover-quoted',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: 'find_package("Exa'.length },
            });

            assert(result !== null, 'quoted find_package hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert.match(hoverContents.value, /Package: Example/);
            assert.match(hoverContents.value, /Cache Type: PATH/);
            assert.match(hoverContents.value, /Package Directory: \/opt\/example\/lib\/cmake\/Example/);
            assert.match(hoverContents.value, /Cache Help: Directory containing ExampleConfig\.cmake/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for File API backed external include modules', async function () {
        const uri = 'file:///test-workspace/hover-include-module-file-api.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-module-file-api-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const modulePath = path.join(buildDir, 'cmake', 'ExternalHelpers.cmake');

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(modulePath), { recursive: true });
        fs.writeFileSync(modulePath, '# external helper\n', 'utf8');
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'cmakeFiles',
                    version: { major: 1, minor: 0 },
                    jsonFile: 'cmakeFiles-v1.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'cmakeFiles-v1.json'), JSON.stringify({
            inputs: [
                {
                    path: modulePath,
                    isExternal: true,
                    isGenerated: false,
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'include(ExternalHelpers)');
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-file-api-module-hover',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: 'include(External'.length },
            });

            assert(result !== null, 'include(module) hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert.match(hoverContents.value, /Module: ExternalHelpers/);
            assert.match(hoverContents.value, new RegExp(`Module Path: ${modulePath.replace(/\\/g, '\\\\')}`));
            assert.match(hoverContents.value, /External Input: Yes/);
            assert.match(hoverContents.value, /Generated Input: No/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for quoted File API backed external include modules', async function () {
        const uri = 'file:///test-workspace/hover-include-module-file-api-quoted.txt';
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-module-file-api-quoted-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const modulePath = path.join(buildDir, 'cmake', 'ExternalHelpers.cmake');

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(modulePath), { recursive: true });
        fs.writeFileSync(modulePath, '# external helper\n', 'utf8');
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'cmakeFiles',
                    version: { major: 1, minor: 0 },
                    jsonFile: 'cmakeFiles-v1.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'cmakeFiles-v1.json'), JSON.stringify({
            inputs: [
                {
                    path: modulePath,
                    isExternal: true,
                    isGenerated: false,
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'include("ExternalHelpers")');
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-file-api-module-hover-quoted',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: 'include("External'.length },
            });

            assert(result !== null, 'quoted include(module) hover result should not be null');
            const hoverContents = result!.contents;
            assert(!Array.isArray(hoverContents) && typeof hoverContents !== 'string');
            assert('kind' in hoverContents);
            assert.strictEqual(hoverContents.kind, 'markdown');
            assert.match(hoverContents.value, /Module: ExternalHelpers/);
            assert.match(hoverContents.value, new RegExp(`Module Path: ${modulePath.replace(/\\/g, '\\\\')}`));
            assert.match(hoverContents.value, /External Input: Yes/);
            assert.match(hoverContents.value, /Generated Input: No/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should provide hover information for binary-directory file paths', async function () {
        const uri = 'file:///test-workspace/src/hover-binary-file-path.txt';
        const sourceRoot = URI.parse('file:///test-workspace').fsPath;
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-hover-binary-file-path-'));
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const rootGeneratedPath = path.join(buildDir, 'generated', 'root-helper.cmake');
        const currentGeneratedPath = path.join(buildDir, 'src-build', 'generated', 'src-helper.cmake');
        const content = 'include(${PROJECT_BINARY_DIR}/generated/root-helper.cmake)\ninclude(${CMAKE_CURRENT_BINARY_DIR}/generated/src-helper.cmake)';

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(rootGeneratedPath), { recursive: true });
        fs.mkdirSync(path.dirname(currentGeneratedPath), { recursive: true });
        fs.writeFileSync(rootGeneratedPath, '# root generated helper\n', 'utf8');
        fs.writeFileSync(currentGeneratedPath, '# src generated helper\n', 'utf8');
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'cache',
                    version: { major: 2, minor: 0 },
                    jsonFile: 'cache-v2.json',
                },
                {
                    kind: 'codemodel',
                    version: { major: 2, minor: 8 },
                    jsonFile: 'codemodel-v2.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'cache-v2.json'), JSON.stringify({
            entries: [
                {
                    name: 'CMAKE_HOME_DIRECTORY',
                    value: sourceRoot,
                    type: 'INTERNAL',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
            configurations: [
                {
                    directories: [
                        { source: '.', build: '.' },
                        { source: 'src', build: 'src-build' },
                    ],
                    targets: [],
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, content);
            const refreshedDiagnostics = waitForDiagnostics(uri);
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: 'file:///test-workspace',
                snapshot: {
                    workspaceFolderUri: 'file:///test-workspace',
                    sourceUri: uri,
                    projectId: 'test-project-binary-file-hover',
                    buildDirectory: buildDir,
                    useCMakePresets: false,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });
            await refreshedDiagnostics;

            const projectBinaryResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 0, character: content.indexOf('root-helper.cmake') + 4 },
            });

            assert(projectBinaryResult !== null, 'PROJECT_BINARY_DIR file hover result should not be null');
            const projectBinaryContents = projectBinaryResult!.contents;
            assert(!Array.isArray(projectBinaryContents) && typeof projectBinaryContents !== 'string');
            assert('kind' in projectBinaryContents);
            assert.strictEqual(projectBinaryContents.kind, 'markdown');
            assert.match(projectBinaryContents.value, /File: root-helper\.cmake/);
            assert.match(projectBinaryContents.value, new RegExp(`Resolved Path: ${rootGeneratedPath.replace(/\\/g, '\\\\')}`, 'i'));
            assert.match(projectBinaryContents.value, /In Build Directory: Yes/);

            const currentBinaryResult = await connection.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line: 1, character: 'include(${CMAKE_CURRENT_BINARY_DIR}/generated/src-helper'.length },
            });

            assert(currentBinaryResult !== null, 'CMAKE_CURRENT_BINARY_DIR file hover result should not be null');
            const currentBinaryContents = currentBinaryResult!.contents;
            assert(!Array.isArray(currentBinaryContents) && typeof currentBinaryContents !== 'string');
            assert('kind' in currentBinaryContents);
            assert.strictEqual(currentBinaryContents.kind, 'markdown');
            assert.match(currentBinaryContents.value, /File: src-helper\.cmake/);
            assert.match(currentBinaryContents.value, new RegExp(`Resolved Path: ${currentGeneratedPath.replace(/\\/g, '\\\\')}`, 'i'));
            assert.match(currentBinaryContents.value, /In Build Directory: Yes/);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
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
        assert(result!.signatures[0].parameters !== undefined, 'Signature should expose parameter metadata');
        assert(result!.activeParameter !== undefined, 'Signature help should report an active parameter');
    });

    test('should provide signature help for incomplete commands', async function () {
        const uri = 'file:///test-workspace/signature-incomplete.txt';
        openDocument(uri, 'project(');

        const result = await connection.sendRequest(SignatureHelpRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'project('.length }
        });

        assert(result !== null, 'Signature help should not be null for incomplete commands');
        assert(result!.signatures.length > 0, 'Incomplete commands should still expose signatures');
        assert(result!.activeParameter !== undefined, 'Incomplete commands should still report an active parameter');
    });

    test('should select the matching overload and active parameter for add_library', async function () {
        const uri = 'file:///test-workspace/signature-overload.txt';
        openDocument(uri, 'add_library(foo OBJECT bar.cpp)');

        const result = await connection.sendRequest(SignatureHelpRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'add_library(foo OBJECT '.length + 2 }
        });

        assert(result !== null, 'Signature help should not be null');
        assert.strictEqual(result!.activeSignature, 1, 'Should select the OBJECT overload');
        assert.strictEqual(result!.activeParameter, 2, 'Should highlight the current source argument');
    });

    test('should include markdown cmdsignature documentation in signature help', async function () {
        const uri = 'file:///test-workspace/signature-docs.txt';
        openDocument(uri, 'get_source_file_property(out main.cpp DIRECTORY src LOCATION)');

        const result = await connection.sendRequest(SignatureHelpRequest.type, {
            textDocument: { uri },
            position: { line: 0, character: 'get_source_file_property(out main.cpp DIRECTORY '.length + 2 }
        });

        assert(result !== null, 'Signature help should not be null');
        const documentation = result!.signatures[result!.activeSignature ?? 0].documentation as { value?: string } | undefined;
        assert(documentation?.value?.includes('```cmdsignature'), 'Signature documentation should use a cmdsignature fenced block');
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

    test('should provide a quick fix code action for command case diagnostics', async function () {
        const uri = 'file:///test-workspace/code-action-case.txt';
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'PROJECT(MyProject)');

        const diagnostics = await diagPromise;
        const caseDiagnostic = diagnostics.diagnostics.find(d => d.code === 0);
        assert(caseDiagnostic !== undefined, 'Should publish a command case diagnostic');

        const actions = await connection.sendRequest(CodeActionRequest.type, {
            textDocument: { uri },
            range: caseDiagnostic!.range,
            context: { diagnostics: [caseDiagnostic!] }
        });

        assert(actions !== null, 'Code action response should not be null');
        assert(Array.isArray(actions), 'Code action response should be an array');
        assert(actions.length > 0, 'Should return at least one code action');

        const quickFix = actions[0] as { title?: string; edit?: { changes?: Record<string, Array<{ newText: string }>> } };
        assert(quickFix.title?.includes('PROJECT'), 'Quick fix title should reference the offending command');
        assert.strictEqual(quickFix.edit?.changes?.[uri]?.[0]?.newText, 'project');
    });

    test('should apply changed configuration to subsequent diagnostics', async function () {
        extSettings.cmdCaseDiagnostics = false;
        const configPull = waitForConfigurationPull();
        connection.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
        await configPull;

        const uri = 'file:///test-workspace/diag-case-config-disabled.txt';
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'PROJECT(MyProject)');

        const result = await diagPromise;
        const caseDiags = result.diagnostics.filter(d => d.code === 0 && d.source === 'cmake-intellisence');
        assert.strictEqual(caseDiags.length, 0, 'Command case diagnostics should respect updated configuration');

        extSettings.cmdCaseDiagnostics = true;
        const restoreConfigPull = waitForConfigurationPull();
        connection.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
        await restoreConfigPull;
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

    test('should differentiate between functions and macros', async function () {
        const uri = 'file:///test-workspace/semantic_funcs_macros.txt';
        const content = [
            'function(my_custom_func arg1)',
            'endfunction()',
            'macro(my_custom_macro arg1)',
            'endmacro()',
            'my_custom_func(a)',
            'my_custom_macro(b)'
        ].join('\n');
        openDocument(uri, content);

        // Let the index hydrate top-down by requesting completion once for cache warming
        await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 5, character: 0 }
        });

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(result !== null && result.data !== undefined);
        // data array format: [line_delta, char_delta, length, token_type, token_modifiers]
        // You usually map these back, but for a simple structural check we scan the payload 
        // to see if at least one function type index (7) and macro type index (8) were output.
        // Based on SemanticTokenListener: defaultTokenTypes.indexOf('function') = 7, 'macro' = 8
        const typesUsed = new Set<number>();
        for (let i = 3; i < result.data.length; i += 5) {
            typesUsed.add(result.data[i]);
        }

        // Assert that both function (7) and macro (8) indices exist in the serialized token data.
        assert(typesUsed.has(7), 'Should have generated a function token');
        assert(typesUsed.has(8), 'Should have generated a macro token');
    });

    test('should provide semantic tokens for scoped visible variables', async function () {
        const parentUri = 'file:///test-workspace/semantic_parent.txt';
        const childUri = 'file:///test-workspace/semantic_child.txt';

        const parentDiagnostics = waitForDiagnostics(parentUri);
        const childDiagnostics = waitForDiagnostics(childUri);
        openDocument(parentUri, 'set(GLOBAL_VAR "data")\ninclude(semantic_child.txt)');
        openDocument(childUri, 'message(STATUS ${GLOBAL_VAR})\nmessage(STATUS ${UNSEEN_VAR})');
        await Promise.all([parentDiagnostics, childDiagnostics]);

        // Warm up the caches
        await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri: parentUri },
            position: { line: 0, character: 0 }
        });

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri: childUri }
        });

        assert(result !== null && result.data !== undefined);

        // Default variable index is 5
        let variableTokens = 0;
        for (let i = 3; i < result.data.length; i += 5) {
            if (result.data[i] === 5) { // 'variable' type
                variableTokens++;
            }
        }

        // Expected: GLOBAL_VAR should be highlighted as a variable.
        // Notice we might have multiple tokens, but we expect at least 1 since we have "GLOBAL_VAR".
        // If UNSEEN_VAR is correctly omitted because it's not in the visible files, there should strictly be 1 match for line 0.
        assert(variableTokens > 0, 'Should generate variable token for GLOBAL_VAR derived from parent via SymbolIndex');
    });

    test('should classify condition predicates and operators in semantic tokens', async function () {
        const uri = 'file:///test-workspace/semantic_condition.txt';
        const content = [
            'set(VAR hello)',
            'add_library(my_target INTERFACE)',
            'if(COMMAND message AND TARGET my_target AND VAR STREQUAL hello)',
            'endif()'
        ].join('\n');
        openDocument(uri, content);

        await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line: 2, character: 3 }
        });

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(result !== null && result.data !== undefined);

        const typesUsed = new Set<number>();
        for (let i = 3; i < result.data.length; i += 5) {
            typesUsed.add(result.data[i]);
        }

        assert(typesUsed.has(9), 'Should emit keyword tokens for condition predicates');
        assert(typesUsed.has(15), 'Should emit operator tokens for logical/comparison operators');
        assert(typesUsed.has(5), 'Should emit variable tokens for bare condition variables');
    });

    test('should classify generator expression names and namespace keywords in semantic tokens', async function () {
        const uri = 'file:///test-workspace/semantic_genex.txt';
        const content = 'target_compile_definitions(tgt PRIVATE $<STRING:HASH,value,ALGORITHM:SHA256>)';
        openDocument(uri, content);

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(result !== null && result.data !== undefined);
        const typesUsed = new Set<number>();
        for (let i = 3; i < result.data.length; i += 5) {
            typesUsed.add(result.data[i]);
        }

        assert(typesUsed.has(7), 'Should emit function tokens for generator expression names');
        assert(typesUsed.has(9), 'Should emit keyword tokens for STRING/LIST/PATH namespace arguments');
    });

    test('should classify generator expression argument roles in semantic tokens', async function () {
        const uri = 'file:///test-workspace/semantic_genex_roles.txt';
        const content = [
            'add_library(my_target INTERFACE)',
            'target_compile_definitions(tgt PRIVATE',
            '  $<TARGET_PROPERTY:my_target,INTERFACE_INCLUDE_DIRECTORIES>',
            '  $<CONFIG:Debug>',
            '  $<COMPILE_LANGUAGE:CXX>',
            '  $<TARGET_FILE:my_target>)'
        ].join('\n');
        openDocument(uri, content);

        const result = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(result !== null && result.data !== undefined);
        const typesUsed = new Set<number>();
        for (let i = 3; i < result.data.length; i += 5) {
            typesUsed.add(result.data[i]);
        }

        assert(typesUsed.has(6), 'Should emit property tokens for TARGET_PROPERTY property names');
        assert(typesUsed.has(3), 'Should emit enum tokens for CONFIG and COMPILE_LANGUAGE arguments');
        assert(typesUsed.has(12), 'Should emit string tokens for target-name style generator expression arguments');
    });

    test('should provide semantic token deltas after document changes', async function () {
        const uri = 'file:///test-workspace/semantic-delta.txt';
        openDocument(uri, 'set(MY_VAR "hello")\nmessage(STATUS ${MY_VAR})');

        const full = await connection.sendRequest(SemanticTokensRequest.type, {
            textDocument: { uri }
        });

        assert(full !== null && full.data !== undefined, 'Initial semantic token response should contain data');
        assert(typeof full.resultId === 'string' && full.resultId.length > 0, 'Initial semantic token response should expose a result id');

        changeDocument(uri, 'set(MY_VAR "goodbye")\nmessage(STATUS ${MY_VAR})\nmessage(STATUS ${MY_VAR})');

        const delta = await connection.sendRequest(SemanticTokensDeltaRequest.type, {
            textDocument: { uri },
            previousResultId: full.resultId,
        });

        assert(delta !== null, 'Semantic token delta response should not be null');
        const deltaLike = delta as { edits?: Array<unknown>; data?: number[] };
        if (Array.isArray(deltaLike.edits)) {
            assert(deltaLike.edits.length > 0, 'Semantic token delta should include edits after a document change');
        } else {
            assert(Array.isArray(deltaLike.data) && deltaLike.data.length > 0, 'Fallback full semantic token response should contain data');
        }
    });

    //#endregion ── Semantic Tokens ────────────────────────────────────────
});
