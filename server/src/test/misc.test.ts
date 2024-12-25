import * as builtinCmds from '../builtin-cmds.json';
import * as assert from 'assert';
import { getCmdKeyWords } from '../utils';

suite('builtin-cmds.json test', () => {
    test('All keywords should be unique', () => {
        Object.keys(builtinCmds).forEach(key => {
            const command: { sig: string[], deprecated?: true, keyword?: string[], constant?: string[] } = builtinCmds[key];
            if (command.keyword) {
                const set = new Set(command.keyword);
                assert.strictEqual(set.size, command.keyword.length, `Keyword of ${key} is not unique`);
            }
        });
    });

    test('function getCmdKeyWords', () => {
        Object.keys(builtinCmds).forEach(key => {
            if (key === 'cmake_policy' || key === 'enable_language' || key === 'link_libraries' || key === 'project') {
                return;
            }
            const command: { sig: string[], deprecated?: true, keyword?: string[], constant?: string[] } = builtinCmds[key];
            const keywords = getCmdKeyWords(command.sig);
            if (command.keyword) {
                keywords.forEach(keyword => {
                    assert(command.keyword.includes(keyword), `Keyword ${keyword} of ${key} is not found`);
                });
                assert.strictEqual(keywords.length, command.keyword.length, `Keyword of ${key} is not right`);
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