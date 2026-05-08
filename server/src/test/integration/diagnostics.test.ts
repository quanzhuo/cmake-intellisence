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
import { ExtensionSettings } from '../../cmakeEnvironment';
import { DIAG_CODE_MISSING_FILE_PATH, DIAG_CODE_MISSING_SUBDIRECTORY } from '../../pathDiagnostics';
import { waitForServerReady } from './testUtils';

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
            return [
                extSettings.cmakePath,
                extSettings.loggingLevel,
                extSettings.cmdCaseDiagnostics,
                extSettings.pkgConfigPath
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
});