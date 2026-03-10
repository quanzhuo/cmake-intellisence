import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
    CompletionItem,
    CompletionList,
    CompletionRequest,
    DidOpenTextDocumentNotification,
    ExitNotification,
    IPCMessageReader,
    IPCMessageWriter,
    InitializeParams,
    InitializeRequest,
    InitializedNotification,
    ProtocolConnection,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    ShutdownRequest,
    createProtocolConnection
} from 'vscode-languageserver-protocol/node';
import { URI } from 'vscode-uri';
import { ExtensionSettings } from '../../cmakeInfo';

suite('Index Completion Integration Tests', () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();

    const fixtureDir = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'integration', 'fixtures', 'definition');
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

    async function getCompletions(uri: string, line: number, character: number) {
        return connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position: { line, character }
        });
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
        await new Promise(r => setTimeout(r, 3000));

        // Pre-warm the cache completely by opening the root file
        await openFixture('CMakeLists.txt');
    });

    suiteTeardown(async function () {
        if (connection) {
            await connection.sendRequest(ShutdownRequest.type);
            connection.sendNotification(ExitNotification.type);
            connection.dispose();
        }
        if (serverProcess) { serverProcess.kill(); }
    });

    test('should provide completions for custom macros/functions defined in included files', async () => {
        const uri = await openFixture('src/CMakeLists.txt');

        // request on empty line 11 (0-based)
        const completions = await getCompletions(uri, 11, 0);
        const items = (completions as CompletionList | CompletionItem[] | null);
        const list = Array.isArray(items) ? items : items?.items || [];

        const labels = list.map(i => i.label);

        assert.ok(labels.includes('root_func'), 'Missing root_func');
        assert.ok(labels.includes('src_func'), 'Missing src_func');
        assert.ok(labels.includes('helper_func'), 'Missing helper_func');
        assert.ok(labels.includes('helper_macro'), 'Missing helper_macro');
    });

    test('should provide completions for visible variables defined globally or upward', async () => {
        const uri = await openFixture('src/CMakeLists.txt');

        // Use the existing line 9 (0-indexed): root_func(${ROOT_VAR})
        const completionsRoot = await getCompletions(uri, 9, 13);
        const itemsRoot = (completionsRoot as CompletionList | CompletionItem[] | null);
        const listRoot = Array.isArray(itemsRoot) ? itemsRoot : itemsRoot?.items || [];
        const labelsRoot = listRoot.map(i => i.label);

        assert.ok(labelsRoot.includes('ROOT_VAR'), 'Missing ROOT_VAR from ancestor');

        // Use the existing line 10 (0-indexed): src_func(${SRC_VAR})
        const completionsSrc = await getCompletions(uri, 10, 13);
        const itemsSrc = (completionsSrc as CompletionList | CompletionItem[] | null);
        const listSrc = Array.isArray(itemsSrc) ? itemsSrc : itemsSrc?.items || [];
        const labelsSrc = listSrc.map(i => i.label);

        assert.ok(labelsSrc.includes('SRC_VAR'), 'Missing SRC_VAR from self scope');
    });

});
