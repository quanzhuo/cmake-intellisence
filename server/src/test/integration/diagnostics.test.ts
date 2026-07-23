import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
    createProtocolConnection,
    DidOpenTextDocumentNotification,
    ExitNotification,
    InitializedNotification,
    InitializeParams,
    InitializeRequest,
    IPCMessageReader,
    IPCMessageWriter,
    ProtocolConnection,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    ShutdownRequest,
} from 'vscode-languageserver-protocol/node';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION } from '../../cmakeToolsSnapshot';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { DIAG_CODE_MISSING_FILE_PATH, DIAG_CODE_MISSING_SUBDIRECTORY } from '../../pathDiagnostics';
import { createConfigurationResponse, waitForServerReady } from './testUtils';

suite('Diagnostics Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();

    const fixtureDir = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'integration', 'fixtures', 'diagnostics');
    const fixtureUri = URI.file(fixtureDir).toString();

    const extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        pkgConfigPath: '',
        cmdCaseDiagnostics: false,
        loggingLevel: 'off',
    };

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

    async function openFixture(relativePath: string): Promise<PublishDiagnosticsParams> {
        const abs = path.join(fixtureDir, relativePath);
        const uri = fileUri(relativePath);
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, fs.readFileSync(abs, 'utf-8'));
        return diagPromise;
    }

    suiteSetup(async function () {
        this.timeout(30000);

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
            return createConfigurationResponse(extSettings);
        });
        connection.onNotification(PublishDiagnosticsNotification.type, params => {
            diagnosticEmitter.emit(params.uri, params);
        });

        const initParams: InitializeParams = {
            processId: process.pid,
            capabilities: {},
            rootUri: fixtureUri,
            locale: 'en',
            workspaceFolders: [{ uri: fixtureUri, name: 'diagnostics-test' }]
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
        if (serverProcess) {
            serverProcess.kill();
        }
    });

    test('should publish warnings for deterministically missing file paths', async function () {
        const diagnostics = (await openFixture('missing-paths.cmake')).diagnostics;

        assert.strictEqual(diagnostics.length, 7, 'Expected one warning per missing deterministic path');
        assert(diagnostics.every(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning));

        const codes = diagnostics.map(diagnostic => String(diagnostic.code));
        assert.strictEqual(codes.filter(code => code === DIAG_CODE_MISSING_FILE_PATH).length, 6);
        assert.strictEqual(codes.filter(code => code === DIAG_CODE_MISSING_SUBDIRECTORY).length, 1);

        const messages = diagnostics.map(diagnostic => diagnostic.message);
        assert(messages.some(message => /include-local\.cmake/.test(message)));
        assert(messages.some(message => /subdir/.test(message)));
        assert(messages.some(message => /config\.in/.test(message)));
        assert(messages.some(message => /lib\.cpp/.test(message)));
        assert(messages.some(message => /main\.cpp/.test(message)));
        assert(messages.some(message => /extra\.cpp/.test(message)));
        assert(messages.some(message => /generated\.h/.test(message)));
    });

    test('should skip ambiguous or unresolved path references', async function () {
        const diagnostics = (await openFixture('unresolved-paths.cmake')).diagnostics;

        assert.strictEqual(diagnostics.length, 0, 'Unresolved variable-backed paths should not emit diagnostics');
    });

    test('should not publish warnings for quoted paths that exist on disk', async function () {
        const diagnostics = (await openFixture('quoted-valid-paths.cmake')).diagnostics;

        assert.strictEqual(diagnostics.length, 0, 'Quoted existing paths should not emit diagnostics');
    });

    test('should suppress include missing-file diagnostics for File API known inputs', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const knownInputPath = path.join(fixtureDir, 'missing', 'generated-include.cmake');
        const uri = fileUri('file-api-known-input.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(replyDir, { recursive: true });
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
                    path: knownInputPath,
                    isGenerated: true,
                },
            ],
        }), 'utf8');

        try {
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'diagnostics-file-api-input',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            openDocument(uri, 'include(missing/generated-include.cmake)');
            const diagnostics = (await diagPromise).diagnostics;
            assert.strictEqual(diagnostics.length, 0, 'Known File API include inputs should not emit missing-file diagnostics');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should suppress generated source diagnostics for File API target snapshots', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api-generated');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const uri = fileUri('file-api-generated-source.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(replyDir, { recursive: true });
        fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
            objects: [
                {
                    kind: 'codemodel',
                    version: { major: 2, minor: 0 },
                    jsonFile: 'codemodel-v2.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
            configurations: [
                {
                    targets: [
                        {
                            id: 'test_lib::id',
                            name: 'test_lib',
                            jsonFile: 'target-test-lib.json',
                        },
                    ],
                },
            ],
        }), 'utf8');
        fs.writeFileSync(path.join(replyDir, 'target-test-lib.json'), JSON.stringify({
            id: 'test_lib::id',
            name: 'test_lib',
            type: 'STATIC_LIBRARY',
            paths: {
                source: fixtureDir,
                build: buildDir,
            },
            sources: [
                {
                    path: 'missing/generated.cpp',
                    isGenerated: true,
                },
            ],
        }), 'utf8');

        try {
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'diagnostics-file-api-generated',
                    buildDirectory: buildDir,
                    targetNames: ['test_lib'],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            openDocument(uri, 'add_library(test_lib STATIC missing/generated.cpp)');
            const diagnostics = (await diagPromise).diagnostics;
            assert.strictEqual(diagnostics.length, 0, 'Generated sources from File API target snapshots should not emit missing-file diagnostics');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should refresh open-document diagnostics when File API snapshot appears and disappears', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api-refresh');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const knownInputPath = path.join(fixtureDir, 'missing', 'generated-include.cmake');
        const uri = fileUri('file-api-refresh.cmake');

        fs.mkdirSync(replyDir, { recursive: true });
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
                    path: knownInputPath,
                    isGenerated: true,
                },
            ],
        }), 'utf8');

        try {
            const initialDiagnosticsPromise = waitForDiagnostics(uri);
            openDocument(uri, 'include(missing/generated-include.cmake)');
            const initialDiagnostics = (await initialDiagnosticsPromise).diagnostics;
            assert.strictEqual(initialDiagnostics.length, 1, 'Expected initial missing-file diagnostic before File API snapshot arrives');

            const suppressedDiagnosticsPromise = waitForDiagnostics(uri);
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'diagnostics-file-api-refresh',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                    useCMakePresets: false,
                },
            });
            const suppressedDiagnostics = (await suppressedDiagnosticsPromise).diagnostics;
            assert.strictEqual(suppressedDiagnostics.length, 0, 'Diagnostics should be recomputed and suppressed when File API snapshot appears');

            const restoredDiagnosticsPromise = waitForDiagnostics(uri);
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: null,
            });
            const restoredDiagnostics = (await restoredDiagnosticsPromise).diagnostics;
            assert.strictEqual(restoredDiagnostics.length, 1, 'Diagnostics should be recomputed when File API snapshot disappears');
            assert.strictEqual(String(restoredDiagnostics[0].code), DIAG_CODE_MISSING_FILE_PATH);
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });
});
