import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { CommandCaseChecker } from '../../diagnostics';
import { FileApiRawSnapshot } from '../../fileApiSnapshot';
import { PathDiagnosticsProvider, DIAG_CODE_MISSING_FILE_PATH } from '../../pathDiagnostics';
import { parseCMakeText } from '../../utils';
import { FileSymbolCache, SymbolIndex } from '../../symbolIndex';

suite('Diagnostics Tests', () => {
    test('CommandCaseChecker should include builtin module commands from catalog', () => {
        const symbolIndex = new SymbolIndex();
        symbolIndex.setSystemCache(new FileSymbolCache('cmake-builtin://system'));
        symbolIndex.replaceBuiltinModuleCommandCatalog(['ColdStart_DoWork']);

        const commands = parseCMakeText('ColdStart_DoWork()').flatCommands;
        const checker = new CommandCaseChecker(symbolIndex);
        checker.check(commands);

        const diagnostics = checker.getCmdCaseDiagnostics();
        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].range.start.line, 0);
        assert.strictEqual(diagnostics[0].range.start.character, 0);
    });

    test('CommandCaseChecker should not flag lowercase builtin module commands', () => {
        const symbolIndex = new SymbolIndex();
        symbolIndex.setSystemCache(new FileSymbolCache('cmake-builtin://system'));
        symbolIndex.replaceBuiltinModuleCommandCatalog(['coldstart_dowork']);

        const commands = parseCMakeText('coldstart_dowork()').flatCommands;
        const checker = new CommandCaseChecker(symbolIndex);
        checker.check(commands);

        assert.deepStrictEqual(checker.getCmdCaseDiagnostics(), []);
    });

    test('PathDiagnosticsProvider should suppress include missing-file warnings for File API known inputs', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-diagnostics-file-api-'));
        const sourcePath = path.join(workspaceDir, 'CMakeLists.txt');
        const knownInputPath = path.join(workspaceDir, 'missing', 'generated-include.cmake');
        const sourceUri = URI.file(sourcePath);
        const commands = parseCMakeText('include(missing/generated-include.cmake)\n').flatCommands;
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(workspaceDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [
                {
                    path: knownInputPath,
                    isGenerated: true,
                },
            ],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.writeFileSync(sourcePath, 'include(missing/generated-include.cmake)\n', 'utf8');

            const withoutFileApiProvider = new PathDiagnosticsProvider({
                symbolIndex: new SymbolIndex(),
                entryFile: sourceUri,
                sourceUri,
                getFlatCommands: async () => commands,
            });
            const baselineDiagnostics = await withoutFileApiProvider.getDiagnostics(commands);
            assert.strictEqual(baselineDiagnostics.length, 1);
            assert.strictEqual(String(baselineDiagnostics[0].code), DIAG_CODE_MISSING_FILE_PATH);

            const withFileApiProvider = new PathDiagnosticsProvider({
                symbolIndex: new SymbolIndex(),
                entryFile: sourceUri,
                sourceUri,
                getFlatCommands: async () => commands,
                fileApiRawSnapshot,
            });
            const diagnostics = await withFileApiProvider.getDiagnostics(commands);
            assert.deepStrictEqual(diagnostics, []);
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('PathDiagnosticsProvider should suppress generated source warnings from File API target snapshots', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-diagnostics-generated-source-'));
        const sourcePath = path.join(workspaceDir, 'CMakeLists.txt');
        const generatedSourcePath = path.join(workspaceDir, 'missing', 'generated.cpp');
        const sourceUri = URI.file(sourcePath);
        const commands = parseCMakeText('add_library(test_lib STATIC missing/generated.cpp)\n').flatCommands;
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(workspaceDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {
                test_lib: {
                    id: 'test_lib::id',
                    name: 'test_lib',
                    sourceDirectory: workspaceDir,
                    generatedSourcePaths: ['missing/generated.cpp'],
                },
            },
            targetsById: {},
        };

        try {
            fs.writeFileSync(sourcePath, 'add_library(test_lib STATIC missing/generated.cpp)\n', 'utf8');

            const withoutFileApiProvider = new PathDiagnosticsProvider({
                symbolIndex: new SymbolIndex(),
                entryFile: sourceUri,
                sourceUri,
                getFlatCommands: async () => commands,
            });
            const baselineDiagnostics = await withoutFileApiProvider.getDiagnostics(commands);
            assert.strictEqual(baselineDiagnostics.length, 1);
            assert.strictEqual(String(baselineDiagnostics[0].code), DIAG_CODE_MISSING_FILE_PATH);

            const withFileApiProvider = new PathDiagnosticsProvider({
                symbolIndex: new SymbolIndex(),
                entryFile: sourceUri,
                sourceUri,
                getFlatCommands: async () => commands,
                fileApiRawSnapshot,
            });
            const diagnostics = await withFileApiProvider.getDiagnostics(commands);
            assert.deepStrictEqual(diagnostics, []);
            assert.strictEqual(path.resolve(workspaceDir, 'missing', 'generated.cpp'), generatedSourcePath);
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});
