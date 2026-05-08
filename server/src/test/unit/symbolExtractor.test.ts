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
            'set(HELPER_FILE ${CMAKE_CURRENT_LIST_DIR}/helper.cmake)',
            'include(${HELPER_FILE})',
        ].join('\n'));

        try {
            fs.writeFileSync(helperPath, '# helper\n', 'utf8');

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

            assert(cache.dependencies.some(dep => dep.uri === helperUri && dep.type === 'include'));
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
});