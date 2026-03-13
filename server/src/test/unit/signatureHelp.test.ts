import * as assert from 'assert';
import { buildSignatureHelp, buildSignatureHelpForInvocation, createSignatureInformation, findActiveArgumentIndex, findActiveSignature } from '../../signatureHelp';
import { extractFlatCommands } from '../../flatCommands';
import { getFileContext } from '../../utils';

suite('Signature Help Tests', () => {
    test('createSignatureInformation should expose parameter ranges and markdown docs', () => {
        const signature = createSignatureInformation('add_subdirectory(source_dir [binary_dir] [EXCLUDE_FROM_ALL] [SYSTEM])');

        assert(signature.parameters !== undefined, 'Parameters should be present');
        assert((signature.parameters?.length ?? 0) >= 4, 'Parameters should include the main argument tokens');
        assert(typeof signature.documentation !== 'string', 'Documentation should be markup content');
        assert((signature.documentation as { value: string }).value.includes('```cmdsignature'), 'Documentation should render as a cmdsignature fenced block');
    });

    test('findActiveArgumentIndex should track the current argument', () => {
        const command = extractFlatCommands(getFileContext('add_test(NAME my_test COMMAND my_cmd arg1 arg2)'))[0];

        const commandIndex = findActiveArgumentIndex(command, { line: 0, character: 'add_test(NAME my_test COMMAND '.length + 2 });
        const lastArgIndex = findActiveArgumentIndex(command, { line: 0, character: 'add_test(NAME my_test COMMAND my_cmd arg1 arg2'.length });

        assert.strictEqual(commandIndex, 3);
        assert.strictEqual(lastArgIndex, 5);
    });

    test('findActiveSignature should prefer the overload matching present keywords', () => {
        const command = extractFlatCommands(getFileContext('add_library(foo OBJECT bar.cpp)'))[0];
        const signatures = [
            'add_library(<name> [STATIC | SHARED | MODULE] [EXCLUDE_FROM_ALL] [<source>...])',
            'add_library(<name> OBJECT [<source>...])',
            'add_library(<name> INTERFACE [<source>...] [EXCLUDE_FROM_ALL])'
        ];

        const active = findActiveSignature(command, signatures, 1);
        assert.strictEqual(active, 1);
    });

    test('buildSignatureHelp should compute active signature and parameter', () => {
        const commands = extractFlatCommands(getFileContext('add_library(foo OBJECT bar.cpp)'));
        const command = commands[0];
        const result = buildSignatureHelp(command, { line: 0, character: 'add_library(foo OBJECT '.length + 2 }, commands);

        assert(result !== null, 'Signature help should not be null');
        assert.strictEqual(result!.activeSignature, 1, 'Should select the OBJECT overload');
        assert.strictEqual(result!.activeParameter, 2, 'Should highlight the current source argument token');
        assert((result!.signatures[result!.activeSignature].documentation as { value: string }).value.includes('```cmdsignature'));
    });

    test('buildSignatureHelpForInvocation should support incomplete commands', () => {
        const result = buildSignatureHelpForInvocation('project', [], 0);

        assert(result !== null, 'Signature help should not be null for recovered commands');
        assert(result!.signatures.length > 0, 'Recovered commands should still expose builtin signatures');
        assert.strictEqual(result!.activeParameter, 0);
    });
});