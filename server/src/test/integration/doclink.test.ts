import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
    createProtocolConnection,
    DidOpenTextDocumentNotification,
    DocumentLinkRequest,
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
import { CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION } from '../../cmakeToolsSnapshot';
import { URI } from 'vscode-uri';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { waitForServerReady } from './testUtils';

/**
 * Integration tests for document links (textDocument/documentLink).
 *
 * Fixture files live in server/src/test/integration/fixtures/doclink/ so
 * that real file-system paths can be used for commands that stat() the disk,
 * such as add_subdirectory().
 */
suite('Document Link Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();

    // __dirname at runtime = server/out/test/integration/
    const fixtureDir = path.resolve(
        __dirname, '..', '..', '..', 'src', 'test', 'integration', 'fixtures', 'doclink'
    );
    const fixtureUri = URI.file(fixtureDir).toString();

    const extSettings: ExtensionSettings = {
        cmakePath: 'cmake',
        pkgConfigPath: '',
        cmdCaseDiagnostics: false,
        loggingLevel: 'off'
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

    async function openFixture(relativePath: string): Promise<string> {
        const abs = path.join(fixtureDir, relativePath);
        const uri = fileUri(relativePath);
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, fs.readFileSync(abs, 'utf-8'));
        await diagPromise;
        return uri;
    }

    // ── lifecycle ──────────────────────────────────────────────

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
            return [
                extSettings.cmakePath,
                extSettings.loggingLevel,
                extSettings.cmdCaseDiagnostics,
                extSettings.pkgConfigPath,
            ];
        });
        connection.onNotification(PublishDiagnosticsNotification.type, params => {
            diagnosticEmitter.emit(params.uri, params);
        });

        const initParams: InitializeParams = {
            processId: process.pid,
            capabilities: {},
            rootUri: fixtureUri,
            locale: 'en',
            workspaceFolders: [{ uri: fixtureUri, name: 'doclink-test' }]
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

    // ── add_subdirectory ───────────────────────────────────────

    test('add_subdirectory(app) should link to app/CMakeLists.txt', async function () {
        const uri = await openFixture('CMakeLists.txt');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');

        const expectedTarget = fileUri('app/CMakeLists.txt');

        // Regression for Issue #11: add_subdirectory with a directory argument
        // must produce a link pointing to <dir>/CMakeLists.txt.
        const subDirLink = links.find(l => l.target === expectedTarget);
        assert(
            subDirLink !== undefined,
            `Expected a document link to ${expectedTarget}, got: ${JSON.stringify(links.map(l => l.target))}`
        );

        // The link range must cover the argument text "app", not the command name.
        // Fixture line 3 (0-based): add_subdirectory(app)
        assert.strictEqual(subDirLink.range.start.line, 3, 'Link range should be on line 3');
        const rangeText = 'app';
        const rangeLen = subDirLink.range.end.character - subDirLink.range.start.character;
        assert.strictEqual(rangeLen, rangeText.length, 'Link range should span exactly the argument text');
    });

    test('add_subdirectory with non-existent directory should produce no link', async function () {
        const uri = fileUri('nonexistent-test.cmake');
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'add_subdirectory(no_such_dir)\n');
        await diagPromise;

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');
        const subDirLinks = links.filter(l => l.target?.includes('no_such_dir'));
        assert.strictEqual(subDirLinks.length, 0, 'Non-existent subdirectory should produce no link');
    });

    test('should link supported file-bearing commands to concrete files', async function () {
        const uri = await openFixture('links.cmake');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');

        const linkTargets = new Set(links.map(link => link.target));
        assert(linkTargets.has(fileUri('local/include-local.cmake')), 'include(file) should link to the local include file');
        assert(linkTargets.has(fileUri('config/input.in')), 'configure_file() should link the input file');
        assert(linkTargets.has(fileUri('config/output.txt')), 'configure_file() should link the output file when it exists');
        assert(linkTargets.has(fileUri('src/lib.cpp')), 'add_library() should link source files');
        assert(linkTargets.has(fileUri('include/lib.h')), 'add_library() should link header files');
        assert(linkTargets.has(fileUri('app/main.cpp')), 'add_executable() should link source files while ignoring WIN32');
        assert(linkTargets.has(fileUri('extra/extra.cpp')), 'target_sources() should link source files');
        assert(linkTargets.has(fileUri('include/generated.h')), 'target_sources() should link header-like files');
        assert(Array.from(linkTargets).some(target => target?.endsWith('/CMakePrintHelpers.cmake')), 'include(module) should link to builtin modules');
        assert(Array.from(linkTargets).some(target => target?.endsWith('/FindThreads.cmake')), 'find_package() should link to Find-modules');
    });

    test('should link variable-expanded file and directory arguments via shared path resolution', async function () {
        const uri = await openFixture('variable-links.cmake');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');

        const linkTargets = new Set(links.map(link => link.target));
        assert(linkTargets.has(fileUri('local/include-local.cmake')), 'include(${VAR}) should link to the expanded file');
        assert(linkTargets.has(fileUri('config/input.in')), 'configure_file(${VAR}, ...) should link the expanded input file');
        assert(linkTargets.has(fileUri('config/output.txt')), 'configure_file(..., ${VAR}) should link the expanded output file when it exists');
        assert(linkTargets.has(fileUri('app/CMakeLists.txt')), 'add_subdirectory(${VAR}) should link to the expanded subdirectory CMakeLists.txt');
        assert(linkTargets.has(fileUri('extra/extra.cpp')), 'target_sources(... ${VAR}) should link the expanded source file');
    });

    test('should link quoted file and directory arguments via shared path resolution', async function () {
        const uri = await openFixture('quoted-links.cmake');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');

        const linkTargets = new Set(links.map(link => link.target));
        assert(linkTargets.has(fileUri('local/include-local.cmake')), 'include("...") should link to the local include file');
        assert(linkTargets.has(fileUri('config/input.in')), 'configure_file("...", ...) should link the input file');
        assert(linkTargets.has(fileUri('config/output.txt')), 'configure_file(..., "...") should link the output file when it exists');
        assert(linkTargets.has(fileUri('app/CMakeLists.txt')), 'add_subdirectory("...") should link to the quoted subdirectory CMakeLists.txt');
    });

    test('should link builtin source-directory variables via shared path resolution', async function () {
        const uri = await openFixture('builtin-source-links.cmake');

        const links = await connection.sendRequest(DocumentLinkRequest.type, {
            textDocument: { uri }
        });

        assert(links !== null && Array.isArray(links), 'Should return a link array');

        const linkTargets = new Set(links.map(link => link.target));
        assert(linkTargets.has(fileUri('local/include-local.cmake')), 'include(${CMAKE_CURRENT_SOURCE_DIR}/...) should link to the local file');
        assert(linkTargets.has(fileUri('config/input.in')), 'configure_file(${CMAKE_SOURCE_DIR}/...) should link the input file');
        assert(linkTargets.has(fileUri('config/output.txt')), 'configure_file(${PROJECT_SOURCE_DIR}/...) should link the output file when it exists');
        assert(linkTargets.has(fileUri('app/CMakeLists.txt')), 'add_subdirectory(${PROJECT_SOURCE_DIR}/...) should link to the target CMakeLists.txt');
        assert(linkTargets.has(fileUri('extra/extra.cpp')), 'target_sources(${CMAKE_SOURCE_DIR}/...) should link the source file');
    });

    test('should link include(module) through File API cmake inputs when the module is not builtin', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const externalModulePath = path.join(fixtureDir, 'external-modules', 'ExternalHelpers.cmake');
        const indexPath = path.join(replyDir, 'index-zzz.json');
        const cmakeFilesPath = path.join(replyDir, 'cmakeFiles-v1.json');
        const uri = fileUri('file-api-module-links.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(externalModulePath), { recursive: true });
        fs.writeFileSync(externalModulePath, '# external module\n', 'utf8');
        fs.writeFileSync(indexPath, JSON.stringify({
            objects: [
                {
                    kind: 'cmakeFiles',
                    version: { major: 1, minor: 0 },
                    jsonFile: 'cmakeFiles-v1.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(cmakeFilesPath, JSON.stringify({
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
                    projectId: 'doclink-file-api-module',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const links = await connection.sendRequest(DocumentLinkRequest.type, {
                textDocument: { uri }
            });

            assert(links !== null && Array.isArray(links), 'Should return a link array');
            assert(links.some(link => link.target === URI.file(externalModulePath).toString()), 'include(module) should link to the File API module input');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
            fs.rmSync(path.dirname(externalModulePath), { recursive: true, force: true });
        }
    });

    test('should link quoted include(module) through File API cmake inputs', async function () {
        const buildDir = path.join(fixtureDir, 'build-file-api-quoted-module');
        const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
        const externalModulePath = path.join(fixtureDir, 'external-modules', 'ExternalHelpers.cmake');
        const indexPath = path.join(replyDir, 'index-zzz.json');
        const cmakeFilesPath = path.join(replyDir, 'cmakeFiles-v1.json');
        const uri = fileUri('quoted-file-api-module-links.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(replyDir, { recursive: true });
        fs.mkdirSync(path.dirname(externalModulePath), { recursive: true });
        fs.writeFileSync(externalModulePath, '# external module\n', 'utf8');
        fs.writeFileSync(indexPath, JSON.stringify({
            objects: [
                {
                    kind: 'cmakeFiles',
                    version: { major: 1, minor: 0 },
                    jsonFile: 'cmakeFiles-v1.json',
                },
            ],
        }), 'utf8');
        fs.writeFileSync(cmakeFilesPath, JSON.stringify({
            inputs: [
                {
                    path: externalModulePath,
                    isExternal: true,
                },
            ],
        }), 'utf8');

        try {
            openDocument(uri, 'include("ExternalHelpers")');
            await diagPromise;

            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: {
                    workspaceFolderUri: fixtureUri,
                    sourceUri: uri,
                    projectId: 'doclink-file-api-quoted-module',
                    buildDirectory: buildDir,
                    targetNames: [],
                    testNames: [],
                    generation: 1,
                    sourceKind: 'kylin-cmake-tools',
                },
            });

            const links = await connection.sendRequest(DocumentLinkRequest.type, {
                textDocument: { uri }
            });

            assert(links !== null && Array.isArray(links), 'Should return a link array');
            assert(links.some(link => link.target === URI.file(externalModulePath).toString()), 'include("module") should link to the File API module input');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
            fs.rmSync(path.dirname(externalModulePath), { recursive: true, force: true });
        }
    });

    test('should link find_package to builtin Find-modules and config package entries', async function () {
        const buildDir = path.join(fixtureDir, 'build');
        const cacheFile = path.join(buildDir, 'CMakeCache.txt');
        const examplePackageDir = path.join(fixtureDir, 'packages', 'Example');

        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(cacheFile, `Example_DIR:PATH=${examplePackageDir}\n`, 'utf8');

        try {
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: null,
            });

            const uri = await openFixture('find-packages.cmake');

            const links = await connection.sendRequest(DocumentLinkRequest.type, {
                textDocument: { uri }
            });

            assert(links !== null && Array.isArray(links), 'Should return a link array');

            const linkTargets = new Set(links.map(link => link.target));
            assert(Array.from(linkTargets).some(target => target?.endsWith('/FindThreads.cmake')), 'find_package() should still link builtin Find-modules');
            assert(linkTargets.has(fileUri('packages/Example/ExampleConfig.cmake')), 'find_package() should link config package entries from CMakeCache');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should link quoted find_package to builtin Find-modules and config package entries', async function () {
        const buildDir = path.join(fixtureDir, 'build');
        const cacheFile = path.join(buildDir, 'CMakeCache.txt');
        const examplePackageDir = path.join(fixtureDir, 'packages', 'Example');
        const uri = fileUri('quoted-find-packages.cmake');
        const diagPromise = waitForDiagnostics(uri);

        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(cacheFile, `Example_DIR:PATH=${examplePackageDir}\n`, 'utf8');

        try {
            connection.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, {
                workspaceFolderUri: fixtureUri,
                snapshot: null,
            });

            openDocument(uri, 'find_package("Threads" REQUIRED)\nfind_package("Example" CONFIG REQUIRED)');
            await diagPromise;

            const links = await connection.sendRequest(DocumentLinkRequest.type, {
                textDocument: { uri }
            });

            assert(links !== null && Array.isArray(links), 'Should return a link array');

            const linkTargets = new Set(links.map(link => link.target));
            assert(Array.from(linkTargets).some(target => target?.endsWith('/FindThreads.cmake')), 'quoted find_package() should still link builtin Find-modules');
            assert(linkTargets.has(fileUri('packages/Example/ExampleConfig.cmake')), 'quoted find_package() should link config package entries from CMakeCache');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });
});
