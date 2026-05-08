import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { ProjectTargetInfoListener } from '../../cmakeEnvironment';
import { SymbolIndex } from '../../symbolIndex';
import { parseCMakeText } from '../../utils';

suite('CMake Environment Tests', () => {
    test('ProjectTargetInfoListener should ignore include directory arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-target-info-'));
        const vscodeDir = path.join(tempDir, '.vscode');
        fs.mkdirSync(vscodeDir);

        try {
            const source = 'include(.vscode/)';
            const parsed = parseCMakeText(source);
            let loadCount = 0;
            const listener = new ProjectTargetInfoListener(
                new SymbolIndex(),
                path.join(tempDir, 'CMakeLists.txt'),
                tempDir,
                async () => {
                    loadCount++;
                    throw new Error('loadFlatCommands should not be called for include directories');
                },
                new Set<string>(),
                tempDir,
            );

            await listener.processCommands(parsed.flatCommands);
            assert.strictEqual(loadCount, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('ProjectTargetInfoListener should resolve variable-expanded include files', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-target-info-vars-'));
        const mainFile = path.join(tempDir, 'CMakeLists.txt');
        const helperFile = path.join(tempDir, 'helper.cmake');

        try {
            fs.writeFileSync(helperFile, 'add_library(helper INTERFACE)\n', 'utf8');

            const source = [
                'set(HELPER_FILE ${CMAKE_CURRENT_LIST_DIR}/helper.cmake)',
                'include(${HELPER_FILE})',
            ].join('\n');
            const parsed = parseCMakeText(source);
            const helperUri = URI.file(helperFile).toString();
            const mainUri = URI.file(mainFile).toString();
            let loadCount = 0;
            const listener = new ProjectTargetInfoListener(
                new SymbolIndex(),
                mainUri,
                tempDir,
                async (uri) => {
                    loadCount++;
                    if (uri === mainUri) {
                        return parsed.flatCommands;
                    }

                    assert.strictEqual(uri, helperUri);
                    return parseCMakeText(fs.readFileSync(helperFile, 'utf8')).flatCommands;
                },
                new Set<string>(),
                tempDir,
            );

            await listener.processCommands(parsed.flatCommands);

            assert.strictEqual(loadCount, 2, 'loadFlatCommands should read the current file for variable resolution and then the expanded include file');
            assert(listener.targetInfo.libraries?.has('helper'), 'Included helper target should be discovered after variable expansion');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});