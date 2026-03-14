import * as assert from 'assert';
import { CommandCaseChecker } from '../../diagnostics';
import { extractFlatCommands } from '../../flatCommands';
import { getFileContext } from '../../utils';
import { FileSymbolCache, SymbolIndex } from '../../symbolIndex';

suite('Diagnostics Tests', () => {
    test('CommandCaseChecker should include builtin module commands from catalog', () => {
        const symbolIndex = new SymbolIndex();
        symbolIndex.setSystemCache(new FileSymbolCache('cmake-builtin://system'));
        symbolIndex.replaceBuiltinModuleCommandCatalog(['ColdStart_DoWork']);

        const commands = extractFlatCommands(getFileContext('ColdStart_DoWork()'));
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

        const commands = extractFlatCommands(getFileContext('coldstart_dowork()'));
        const checker = new CommandCaseChecker(symbolIndex);
        checker.check(commands);

        assert.deepStrictEqual(checker.getCmdCaseDiagnostics(), []);
    });
});