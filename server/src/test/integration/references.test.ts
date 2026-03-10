import * as assert from "assert";
import * as cp from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { ExtensionSettings } from "../../cmakeInfo";
import {
    ReferencesRequest,
    DidOpenTextDocumentNotification,
    ExitNotification,
    InitializeRequest,
    InitializeParams,
    InitializedNotification,
    IPCMessageReader,
    IPCMessageWriter,
    PublishDiagnosticsNotification,
    PublishDiagnosticsParams,
    RegistrationRequest,
    ShutdownRequest,
    ProtocolConnection,
    createProtocolConnection,
    Location,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

suite("References Integration Tests", () => {
    let connection: ProtocolConnection;
    let serverProcess: cp.ChildProcess;
    let docVersion = 0;
    const diagnosticEmitter = new EventEmitter();

    const fixtureDir = path.resolve(__dirname, "..", "..", "..", "src", "test", "integration", "fixtures", "references");
    const fixtureUri = URI.file(fixtureDir).toString();

    const extSettings: ExtensionSettings = {
        cmakePath: "cmake",
        pkgConfigPath: "",
        cmdCaseDiagnostics: false,
        loggingLevel: "off"
    };

    function fileUri(relativePath: string): string {
        return URI.file(path.join(fixtureDir, relativePath)).toString();
    }

    function openDocument(uri: string, content: string): void {
        docVersion++;
        connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: "cmake", version: docVersion, text: content }
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
        openDocument(uri, fs.readFileSync(abs, "utf-8"));
        await diagPromise;
        return uri;
    }

    async function getReferences(uri: string, line: number, character: number) {
        return connection.sendRequest(ReferencesRequest.type, {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true }
        });
    }

    suiteSetup(async function () {
        this.timeout(30000);

        const serverModule = path.resolve(__dirname, "..", "..", "server.js");
        serverProcess = cp.fork(serverModule, ["--node-ipc"], {
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        connection = createProtocolConnection(
            new IPCMessageReader(serverProcess),
            new IPCMessageWriter(serverProcess)
        );
        connection.listen();

        let configurationRequested: () => void;
        const configurationPromise = new Promise<void>(r => { configurationRequested = r; });

        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest("workspace/configuration", () => {
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
            locale: "en",
            workspaceFolders: [{ uri: fixtureUri, name: "ref-test" }]
        };

        await connection.sendRequest(InitializeRequest.type, initParams);
        connection.sendNotification(InitializedNotification.type, {});
        await configurationPromise;
        await new Promise(r => setTimeout(r, 3000));
    });

    suiteTeardown(async function () {
        if (connection) {
            await connection.sendRequest(ShutdownRequest.type);
            connection.sendNotification(ExitNotification.type);
            connection.dispose();
        }
        if (serverProcess) { serverProcess.kill(); }
    });

    test("find references of a local variable (MY_VAR)", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");
        // query from `set(MY_VAR "test_value")`
        let result = await getReferences(uri, 3, 5);
        let locs = (Array.isArray(result) ? result : [result]) as Location[];
        
        assert.ok(locs && locs.length > 0, "Should find references");
        
        // Assertions for CMakeLists.txt
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 3), "Definition on line 4");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 4), "Usage inside set() on line 5");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 5), "Usage inside message() string on line 6");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 9), "Usage inside function message() on line 10");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 17), "Usage inside complex string line 18");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 18 && l.range.start.character > 20), "Usage inside nested variable line 19");

        // Assertions for utils.cmake
        const utilsUri = fileUri("utils.cmake");
        assert.ok(locs.some(l => l.uri === utilsUri && l.range.start.line === 0), "Overwritten in utils.cmake line 1");
        assert.ok(locs.some(l => l.uri === utilsUri && l.range.start.line === 1), "Usage in utils.cmake message on line 2");
    });

    test("find references of a custom macro/function (my_custom_macro)", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");
        
        // cursor on `function(my_custom_macro arg1)`
        let result = await getReferences(uri, 7, 10);
        let locs = (Array.isArray(result) ? result : [result]) as Location[];
        
        assert.ok(locs && locs.length > 0, "Should find references for macro");

        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 7), "Definition in CMakeLists.txt line 8");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 12), "Usage in CMakeLists.txt line 13");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 15), "Usage in CMakeLists.txt line 16");

        const utilsUri = fileUri("utils.cmake");
        assert.ok(locs.some(l => l.uri === utilsUri && l.range.start.line === 3), "Usage in utils.cmake line 4");
    });

    test("find references of a macro/function ignoring casing (MY_CUSTOM_MACRO)", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");
        
        // request on the uppercase (CMake is case-insensitive for commands) - we just pick the lowercase which will get normalized
        let result = await getReferences(uri, 12, 5); 
        let locs = (Array.isArray(result) ? result : [result]) as Location[];

        // we should get the exact same results as the previous test
        assert.ok(locs && locs.length > 0, "Should find references regardless of where we click");
        assert.ok(locs.some(l => l.uri === uri && l.range.start.line === 7), "Should still map back to definition");
    });

});

