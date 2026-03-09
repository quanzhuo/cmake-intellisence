import * as builtinCmds from '../builtin-cmds.json';
import * as assert from 'assert';
import { getCmdKeyWords } from '../utils';

suite('builtin-cmds.json test', () => {
    test('All keywords should be unique', () => {
        Object.keys(builtinCmds).forEach(key => {
            const command: { sig: string[], deprecated?: true, keyword?: string[], constant?: string[] } = (builtinCmds as any)[key];
            if (command.keyword) {
                const set = new Set(command.keyword);
                assert.strictEqual(set.size, command.keyword.length, `Keyword of ${key} is not unique`);
            }
        });
    });

    test('function cmake_host_system_information', () => {
        const command = builtinCmds.cmake_host_system_information;
        const keywords = getCmdKeyWords(command.sig);
        assert.strictEqual(keywords.length, command.keyword.length);
    });

    test("function find_file", () => {
        const command = builtinCmds.find_file;
        const keywords = getCmdKeyWords(command.sig);
        assert.strictEqual(keywords.length, command.keyword.length);
    });

    test("function find_package", () => {
        const command = builtinCmds.find_package;
        const keywords = getCmdKeyWords(command.sig);
        assert.strictEqual(keywords.length, command.keyword.length);
    });

    test('function find_program', () => {
        const command = builtinCmds.find_program;
        const keywords = getCmdKeyWords(command.sig);
        assert.strictEqual(keywords.length, command.keyword.length);
    });
});