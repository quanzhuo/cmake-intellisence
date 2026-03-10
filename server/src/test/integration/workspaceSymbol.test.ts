import * as assert from "assert";
import * as cp from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
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
    SymbolInformation,
    SymbolKind,
    WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";
import { ExtensionSettings } from "../../cmakeInfo";

suite("Workspace Symbol Integration Tests", () => {
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

    async function getWorkspaceSymbols(query: string) {
        return connection.sendRequest(WorkspaceSymbolRequest.type, { query });
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
            workspaceFolders: [{ uri: fixtureUri, name: "workspace-symbol-test" }]
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

    test("should find workspace symbols by full name", async function () {
        await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");

        let result = await getWorkspaceSymbols("my_custom_macro") as SymbolInformation[];
        assert.ok(result && result.length > 0, "Should find my_custom_macro");
        assert.ok(result.some(s => s.name === "my_custom_macro" && s.kind === SymbolKind.Function), "Should be mapped as function");

        let vars = await getWorkspaceSymbols("MY_VAR") as SymbolInformation[];
        // MY_VAR is defined multiple times across multiple files
        assert.ok(vars.length >= 2, "Should find multiple definitions of MY_VAR");
        assert.ok(vars.every(s => s.name === "MY_VAR" && s.kind === SymbolKind.Variable), "Should be mapped as Variable");
    });

    test("should find workspace symbols by partial match", async function () {
        await openFixture("CMakeLists.txt");

        let result = await getWorkspaceSymbols("custom_macro") as SymbolInformation[];
        assert.ok(result && result.length > 0, "Should find by partial match");
        assert.ok(result.some(s => s.name === "my_custom_macro"));

        let vars = await getWorkspaceSymbols("COMPLEX") as SymbolInformation[];
        assert.ok(vars.length > 0, "Should find partial variables (COMPLEX_VAR)");
    });

    test("should return everything if query is empty", async function () {
        await openFixture("CMakeLists.txt");

        let result = await getWorkspaceSymbols("") as SymbolInformation[];
        assert.ok(result.length > 5, "Should return everything when query is empty");
    });
});

