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
import { URI } from 'vscode-uri';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { waitForServerReady } from './testUtils';

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
            return [
                extSettings.cmakePath,
                extSettings.loggingLevel,
                extSettings.cmdCaseDiagnostics,
                extSettings.pkgConfigPath
            ];
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
