import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
    createProtocolConnection,
    DefinitionRequest,
    DidOpenTextDocumentNotification,
    ExitNotification,
    InitializedNotification,
    InitializeParams,
    InitializeRequest,
    IPCMessageReader,
    IPCMessageWriter,
    Location,
    ProtocolConnection,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    ShutdownRequest,
} from 'vscode-languageserver-protocol/node';
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION } from '../../cmakeToolsSnapshot';
import { URI } from 'vscode-uri';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { createCompatibleConfigurationResponse, waitForServerReady } from './testUtils';

/**
 * Integration tests for Go-to-Definition across multiple files.
 *
 * Fixture files live in server/src/test/fixtures/definition/ so that test
 * data is easy to read, review, and extend without touching test code.
 */
suite('Definition Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();

    // Fixture directory – source tree, not the compiled output tree
    // __dirname at runtime = server/out/test/integration/
    const fixtureDir = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'integration', 'fixtures', 'definition');
    const fixtureUri = URI.file(fixtureDir).toString();

    const extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        pkgConfigPath: '',
        cmdCaseDiagnostics: false,
        loggingLevel: 'off'
    };

    // ── helpers ────────────────────────────────────────────────

    function fileUri(relativePath: string): string {
        return URI.file(path.join(fixtureDir, relativePath)).toString();
    }

    function openDocument(uri: string, content: string): void {
        docVersion++;
        connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: 'cmake', version: docVersion, text: content }
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

    /** Open a fixture file from the fixtures directory, wait for server to process it. */
    async function openFixture(relativePath: string): Promise<string> {
        const abs = path.join(fixtureDir, relativePath);
        const uri = fileUri(relativePath);
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, fs.readFileSync(abs, 'utf-8'));
        await diagPromise;
        return uri;
    }

    async function getDefinition(uri: string, line: number, character: number) {
        return connection.sendRequest(DefinitionRequest.type, {
            textDocument: { uri },
            position: { line, character }
        });
    }

    // ── lifecycle ──────────────────────────────────────────────

    suiteSetup(async function () {
        this.timeout(30000);

        // Start the language server
        const serverModule = path.resolve(__dirname, '..', '..', 'server.js');
        serverProcess = cp.fork(serverModule, ['--node-ipc'], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        });

        connection = createProtocolConnection(
            new IPCMessageReader(serverProcess),
            new IPCMessageWriter(serverProcess)
        );
        connection.listen();

        let configurationRequested: () => void;
        const configurationPromise = new Promise<void>(r => { configurationRequested = r; });
        const readyPromise = waitForServerReady(connection);

        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest('workspace/configuration', () => {
            configurationRequested();
            return createCompatibleConfigurationResponse(extSettings);
        });
        connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
            diagnosticEmitter.emit(params.uri, params);
        });

        const initParams: InitializeParams = {
            processId: process.pid,
            capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
            rootUri: fixtureUri,
            locale: 'en',
            workspaceFolders: [{ uri: fixtureUri, name: 'def-test' }]
        };

        await connection.sendRequest(InitializeRequest.type, initParams);
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
        if (serverProcess) { serverProcess.kill(); }
    });

    // ── Single-file definition ─────────────────────────────────

    test('function defined and used in same file', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 13: root_func(${ROOT_VAR})   — cursor on "root_func"
        const result = await getDefinition(uri, 13, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find at least one definition');
        assert.strictEqual(locs[0].uri, uri, 'Definition should be in root CMakeLists.txt');
        assert.strictEqual(locs[0].range.start.line, 5, 'Function defined at line 5');
    });

    test('variable defined and used in same file', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 13: root_func(${ROOT_VAR})   — cursor on "ROOT_VAR"
        const result = await getDefinition(uri, 13, 17);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 3, 'ROOT_VAR defined at line 3');
    });

    // ── Cross-file: include() ──────────────────────────────────

    test('function defined in included file, used in root', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 14: helper_func(${HELPER_VAR})  — cursor on "helper_func"
        const result = await getDefinition(uri, 14, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'),
            'Definition should be in include/helpers.cmake');
        assert.strictEqual(locs[0].range.start.line, 2, 'helper_func defined at line 2');
    });

    test('variable defined in included file, used in root', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 14: helper_func(${HELPER_VAR})  — cursor on "HELPER_VAR"
        const result = await getDefinition(uri, 14, 18);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'),
            'Definition should be in include/helpers.cmake');
        assert.strictEqual(locs[0].range.start.line, 0, 'HELPER_VAR defined at line 0');
    });

    test('find_package should resolve to the builtin Find-module when available', async function () {
        const uri = await openFixture('find-packages.cmake');
        const result = await getDefinition(uri, 0, 16);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the builtin Find-module');
        assert(locs[0].uri.endsWith('/FindThreads.cmake'), `Expected FindThreads.cmake, got ${locs[0].uri}`);
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('find_package should resolve to a config package entry from CMakeCache', async function () {
        const buildDir = path.join(fixtureDir, 'build');
        const cacheFile = path.join(buildDir, 'CMakeCache.txt');
        const examplePackageDir = path.join(fixtureDir, 'packages', 'Example');
        const exampleConfigUri = fileUri('packages/Example/ExampleConfig.cmake');

        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(cacheFile, `Example_DIR:PATH=${examplePackageDir}\n`, 'utf8');

        try {
            const uri = await openFixture('find-packages.cmake');
            const result = await getDefinition(uri, 1, 16);

            assert(result !== null, 'Definition should not be null');
            const locs = (Array.isArray(result) ? result : [result]) as Location[];
            assert(locs.length > 0, 'Should find the config package entry file');
            assert.strictEqual(locs[0].uri, exampleConfigUri);
            assert.strictEqual(locs[0].range.start.line, 0);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('include file argument should resolve to the included file', async function () {
        const uri = await openFixture('CMakeLists.txt');
        const result = await getDefinition(uri, 9, 12);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0, 'File definitions should point at the start of the target file');
    });

    test('include module argument should resolve through File API cmake inputs when the module is not builtin', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const externalModulePath = path.join(fixtureDir, 'external-modules', 'ExternalHelpers.cmake');
        const uri = fileUri('file-api-module-definition.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(externalModulePath), { recursive: true });
        fs.writeFileSync(externalModulePath, '# external module\n', 'utf8');
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
                    path: externalModulePath,
                    isExternal: true,
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'include(ExternalHelpers)');
            await diagPromise;

            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'definition-file-api-module',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const result = await getDefinition(uri, 0, 'include(External'.length);

            assert(result !== null, 'Definition should not be null');
            const locs = (Array.isArray(result) ? result : [result]) as Location[];
            assert(locs.length > 0, 'Should find the File API module input');
            assert.strictEqual(locs[0].uri, URI.file(externalModulePath).toString());
            assert.strictEqual(locs[0].range.start.line, 0);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
            fs.rmSync(path.dirname(externalModulePath), { recursive: true, force: true });
        }
    });

    test('include file argument should resolve binary-directory variables through shared path resolution', async function () {
        const buildDir = path.join(fixtureDir, 'build-binary-vars');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const rootGeneratedPath = path.join(buildDir, 'generated', 'root-helper.cmake');
        const currentGeneratedPath = path.join(buildDir, 'src-build', 'generated', 'src-helper.cmake');
        const uri = fileUri('src/binary-dir-definition.cmake');
        const diagPromise = waitForDiagnostics(uri);

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
                    value: fixtureDir,
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
            openDocument(uri, 'include(${PROJECT_BINARY_DIR}/generated/root-helper.cmake)\ninclude(${CMAKE_CURRENT_BINARY_DIR}/generated/src-helper.cmake)');
            await diagPromise;

            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'definition-binary-dir-vars',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const projectBinaryResult = await getDefinition(uri, 0, 'include(${PROJECT_BINARY_DIR}/generated/root'.length);
            assert(projectBinaryResult !== null, 'PROJECT_BINARY_DIR definition should not be null');
            const projectBinaryLocs = (Array.isArray(projectBinaryResult) ? projectBinaryResult : [projectBinaryResult]) as Location[];
            assert.strictEqual(projectBinaryLocs[0].uri, URI.file(rootGeneratedPath).toString());
            assert.strictEqual(projectBinaryLocs[0].range.start.line, 0);

            const currentBinaryResult = await getDefinition(uri, 1, 'include(${CMAKE_CURRENT_BINARY_DIR}/generated/src'.length);
            assert(currentBinaryResult !== null, 'CMAKE_CURRENT_BINARY_DIR definition should not be null');
            const currentBinaryLocs = (Array.isArray(currentBinaryResult) ? currentBinaryResult : [currentBinaryResult]) as Location[];
            assert.strictEqual(currentBinaryLocs[0].uri, URI.file(currentGeneratedPath).toString());
            assert.strictEqual(currentBinaryLocs[0].range.start.line, 0);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    // ── Cross-file: add_subdirectory() ─────────────────────────

    test('root function used in subdirectory file', async function () {
        const uri = await openFixture('src/CMakeLists.txt');
        // line 9: root_func(${ROOT_VAR})   — cursor on "root_func"
        const result = await getDefinition(uri, 9, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('CMakeLists.txt'),
            'root_func should resolve to root CMakeLists.txt');
        assert.strictEqual(locs[0].range.start.line, 5);
    });

    test('add_subdirectory argument should resolve to subdirectory CMakeLists.txt', async function () {
        const uri = await openFixture('CMakeLists.txt');
        const result = await getDefinition(uri, 11, 18);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0, 'Subdirectory definitions should point at the child CMakeLists start');
    });

    test('command definition should ignore cached files outside the reachable entry tree', async function () {
        const uri = await openFixture('src/CMakeLists.txt');
        const unrelatedUri = await openFixture('unrelated.cmake');
        const result = await getDefinition(uri, 9, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.ok(!locs.some(l => l.uri === unrelatedUri), 'Should not include unrelated cached definitions');
    });

    test('root variable used in subdirectory file', async function () {
        const uri = await openFixture('src/CMakeLists.txt');
        // line 9: root_func(${ROOT_VAR})  — cursor on "ROOT_VAR"
        const result = await getDefinition(uri, 9, 16);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('CMakeLists.txt'),
            'ROOT_VAR should resolve to root CMakeLists.txt');
        assert.strictEqual(locs[0].range.start.line, 3);
    });

    test('function defined and used in same subdirectory', async function () {
        const uri = await openFixture('src/CMakeLists.txt');
        // line 10: src_func(${SRC_VAR})  — cursor on "src_func"
        const result = await getDefinition(uri, 10, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 2);
    });

    // ── Cross-file: nested add_subdirectory() ──────────────────

    test('root function used in deeply nested subdirectory', async function () {
        const uri = await openFixture('src/lib/CMakeLists.txt');
        // line 6: root_func(${ROOT_VAR})   — cursor on "root_func"
        const result = await getDefinition(uri, 6, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('CMakeLists.txt'),
            'root_func should resolve all the way back to root');
        assert.strictEqual(locs[0].range.start.line, 5);
    });

    test('variable defined in deeply nested subdirectory, used locally', async function () {
        const uri = await openFixture('src/lib/CMakeLists.txt');
        // line 7: lib_func(${LIB_VAR})  — cursor on "LIB_VAR"
        const result = await getDefinition(uri, 7, 14);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('src/lib/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0, 'LIB_VAR defined at line 0');
    });

    test('function defined in deeply nested subdirectory, used locally', async function () {
        const uri = await openFixture('src/lib/CMakeLists.txt');
        // line 7: lib_func(${LIB_VAR})  — cursor on "lib_func"
        const result = await getDefinition(uri, 7, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('src/lib/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 2, 'lib_func defined at line 2');
    });

    // ── Edge cases ─────────────────────────────────────────────

    test('builtin command should return null', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 0: cmake_minimum_required(VERSION 3.10) — cursor on builtin cmd
        const result = await getDefinition(uri, 0, 5);
        assert.strictEqual(result, null, 'Builtin command should not have a definition');
    });

    test('macro definition and usage across files', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 15: helper_macro(hello) — cursor on "helper_macro"
        const result = await getDefinition(uri, 15, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 6, 'helper_macro defined at line 6');
    });

    test('target name used as target_link_libraries receiver should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const result = await getDefinition(uri, 2, 23);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the app target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 1, 'app target should resolve to add_executable()');
    });

    test('target dependency used in target_link_libraries should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const result = await getDefinition(uri, 2, 35);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the core target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 0, 'core target should resolve to add_library()');
    });

    test('target predicate operand in if(TARGET ...) should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const result = await getDefinition(uri, 3, 11);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the core target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 0, 'core target should resolve to add_library()');
    });

    test('target operand in get_target_property(... LOCATION) should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'targets.cmake'), 'utf8').split(/\r?\n/);
        const targetOffset = lines[6].indexOf(' core ');
        const result = await getDefinition(uri, 6, targetOffset + 2);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the core target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 0, 'core target should resolve to add_library()');
    });

    test('target receiver in target_sources should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const result = await getDefinition(uri, 7, 16);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the app target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 1, 'app target should resolve to add_executable()');
    });

    test('target receiver in target_include_directories should resolve to target definition', async function () {
        const uri = await openFixture('targets.cmake');
        const result = await getDefinition(uri, 8, 28);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the app target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 1, 'app target should resolve to add_executable()');
    });

    test('alias target dependency should resolve to the alias definition', async function () {
        const uri = await openFixture('advanced-targets.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'advanced-targets.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 4, lines[4].indexOf('core_alias') + 1);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the alias target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 1, 'core_alias should resolve to add_library(... ALIAS ...)');
    });

    test('namespaced imported target dependency should resolve to its definition', async function () {
        const uri = await openFixture('advanced-targets.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'advanced-targets.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 4, lines[4].indexOf('Foo::Core') + 1);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the imported target definition');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 2, 'Foo::Core should resolve to add_library(... IMPORTED)');
    });

    test('TARGET_FILE generator-expression operand should resolve to the target definition', async function () {
        const uri = await openFixture('genex-targets.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'genex-targets.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 3, lines[3].indexOf('core') + 1);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the target declaration from inside TARGET_FILE');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 0, 'core should resolve to add_library() instead of the shadowing variable');
    });

    test('TARGET_PROPERTY generator-expression target operand should resolve to the target definition', async function () {
        const uri = await openFixture('genex-targets.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'genex-targets.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 4, lines[4].indexOf('core') + 1);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find the target declaration from inside TARGET_PROPERTY');
        assert.strictEqual(locs[0].uri, uri);
        assert.strictEqual(locs[0].range.start.line, 0, 'core should resolve to add_library() instead of the shadowing variable');
    });

    test('configure_file input should resolve to the referenced file', async function () {
        const uri = await openFixture('files.cmake');
        const result = await getDefinition(uri, 0, 18);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('config/input.in'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('source file argument in add_library should resolve to the referenced file', async function () {
        const uri = await openFixture('files.cmake');
        const result = await getDefinition(uri, 1, 28);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('sources/lib.cpp'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('source file argument in add_executable should resolve to the referenced file', async function () {
        const uri = await openFixture('files.cmake');
        const result = await getDefinition(uri, 2, 26);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('sources/tool.cpp'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('source file argument in target_sources should resolve to the referenced file', async function () {
        const uri = await openFixture('files.cmake');
        const result = await getDefinition(uri, 3, 30);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('sources/extra.cpp'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('include file argument using CMAKE_CURRENT_LIST_DIR should resolve to the included file', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const result = await getDefinition(uri, 0, 35);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('include file argument using CMAKE_CURRENT_LIST_DIR should resolve even when cursor is on the variable sigil', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const result = await getDefinition(uri, 0, 8);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('add_subdirectory argument using CMAKE_CURRENT_LIST_DIR should resolve to child CMakeLists.txt', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const result = await getDefinition(uri, 1, 43);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('configure_file input using CMAKE_CURRENT_LIST_DIR should resolve to the referenced file', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const result = await getDefinition(uri, 2, 43);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('config/input.in'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('target_sources file argument using CMAKE_CURRENT_LIST_DIR should resolve to the referenced file', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const result = await getDefinition(uri, 4, 47);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('sources/extra.cpp'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('include file argument using CMAKE_CURRENT_SOURCE_DIR should resolve to the included file', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'builtin-paths.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 5, lines[5].indexOf('CMAKE_CURRENT_SOURCE_DIR') + 2);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('add_subdirectory argument using CMAKE_SOURCE_DIR should resolve to child CMakeLists.txt', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'builtin-paths.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 6, lines[6].indexOf('CMAKE_SOURCE_DIR') + 2);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('configure_file input using PROJECT_SOURCE_DIR should resolve to the referenced file', async function () {
        const uri = await openFixture('builtin-paths.cmake');
        const lines = fs.readFileSync(path.join(fixtureDir, 'builtin-paths.cmake'), 'utf8').split(/\r?\n/);
        const result = await getDefinition(uri, 7, lines[7].indexOf('PROJECT_SOURCE_DIR') + 2);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('config/input.in'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('include file argument using a set variable should resolve to the included file', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 2, 12);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('add_subdirectory argument using a set variable should resolve to child CMakeLists.txt', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 4, 20);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('configure_file input using a set variable should resolve to the referenced file', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 6, 20);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('config/input.in'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('quoted include, add_subdirectory, and configure_file arguments should resolve to existing paths', async function () {
        const relativePath = 'quoted-paths.cmake';
        const uri = await openFixture(relativePath);
        const lines = fs.readFileSync(path.join(fixtureDir, relativePath), 'utf8').split(/\r?\n/);

        const includeResult = await getDefinition(uri, 0, lines[0].indexOf('include/helpers.cmake') + 2);
        assert(includeResult !== null, 'Quoted include path definition should not be null');
        const includeLocs = (Array.isArray(includeResult) ? includeResult : [includeResult]) as Location[];
        assert.strictEqual(includeLocs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(includeLocs[0].range.start.line, 0);

        const subdirResult = await getDefinition(uri, 1, lines[1].indexOf('src') + 2);
        assert(subdirResult !== null, 'Quoted add_subdirectory path definition should not be null');
        const subdirLocs = (Array.isArray(subdirResult) ? subdirResult : [subdirResult]) as Location[];
        assert.strictEqual(subdirLocs[0].uri, fileUri('src/CMakeLists.txt'));
        assert.strictEqual(subdirLocs[0].range.start.line, 0);

        const configureInputResult = await getDefinition(uri, 2, lines[2].indexOf('config/input.in') + 2);
        assert(configureInputResult !== null, 'Quoted configure_file input definition should not be null');
        const configureInputLocs = (Array.isArray(configureInputResult) ? configureInputResult : [configureInputResult]) as Location[];
        assert.strictEqual(configureInputLocs[0].uri, fileUri('config/input.in'));
        assert.strictEqual(configureInputLocs[0].range.start.line, 0);
    });

    test('target_sources file argument using chained set variables should resolve to the referenced file', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 10, 35);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('sources/extra.cpp'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('include file argument using set(VAR prefix/${OTHER}) should resolve to the included file', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 13, 12);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('include/helpers.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    test('add_subdirectory using a set variable for a nested path should resolve to child CMakeLists.txt', async function () {
        const uri = await openFixture('variable-paths.cmake');
        const result = await getDefinition(uri, 15, 20);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert.strictEqual(locs[0].uri, fileUri('src/lib/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });

    // ── Missing Coverage: Edge Cases and Negative Scopes ───────────────────────

    test('function scoping is global (subdirectory function called from root)', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 18: lib_func(${LIB_VAR}) — cursor on "lib_func"
        const result = await getDefinition(uri, 18, 3);

        assert(result !== null, 'Definition should not be null');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0, 'Should find lib_func globally');
        assert.strictEqual(locs[0].uri, fileUri('src/lib/CMakeLists.txt'));
        assert.strictEqual(locs[0].range.start.line, 2);
    });

    test('variable scoping isolates upward pollution (subdirectory var accessed from root)', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 18: lib_func(${LIB_VAR}) — cursor on "LIB_VAR"
        const result = await getDefinition(uri, 18, 12);

        assert.strictEqual(result, null, 'LIB_VAR from subdirectory should NOT be visible in root');
    });

    test('variable scoping isolates parallel subdirectories (lib2 var accessed from src)', async function () {
        const uri = await openFixture('src/CMakeLists.txt');
        // line 13: message(${LIB_VAR}) — cursor on "LIB_VAR"
        const result1 = await getDefinition(uri, 13, 11);
        assert.strictEqual(result1, null, 'LIB_VAR from child should NOT be visible in parent');

        // line 14: message(${LIB2_VAR}) — cursor on "LIB2_VAR"
        const result2 = await getDefinition(uri, 14, 11);
        assert.strictEqual(result2, null, 'LIB2_VAR from child should NOT be visible in parent');
    });

    test('circular includes should resolve without max call stack and find variables', async function () {
        const uri = await openFixture('CMakeLists.txt');
        // line 22: message(${LOOP_VAR}) — cursor on "LOOP_VAR"
        const result = await getDefinition(uri, 22, 11);

        assert(result !== null, 'Definition should be resolved inside circular included files');
        const locs = (Array.isArray(result) ? result : [result]) as Location[];
        assert(locs.length > 0);
        assert.strictEqual(locs[0].uri, fileUri('include/loop1.cmake'));
        assert.strictEqual(locs[0].range.start.line, 0);
    });
});
