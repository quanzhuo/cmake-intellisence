import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { PathExpressionResolver } from '../../pathExpressionResolver';
import { SymbolIndex } from '../../symbolIndex';
import { parseCMakeText } from '../../utils';

suite('Path Expression Resolver Tests', () => {
    const normalizeForComparison = (value: string | null) => path.normalize(value ?? '').toLowerCase();

    test('expandPathVariables should resolve builtin directory variables', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-builtins-'));
        const entryFile = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const currentFile = URI.file(path.join(workspaceDir, 'sub', 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile,
        });

        try {
            fs.mkdirSync(path.dirname(currentFile.fsPath), { recursive: true });
            const expanded = await resolver.expandPathVariables('${CMAKE_CURRENT_LIST_DIR}/include/helpers.cmake', currentFile, 0);
            assert.strictEqual(
                normalizeForComparison(expanded),
                normalizeForComparison(path.join(path.dirname(currentFile.fsPath), 'include', 'helpers.cmake')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariables should resolve current-source and source-root builtin directory variables', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-source-builtins-'));
        const entryFile = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const currentFile = URI.file(path.join(workspaceDir, 'sub', 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile,
        });

        try {
            fs.mkdirSync(path.dirname(currentFile.fsPath), { recursive: true });

            const currentSourceExpanded = await resolver.expandPathVariables('${CMAKE_CURRENT_SOURCE_DIR}/include/helpers.cmake', currentFile, 0);
            const sourceDirExpanded = await resolver.expandPathVariables('${CMAKE_SOURCE_DIR}/include/helpers.cmake', currentFile, 0);
            const projectSourceExpanded = await resolver.expandPathVariables('${PROJECT_SOURCE_DIR}/include/helpers.cmake', currentFile, 0);

            assert.strictEqual(
                normalizeForComparison(currentSourceExpanded),
                normalizeForComparison(path.join(path.dirname(currentFile.fsPath), 'include', 'helpers.cmake')),
            );
            assert.strictEqual(
                normalizeForComparison(sourceDirExpanded),
                normalizeForComparison(path.join(workspaceDir, 'include', 'helpers.cmake')),
            );
            assert.strictEqual(
                normalizeForComparison(projectSourceExpanded),
                normalizeForComparison(path.join(workspaceDir, 'include', 'helpers.cmake')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariables should resolve CMAKE_BINARY_DIR from the active build directory', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-binary-root-'));
        const buildDir = path.join(workspaceDir, 'out', 'build');
        const entryFile = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const currentFile = URI.file(path.join(workspaceDir, 'sub', 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile,
            buildDirectory: buildDir,
        });

        try {
            fs.mkdirSync(path.dirname(currentFile.fsPath), { recursive: true });

            const expanded = await resolver.expandPathVariables('${CMAKE_BINARY_DIR}/generated/config.h', currentFile, 0);
            assert.strictEqual(
                normalizeForComparison(expanded),
                normalizeForComparison(path.join(buildDir, 'generated', 'config.h')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariables should resolve PROJECT_BINARY_DIR from the active build directory', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-project-binary-root-'));
        const buildDir = path.join(workspaceDir, 'out', 'build');
        const entryFile = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const currentFile = URI.file(path.join(workspaceDir, 'sub', 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile,
            buildDirectory: buildDir,
        });

        try {
            fs.mkdirSync(path.dirname(currentFile.fsPath), { recursive: true });

            const expanded = await resolver.expandPathVariables('${PROJECT_BINARY_DIR}/generated/config.h', currentFile, 0);
            assert.strictEqual(
                normalizeForComparison(expanded),
                normalizeForComparison(path.join(buildDir, 'generated', 'config.h')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariables should resolve CMAKE_CURRENT_BINARY_DIR from File API directory mappings', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-current-binary-'));
        const buildDir = path.join(workspaceDir, 'out', 'build');
        const entryFile = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const currentFile = URI.file(path.join(workspaceDir, 'sub', 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile,
            buildDirectory: buildDir,
            buildDirectoriesBySourcePath: {
                [path.join(workspaceDir, 'sub').toLowerCase()]: path.join(buildDir, 'sub-build'),
            },
        });

        try {
            fs.mkdirSync(path.dirname(currentFile.fsPath), { recursive: true });

            const expanded = await resolver.expandPathVariables('${CMAKE_CURRENT_BINARY_DIR}/generated/config.h', currentFile, 0);
            assert.strictEqual(
                normalizeForComparison(expanded),
                normalizeForComparison(path.join(buildDir, 'sub-build', 'generated', 'config.h')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariables should resolve chained simple set variables from the same file', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-vars-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const commands = parseCMakeText([
            'set(HELPER_DIR ${CMAKE_CURRENT_LIST_DIR}/include)',
            'set(HELPER_FILE ${HELPER_DIR}/helpers.cmake)',
            'include(${HELPER_FILE})',
        ].join('\n')).flatCommands;

        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => commands,
            entryFile: fileUri,
        });

        try {
            const expanded = await resolver.expandPathVariables('${HELPER_FILE}', fileUri, 2);
            assert.strictEqual(
                normalizeForComparison(expanded),
                normalizeForComparison(path.join(workspaceDir, 'include', 'helpers.cmake')),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileExpression should resolve an existing file after variable expansion', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-file-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const includeDir = path.join(workspaceDir, 'include');
        const includeFile = path.join(includeDir, 'helpers.cmake');
        const commands = parseCMakeText([
            'set(HELPER_DIR ${CMAKE_CURRENT_LIST_DIR}/include)',
            'set(HELPER_FILE ${HELPER_DIR}/helpers.cmake)',
        ].join('\n')).flatCommands;

        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => commands,
            entryFile: fileUri,
        });

        try {
            fs.mkdirSync(includeDir, { recursive: true });
            fs.writeFileSync(includeFile, '# helper', 'utf8');

            const resolved = await resolver.resolveFileExpression('${HELPER_FILE}', fileUri, 1);
            assert.strictEqual(resolved?.toString(), URI.file(includeFile).toString());
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileExpression should resolve an existing file when the path argument is quoted', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-file-quoted-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const includeDir = path.join(workspaceDir, 'include');
        const includeFile = path.join(includeDir, 'helpers.cmake');
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            fs.mkdirSync(includeDir, { recursive: true });
            fs.writeFileSync(includeFile, '# helper', 'utf8');

            const resolved = await resolver.resolveFileExpression('"include/helpers.cmake"', fileUri, 0);
            assert.strictEqual(resolved?.toString(), URI.file(includeFile).toString());
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathExpression should normalize quoted directory arguments', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-dir-quoted-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            const expanded = await resolver.expandPathExpression({
                commandName: 'add_subdirectory',
                argText: '"subdir"',
                sourceUri: fileUri,
                maxLine: 0,
            });

            assert.strictEqual(expanded, path.normalize('subdir'));
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariablesDetailed should report unresolved variables', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-unresolved-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            const result = await resolver.expandPathVariablesDetailed('${MISSING_VAR}/helper.cmake', fileUri, 0);
            assert.strictEqual(result.expandedPath, null);
            assert.deepStrictEqual(result.unresolvedVariables, ['MISSING_VAR']);
            assert.strictEqual(result.reason, 'unresolved-variable');
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileExpressionDetailed should expose best-effort candidates for missing files', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-best-effort-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            const result = await resolver.resolveFileExpressionDetailed('include/missing.cmake', fileUri, 0);
            assert.strictEqual(result.reason, 'missing-file');
            assert.strictEqual(result.exactCandidates.length, 0);
            assert.strictEqual(result.bestEffortCandidates[0]?.toString(), URI.file(path.join(workspaceDir, 'include', 'missing.cmake')).toString());
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileExpressionDetailed should expose bounded best-effort candidates for unresolved variables', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-unresolved-best-effort-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            const result = await resolver.resolveFileExpressionDetailed('include/${MISSING_VAR}/helper.cmake', fileUri, 0);
            assert.strictEqual(result.reason, 'unresolved-variable');
            assert.deepStrictEqual(result.unresolvedVariables, ['MISSING_VAR']);
            assert.strictEqual(result.exactCandidates.length, 0);
            assert.strictEqual(result.bestEffortCandidates.length, 1);
            assert.strictEqual(result.bestEffortCandidates[0]?.toString(), URI.file(path.join(workspaceDir, 'include', 'helper.cmake')).toString());
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileRequestDetailed should accept explicit request context objects', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-request-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const includeDir = path.join(workspaceDir, 'include');
        const includeFile = path.join(includeDir, 'helpers.cmake');
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        try {
            fs.mkdirSync(includeDir, { recursive: true });
            fs.writeFileSync(includeFile, '# helper', 'utf8');

            const result = await resolver.resolveFileRequestDetailed({
                commandName: 'include',
                argText: 'include/helpers.cmake',
                sourceUri: fileUri,
                maxLine: 0,
            });

            assert.strictEqual(result.reason, 'resolved');
            assert.strictEqual(result.exactCandidates[0]?.toString(), URI.file(includeFile).toString());
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('expandPathVariablesDetailed should leave list-style set values unresolved', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-complex-set-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const commands = parseCMakeText([
            'set(HELPER_FILE include/helpers.cmake;include/extra.cmake)',
            'include(${HELPER_FILE})',
        ].join('\n')).flatCommands;

        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => commands,
            entryFile: fileUri,
        });

        try {
            const result = await resolver.expandPathVariablesDetailed('${HELPER_FILE}', fileUri, 1);
            assert.strictEqual(result.expandedPath, null);
            assert.deepStrictEqual(result.unresolvedVariables, ['HELPER_FILE']);
            assert.strictEqual(result.reason, 'unresolved-variable');
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveFileRequestDetailed should cache repeated request evaluations within one resolver instance', async () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-request-cache-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const includeDir = path.join(workspaceDir, 'include');
        const includeFile = path.join(includeDir, 'helpers.cmake');
        const commands = parseCMakeText([
            'set(HELPER_DIR ${CMAKE_CURRENT_LIST_DIR}/include)',
            'set(HELPER_FILE ${HELPER_DIR}/helpers.cmake)',
            'include(${HELPER_FILE})',
        ].join('\n')).flatCommands;
        let loadCount = 0;

        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => {
                loadCount++;
                return commands;
            },
            entryFile: fileUri,
        });

        try {
            fs.mkdirSync(includeDir, { recursive: true });
            fs.writeFileSync(includeFile, '# helper', 'utf8');

            const request = {
                commandName: 'include',
                argText: '${HELPER_FILE}',
                sourceUri: fileUri,
                maxLine: 2,
            };

            const first = await resolver.resolveFileRequestDetailed(request);
            const loadCountAfterFirst = loadCount;
            const second = await resolver.resolveFileRequestDetailed(request);

            assert(loadCountAfterFirst > 0, 'The first resolution should load flat commands');
            assert.strictEqual(loadCount, loadCountAfterFirst, 'The second resolution should hit the request cache');
            assert.deepStrictEqual(
                second.exactCandidates.map(candidate => candidate.toString()),
                first.exactCandidates.map(candidate => candidate.toString()),
            );
        } finally {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    test('resolveExpandedFile should cache repeated filesystem probes within one resolver instance', () => {
        const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-path-stat-cache-'));
        const fileUri = URI.file(path.join(workspaceDir, 'CMakeLists.txt'));
        const includeDir = path.join(workspaceDir, 'include');
        const includeFile = path.join(includeDir, 'helpers.cmake');
        const resolver = new PathExpressionResolver({
            symbolIndex: new SymbolIndex(),
            getFlatCommands: async () => [],
            entryFile: fileUri,
        });

        const mutableFs = fs as unknown as {
            existsSync: (...args: unknown[]) => boolean;
            statSync: (...args: unknown[]) => fs.Stats;
        };
        const originalExistsSync = mutableFs.existsSync;
        const originalStatSync = mutableFs.statSync;
        let existsSyncCalls = 0;
        let statSyncCalls = 0;

        try {
            fs.mkdirSync(includeDir, { recursive: true });
            fs.writeFileSync(includeFile, '# helper', 'utf8');

            mutableFs.existsSync = ((...args: unknown[]) => {
                existsSyncCalls++;
                return originalExistsSync(...args);
            });
            mutableFs.statSync = ((...args: unknown[]) => {
                statSyncCalls++;
                return originalStatSync(...args);
            });

            const first = resolver.resolveExpandedFile('include/helpers.cmake', fileUri);
            const existsSyncCallsAfterFirst = existsSyncCalls;
            const statSyncCallsAfterFirst = statSyncCalls;
            const second = resolver.resolveExpandedFile('include/helpers.cmake', fileUri);

            assert(first, 'The first lookup should resolve the on-disk file');
            assert.strictEqual(second?.toString(), first?.toString());
            assert(existsSyncCallsAfterFirst > 0, 'The first lookup should probe the filesystem');
            assert(statSyncCallsAfterFirst > 0, 'The first lookup should stat the resolved file');
            assert.strictEqual(existsSyncCalls, existsSyncCallsAfterFirst, 'The second lookup should hit the resolved-file cache');
            assert.strictEqual(statSyncCalls, statSyncCallsAfterFirst, 'The second lookup should hit the resolved-file cache');
        } finally {
            mutableFs.existsSync = originalExistsSync;
            mutableFs.statSync = originalStatSync;
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});