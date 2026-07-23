import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { extractSymbols } from '../../symbolExtractor';
import { SymbolIndex } from '../../symbolIndex';
import { parseCMakeText } from '../../utils';

suite('Symbol Extractor Tests', () => {
    test('extractSymbols should add an include dependency for variable-expanded include files', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-symbol-extractor-include-'));
        const mainUri = URI.file(path.join(tempDir, 'CMakeLists.txt')).toString();
        const helperPath = path.join(tempDir, 'helper.cmake');
        const helperUri = URI.file(helperPath).toString();
        const parsed = parseCMakeText([
            'set(HELPER_ROOT ${CMAKE_CURRENT_LIST_DIR})',
            'set(HELPER_FILE ${HELPER_ROOT}/helper.cmake)',
            'include(${HELPER_FILE})',
        ].join('\n'));

        try {
            fs.writeFileSync(helperPath, '# helper\n', 'utf8');

            const symbolIndex = new SymbolIndex();
            const cache = await extractSymbols(
                mainUri,
                parsed.flatCommands,
                URI.file(tempDir),
                symbolIndex,
                {
                    entryFile: mainUri,
                    getFlatCommands: async (uri) => {
                        assert.strictEqual(uri, mainUri);
                        return parsed.flatCommands;
                    },
                },
            );

            assert(cache.dependencies.some(dep => dep.uri === helperUri && dep.type === 'include'));
            symbolIndex.setCache(mainUri, cache, 'disk:1', mainUri);
            const dependencyInputs = symbolIndex.getProjectDependencyInputVariables(mainUri);
            assert(dependencyInputs.has('HELPER_FILE'));
            assert(dependencyInputs.has('HELPER_ROOT'));
            assert(dependencyInputs.has('CMAKE_MODULE_PATH'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('extractSymbols should add a subdirectory dependency for variable-expanded add_subdirectory arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-symbol-extractor-subdir-'));
        const mainUri = URI.file(path.join(tempDir, 'CMakeLists.txt')).toString();
        const childDir = path.join(tempDir, 'child');
        const childCMakePath = path.join(childDir, 'CMakeLists.txt');
        const childCMakeUri = URI.file(childCMakePath).toString();
        const parsed = parseCMakeText([
            'set(CHILD_DIR ${CMAKE_CURRENT_LIST_DIR}/child)',
            'add_subdirectory(${CHILD_DIR})',
        ].join('\n'));

        try {
            fs.mkdirSync(childDir, { recursive: true });
            fs.writeFileSync(childCMakePath, 'add_library(child INTERFACE)\n', 'utf8');

            const cache = await extractSymbols(
                mainUri,
                parsed.flatCommands,
                URI.file(tempDir),
                new SymbolIndex(),
                {
                    entryFile: mainUri,
                    getFlatCommands: async (uri) => {
                        assert.strictEqual(uri, mainUri);
                        return parsed.flatCommands;
                    },
                },
            );

            assert(cache.dependencies.some(dep => dep.uri === childCMakeUri && dep.type === 'subdirectory'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('extractSymbols should reuse a provided dependency structure analysis', async () => {
        const uri = URI.file(path.join(os.tmpdir(), 'provided-dependency-structure.cmake')).toString();
        const parsed = parseCMakeText('message(STATUS no-dependencies)');
        const cache = await extractSymbols(
            uri,
            parsed.flatCommands,
            URI.file(os.tmpdir()),
            new SymbolIndex(),
            {
                entryFile: uri,
                getFlatCommands: async () => parsed.flatCommands,
                dependencyStructure: {
                    directFingerprint: 'provided',
                    variableFingerprints: new Map(),
                    dependencyInputVariables: new Set(['PROVIDED_INPUT']),
                    variableReferences: new Map([
                        ['PROVIDED_INPUT', new Set(['PROVIDED_SOURCE'])],
                    ]),
                },
            },
        );

        assert(cache.dependencyInputVariables.has('PROVIDED_INPUT'));
        assert(cache.variableValueReferences.get('PROVIDED_INPUT')?.has('PROVIDED_SOURCE'));
    });
});
