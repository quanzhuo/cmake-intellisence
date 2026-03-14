import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
});