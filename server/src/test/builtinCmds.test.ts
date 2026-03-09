import * as builtinCmds from '../builtin-cmds.json';
import * as assert from 'assert';
import { CMakeInfo } from '../cmakeInfo';
import { getCmdKeyWords } from '../utils';

type BuiltinCommand = {
    sig: string[];
    deprecated?: true;
    keyword?: string[];
    constant?: string[];
};

const commands: Record<string, BuiltinCommand> = builtinCmds as Record<string, BuiltinCommand>;

function asSortedSet(items: string[]): string[] {
    return Array.from(new Set(items)).sort();
}

suite('builtin-cmds.json tests', () => {
    test('all declared keywords should be unique', () => {
        Object.entries(commands).forEach(([name, command]) => {
            if (!command.keyword) {
                return;
            }
            const unique = asSortedSet(command.keyword);
            assert.strictEqual(unique.length, command.keyword.length, `Keyword of ${name} is not unique`);
        });
    });

    test('signature-derived keywords should match for deterministic commands', () => {
        const deterministicCommands = [
            'cmake_host_system_information',
            'find_file',
            'find_package',
            'find_program',
        ];

        deterministicCommands.forEach(name => {
            const command = commands[name];
            assert(command, `Command ${name} should exist in builtin-cmds.json`);
            assert(command.keyword, `Command ${name} should define keyword field`);

            const fromSig = asSortedSet(getCmdKeyWords(command.sig));
            const declared = asSortedSet(command.keyword as string[]);
            assert.deepStrictEqual(declared, fromSig, `Keyword mismatch for command ${name}`);
        });
    });

    test('builtin-cmds.json should include all commands discovered from CMake', async () => {
        const cmakeInfo = new CMakeInfo({
            cmakePath: 'cmake',
            pkgConfigPath: '',
            cmdCaseDiagnostics: false,
            loggingLevel: 'off'
        });
        await cmakeInfo.init();

        const builtinCommandSet = new Set(Object.keys(commands).map(command => command.toLowerCase()));
        const missing = Array.from(new Set(
            cmakeInfo.commands.filter(command => !builtinCommandSet.has(command.toLowerCase()))
        )).sort();

        assert.strictEqual(
            missing.length,
            0,
            `builtin-cmds.json is missing commands from CMake: ${missing.join(', ')}`
        );
    });
});