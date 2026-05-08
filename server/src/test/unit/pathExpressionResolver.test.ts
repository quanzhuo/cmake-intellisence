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
});