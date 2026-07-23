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
import { ExtensionSettings } from "../../cmakeEnvironment";
import { createConfigurationResponse, waitForServerReady } from './testUtils';

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
        loggingLevel: "off",
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
        const readyPromise = waitForServerReady(connection);

        connection.onRequest(RegistrationRequest.type, () => { });
        connection.onRequest("workspace/configuration", () => {
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
            locale: "en",
            workspaceFolders: [{ uri: fixtureUri, name: "rename-test" }]
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

    test("rename should not modify equal text or shadowing function parameters", async function () {
        const uri = await openFixture("semantic-variables.cmake");
        const result = await renameSymbol(uri, 0, 6, "RENAMED_NAME") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri], "Should return edits for the global variable");
        const changedLines = result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b);
        assert.deepStrictEqual(changedLines, [0, 1, 4]);
        assert.strictEqual(result.changes![uri].find(edit => edit.range.start.line === 4)?.range.start.character, 2, "Multiline edits should use the exact line and column");
    });

    test("rename of a function parameter should stay inside its lexical scope", async function () {
        const uri = await openFixture("semantic-variables.cmake");
        const result = await renameSymbol(uri, 6, 18, "FIRST_NAME") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri]);
        assert.deepStrictEqual(result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b), [6, 7]);
    });

    test("rename of a cache variable should not edit a shadowing ordinary variable", async function () {
        const uri = await openFixture("cache-variables.cmake");
        const result = await renameSymbol(uri, 0, 9, "RENAMED_CACHE_FLAG") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri]);
        assert.deepStrictEqual(result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b), [0, 1, 4]);
    });

    test("rename should treat PARENT_SCOPE writes as references to the parent variable", async function () {
        const uri = await openFixture("parent-scope-variables.cmake");
        const result = await renameSymbol(uri, 0, 6, "RENAMED_PARENT") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri]);
        assert.deepStrictEqual(result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b), [0, 3, 6]);
    });

    test("rename should follow the latest unconditional command declaration", async function () {
        const uri = await openFixture("ordered-command.cmake");
        const result = await renameSymbol(uri, 4, 4, "renamed_command") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri]);
        assert.deepStrictEqual(result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b), [2, 4]);
    });

    test("rename should reject conditionally ambiguous command declarations", async function () {
        const uri = await openFixture("conditional-command.cmake");
        const result = await renameSymbol(uri, 7, 4, "renamed_command");

        assert.strictEqual(result, null);
    });

    test("rename should reject command bindings that depend on executing a function body", async function () {
        const uri = await openFixture("deferred-command.cmake");
        const result = await renameSymbol(uri, 6, 5, "renamed_deferred_command");

        assert.strictEqual(result, null);
    });

    test("rename should include a command invocation recovered from an incomplete parse", async function () {
        const uri = await openFixture("incomplete-command.cmake");
        const result = await renameSymbol(uri, 2, 5, "renamed_recovered") as WorkspaceEdit;

        assert.ok(result?.changes?.[uri]);
        assert.deepStrictEqual(result.changes![uri].map(edit => edit.range.start.line).sort((a, b) => a - b), [0, 2]);
    });

    test("rename should include unopened indexed files", async function () {
        const uri = await openFixture("CMakeLists.txt");

        const result = await renameSymbol(uri, 3, 5, "RENAMED_VAR") as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");

        const utilsUri = fileUri("utils.cmake");
        const utilsChanges = result.changes![utilsUri];
        assert.ok(utilsChanges && utilsChanges.length > 0, "Should modify indexed utils.cmake without opening it");
        assert.ok(utilsChanges.some(c => c.range.start.line === 0), "Should include overwrite in utils.cmake line 1");
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

    test("rename should ignore cached files outside the reachable entry tree", async function () {
        const uri = await openFixture("CMakeLists.txt");
        await openFixture("utils.cmake");
        const unrelatedUri = await openFixture("unrelated.cmake");

        const result = await renameSymbol(uri, 3, 5, "RENAMED_VAR") as WorkspaceEdit;
        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");
        assert.ok(!result.changes![unrelatedUri], "Should not rename occurrences in unrelated cached file");
    });

    test("rename a builtin command should return null", async function () {
        const uri = await openFixture("CMakeLists.txt");

        // request rename on line 0 `cmake_minimum_required`
        let result = await renameSymbol(uri, 0, 5, "should_fail") as WorkspaceEdit;
        assert.strictEqual(result, null, "Should not allow renaming builtin commands");
    });

    test("rename a target across target-aware argument positions", async function () {
        const uri = await openFixture("targets.cmake");
        const newName = "core_runtime";

        const result = await renameSymbol(uri, 0, 13, newName) as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");
        const changes = result.changes![uri];
        assert.ok(changes && changes.length > 0, "Should modify targets.cmake");
        assert.ok(changes.every(change => change.newText === newName), "All text edits should use the new target name");
        assert.ok(changes.some(change => change.range.start.line === 0), "Should rename target declaration");
        assert.ok(changes.some(change => change.range.start.line === 2), "Should rename target_link_libraries usage");
        assert.ok(changes.some(change => change.range.start.line === 3), "Should rename if(TARGET ...) usage");
        assert.ok(changes.some(change => change.range.start.line === 6), "Should rename get_target_property(... LOCATION) target usage");
    });

    test("rename an alias target across target-aware argument positions", async function () {
        const uri = await openFixture("advanced-targets.cmake");
        const lines = fs.readFileSync(path.join(fixtureDir, "advanced-targets.cmake"), "utf8").split(/\r?\n/);
        const newName = "core_public";

        const result = await renameSymbol(uri, 1, lines[1].indexOf("core_alias") + 1, newName) as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");
        const changes = result.changes![uri];
        assert.ok(changes && changes.length > 0, "Should modify advanced-targets.cmake");
        assert.ok(changes.every(change => change.newText === newName), "All text edits should use the new alias target name");
        assert.ok(changes.some(change => change.range.start.line === 1), "Should rename alias declaration");
        assert.ok(changes.some(change => change.range.start.line === 4), "Should rename target_link_libraries usage");
        assert.ok(changes.some(change => change.range.start.line === 5), "Should rename if(TARGET ...) usage");
        assert.ok(changes.some(change => change.range.start.line === 11), "Should rename get_target_property target usage");
    });

    test("rename a target referenced from generator expressions should ignore shadowing variables", async function () {
        const uri = await openFixture("genex-targets.cmake");
        const lines = fs.readFileSync(path.join(fixtureDir, "genex-targets.cmake"), "utf8").split(/\r?\n/);
        const newName = "core_runtime";

        const result = await renameSymbol(uri, 3, lines[3].indexOf("core") + 1, newName) as WorkspaceEdit;

        assert.ok(result && result.changes, "Should return WorkspaceEdit with changes");
        const changes = result.changes![uri];
        assert.ok(changes && changes.length > 0, "Should modify genex-targets.cmake");
        assert.ok(changes.every(change => change.newText === newName), "All text edits should use the new target name");
        assert.ok(changes.some(change => change.range.start.line === 0), "Should rename the target declaration");
        assert.ok(changes.some(change => change.range.start.line === 3), "Should rename the TARGET_FILE operand");
        assert.ok(changes.some(change => change.range.start.line === 4), "Should rename the TARGET_PROPERTY target operand");
        assert.ok(!changes.some(change => change.range.start.line === 2), "Should not rename the shadowing set() variable");
        assert.ok(!changes.some(change => change.range.start.line === 5), "Should not rename the shadowing variable expansion");
    });

});

