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
    RenameRequest,
    ShutdownRequest,
    WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";
import { ExtensionSettings } from "../../cmakeInfo";

suite("Rename Integration Tests", () => {
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

    async function renameSymbol(uri: string, line: number, character: number, newName: string) {
        return connection.sendRequest(RenameRequest.type, {
            textDocument: { uri },
            position: { line, character },
            newName: newName
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
            workspaceFolders: [{ uri: fixtureUri, name: "rename-test" }]
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

    test("rename a local variable (MY_VAR)", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");

        // request rename on line 3 `set(MY_VAR "test_value")`
        const newName = "RENAMED_VAR";
        let result = await renameSymbol(uri, 3, 5, newName) as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");

        const mainChanges = result.changes![uri];
        assert.ok(mainChanges && mainChanges.length > 0, "Should modify CMakeLists.txt");

        // Ensure newText matches
        assert.ok(mainChanges.every(c => c.newText === newName), "All text edits should use the new name");
        assert.ok(mainChanges.some(c => c.range.start.line === 3), "Should edit definition on line 4");
        assert.ok(mainChanges.some(c => c.range.start.line === 5), "Should edit usage inside message on line 6");

        const utilsUri = fileUri("utils.cmake");
        const utilsChanges = result.changes![utilsUri];
        assert.ok(utilsChanges && utilsChanges.length > 0, "Should modify utils.cmake");
        assert.ok(utilsChanges.some(c => c.range.start.line === 0), "Should edit utils.cmake line 1");
    });

    test("rename a custom macro/function (my_custom_macro)", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");

        // request rename on line 7 `function(my_custom_macro arg1)`
        const newName = "new_macro_name";
        let result = await renameSymbol(uri, 7, 10, newName) as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");

        const mainChanges = result.changes![uri];
        assert.ok(mainChanges && mainChanges.length > 0, "Should modify CMakeLists.txt");
        assert.ok(mainChanges.every(c => c.newText === newName), "All text edits should use the new name");

        // Checking specific definition edit
        assert.ok(mainChanges.some(c => c.range.start.line === 7), "Should rename definition");
        assert.ok(mainChanges.some(c => c.range.start.line === 12), "Should rename usage");

        const utilsUri = fileUri("utils.cmake");
        const utilsChanges = result.changes![utilsUri];
        assert.ok(utilsChanges && utilsChanges.length > 0, "Should modify usage in utils.cmake");
        assert.ok(utilsChanges.some(c => c.range.start.line === 3), "Should update my_custom_macro usage in utils");
    });

    test("rename a builtin command should return null", async function () {
        const uri = await openFixture("CMakeLists.txt");

        // request rename on line 0 `cmake_minimum_required`
        let result = await renameSymbol(uri, 0, 5, "should_fail") as WorkspaceEdit;
        assert.strictEqual(result, null, "Should not allow renaming builtin commands");
    });

});

