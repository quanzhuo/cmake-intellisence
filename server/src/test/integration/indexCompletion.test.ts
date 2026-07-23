import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
    CompletionItem,
    CompletionList,
    CompletionRequest,
    DefinitionRequest,
    DidChangeTextDocumentNotification,
    DidOpenTextDocumentNotification,
    ExitNotification,
    IPCMessageReader,
    IPCMessageWriter,
    InitializeParams,
    InitializeRequest,
    InitializedNotification,
    Location,
    ProtocolConnection,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    ShutdownRequest,
    createProtocolConnection
} from 'vscode-languageserver-protocol/node';
import { URI } from 'vscode-uri';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { createConfigurationResponse, waitForServerReady } from './testUtils';

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

    async function getDefinition(uri: string, line: number, character: number) {
        return connection.sendRequest(DefinitionRequest.type, {
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
        const readyPromise = waitForServerReady(connection);
        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest('workspace/configuration', () => {
            configurationRequested();
            return createConfigurationResponse(extSettings);
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

    test('should provide target completions from indexed workspace files', async () => {
        const defsUri = fileUri('indexed-targets.cmake');
        const defsDiagPromise = waitForDiagnostics(defsUri);
        openDocument(defsUri, 'add_library(root_lib INTERFACE)\nadd_library(src_lib INTERFACE)\n');
        await defsDiagPromise;

        const uri = fileUri('target-completion.cmake');
        const diagPromise = waitForDiagnostics(uri);
        openDocument(uri, 'target_link_libraries(root )');
        await diagPromise;

        const completions = await getCompletions(uri, 0, 24);
        const items = (completions as CompletionList | CompletionItem[] | null);
        const list = Array.isArray(items) ? items : items?.items || [];
        const labels = list.map(i => i.label);

        assert.ok(labels.includes('root_lib'), 'Missing root_lib from indexed targets');
        assert.ok(labels.includes('src_lib'), 'Missing src_lib from indexed targets');
    });

    test('should update symbols when completion arrives before debounced diagnostics', async () => {
        const defsUri = fileUri('interactive-targets.cmake');
        const initialDiagnostics = waitForDiagnostics(defsUri);
        openDocument(defsUri, [
            'add_library(stale_before_edit INTERFACE)',
            'target_link_libraries(app interactive_)',
        ].join('\n'));
        await initialDiagnostics;

        const updatedDiagnostics = waitForDiagnostics(defsUri);
        docVersion++;
        connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: defsUri, version: docVersion },
            contentChanges: [{
                text: [
                    'add_library(interactive_after_edit INTERFACE)',
                    'target_link_libraries(app interactive_)',
                ].join('\n')
            }],
        });

        const completions = await getCompletions(defsUri, 1, 'target_link_libraries(app interactive_'.length);
        const items = (completions as CompletionList | CompletionItem[] | null);
        const labels = (Array.isArray(items) ? items : items?.items ?? []).map(item => item.label);

        assert.ok(labels.includes('interactive_after_edit'), 'Missing target from the current document revision');
        assert.ok(!labels.includes('stale_before_edit'), 'Stale target should be removed immediately after an edit');
        await updatedDiagnostics;
    });

    test('should rebuild cross-file dependencies after an included file changes', async () => {
        const rootUri = fileUri('CMakeLists.txt');
        const firstUri = fileUri('dynamic-first.cmake');
        const secondUri = fileUri('dynamic-second.cmake');
        const routerUri = fileUri('dynamic-router.cmake');

        for (const [uri, content] of [
            [firstUri, 'set(DYNAMIC_VAR first)'],
            [secondUri, 'set(DYNAMIC_VAR second)'],
            [routerUri, 'include(dynamic-first.cmake)'],
        ] as const) {
            const diagnostics = waitForDiagnostics(uri);
            openDocument(uri, content);
            await diagnostics;
        }

        const rootDiagnostics = waitForDiagnostics(rootUri);
        docVersion++;
        connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: rootUri, version: docVersion },
            contentChanges: [{ text: 'include(dynamic-router.cmake)\nmessage(${DYNAMIC_VAR})\n' }],
        });
        await rootDiagnostics;

        const initial = await getDefinition(rootUri, 1, 'message(${DYNAMIC_'.length);
        const initialLocations = (Array.isArray(initial) ? initial : [initial]) as Location[];
        assert.strictEqual(initialLocations[0]?.uri, firstUri);

        const routerDiagnostics = waitForDiagnostics(routerUri);
        docVersion++;
        connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri: routerUri, version: docVersion },
            contentChanges: [{ text: 'include(dynamic-second.cmake)' }],
        });

        const updated = await getDefinition(rootUri, 1, 'message(${DYNAMIC_'.length);
        const updatedLocations = (Array.isArray(updated) ? updated : [updated]) as Location[];
        assert.strictEqual(updatedLocations[0]?.uri, secondUri);
        await routerDiagnostics;
    });

    test('should rebuild only the affected project when a parent variable changes a child dependency', async () => {
        const entryUri = fileUri('dynamic-variable-entry.cmake');
        const routerUri = fileUri('dynamic-variable-router.cmake');
        const firstUri = fileUri('dynamic-variable-first.cmake');
        const secondUri = fileUri('dynamic-variable-second.cmake');
        const files = new Map([
            [entryUri, [
                'set(DYNAMIC_ROUTE_FILE dynamic-variable-first.cmake)',
                'include(dynamic-variable-router.cmake)',
                'message(${DYNAMIC_ROUTED_VALUE})',
            ].join('\n')],
            [routerUri, 'include(${DYNAMIC_ROUTE_FILE})'],
            [firstUri, 'set(DYNAMIC_ROUTED_VALUE first)'],
            [secondUri, 'set(DYNAMIC_ROUTED_VALUE second)'],
        ]);

        for (const [uri, content] of files) {
            fs.writeFileSync(URI.parse(uri).fsPath, content, 'utf8');
        }

        try {
            for (const [uri, content] of files) {
                const diagnostics = waitForDiagnostics(uri);
                openDocument(uri, content);
                await diagnostics;
            }

            const initial = await getDefinition(entryUri, 2, 'message(${DYNAMIC_ROUTED_'.length);
            const initialLocations = (Array.isArray(initial) ? initial : [initial]) as Location[];
            assert.strictEqual(initialLocations[0]?.uri, firstUri);

            const updatedDiagnostics = waitForDiagnostics(entryUri);
            docVersion++;
            connection.sendNotification(DidChangeTextDocumentNotification.type, {
                textDocument: { uri: entryUri, version: docVersion },
                contentChanges: [{
                    text: [
                        'set(DYNAMIC_ROUTE_FILE dynamic-variable-second.cmake)',
                        'include(dynamic-variable-router.cmake)',
                        'message(${DYNAMIC_ROUTED_VALUE})',
                    ].join('\n'),
                }],
            });
            await updatedDiagnostics;

            const deadline = Date.now() + 5000;
            let updatedUri: string | undefined;
            while (Date.now() < deadline) {
                const updated = await getDefinition(entryUri, 2, 'message(${DYNAMIC_ROUTED_'.length);
                const updatedLocations = (Array.isArray(updated) ? updated : [updated]) as Location[];
                updatedUri = updatedLocations[0]?.uri;
                if (updatedUri === secondUri) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.strictEqual(updatedUri, secondUri);
        } finally {
            for (const uri of files.keys()) {
                fs.rmSync(URI.parse(uri).fsPath, { force: true });
            }
        }
    });

});
