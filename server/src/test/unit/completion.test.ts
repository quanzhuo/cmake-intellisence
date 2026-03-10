import * as assert from 'assert';
import { before } from "mocha";
import { CMakeInfo } from "../../cmakeInfo";
import { CMakeCompletionType, getCompletionInfoAtCursor, isCursorWithinParentheses } from "../../completion";
import { extractFlatCommands } from "../../flatCommands";
import { getFileContext } from "../../utils";

suite('Completion Tests', () => {
    let cmakeInfo: CMakeInfo;

    before(async function () {
        this.timeout(10000);
        cmakeInfo = new CMakeInfo({
            cmakePath: "cmake",
            pkgConfigPath: "",
            cmdCaseDiagnostics: false,
            loggingLevel: 'off'
        });
        await cmakeInfo.init();
    });

    function findDuplicates(items: Iterable<string>): string[] {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const item of items) {
            if (seen.has(item)) {
                duplicates.add(item);
            } else {
                seen.add(item);
            }
        }
        return Array.from(duplicates);
    }

    test('variables should be unique', () => {
        const duplicates = findDuplicates(cmakeInfo.variables);
        assert.strictEqual(duplicates.length, 0, `Duplicate variables found: ${duplicates.join(', ')}`);
    });

    test('modules should be unique', () => {
        const duplicates = findDuplicates(cmakeInfo.modules);
        assert.strictEqual(duplicates.length, 0, `Duplicate modules found: ${duplicates.join(', ')}`);
    });

    test('policies should be unique', () => {
        const duplicates = findDuplicates(cmakeInfo.policies);
        assert.strictEqual(duplicates.length, 0, `Duplicate policies found: ${duplicates.join(', ')}`);
    });

    test('properties should be unique', () => {
        const duplicates = findDuplicates(cmakeInfo.properties);
        assert.strictEqual(duplicates.length, 0, `Duplicate properties found: ${duplicates.join(', ')}`);
    });

    test('commands should be unique', () => {
        const duplicates = findDuplicates(cmakeInfo.commands);
        assert.strictEqual(duplicates.length, 0, `Duplicate commands found: ${duplicates.join(', ')}`);
    });
});

suite('Utility Function Tests', () => {
    test('isCursorWithinParentheses', () => {
        const testCases = [
            { position: { line: 1, character: 5 }, lParenLine: 1, lParenColumn: 4, rParenLine: 1, rParenColumn: 10, expected: true },
            { position: { line: 1, character: 3 }, lParenLine: 1, lParenColumn: 4, rParenLine: 1, rParenColumn: 10, expected: false },
            { position: { line: 1, character: 11 }, lParenLine: 1, lParenColumn: 4, rParenLine: 1, rParenColumn: 10, expected: false },
            { position: { line: 0, character: 5 }, lParenLine: 1, lParenColumn: 4, rParenLine: 1, rParenColumn: 10, expected: false },
            { position: { line: 2, character: 5 }, lParenLine: 1, lParenColumn: 4, rParenLine: 1, rParenColumn: 10, expected: false },
        ];

        testCases.forEach(({ position, lParenLine, lParenColumn, rParenLine, rParenColumn, expected }) => {
            const result = isCursorWithinParentheses(position, lParenLine, lParenColumn, rParenLine, rParenColumn);
            assert.strictEqual(result, expected);
        });
    });

    test('getCompletionInfoAtCursor command', () => {
        const input = `
mock_command ( arg1 
arg2 ) 
`;
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 0, character: 0 },
                expected: { type: CMakeCompletionType.Command, }
            },

            {
                pos: { line: 1, character: 0 },
                expected: { type: CMakeCompletionType.Command, }
            },
            {
                pos: { line: 1, character: 1 },
                expected: { type: CMakeCompletionType.Command, }
            },
            {
                pos: { line: 1, character: 12 },
                expected: { type: CMakeCompletionType.Command, }
            },
            {
                pos: { line: 1, character: 13 },
                expected: { type: CMakeCompletionType.Command, }
            },
            {
                pos: { line: 2, character: 6 },
                expected: { type: CMakeCompletionType.Command, }
            },
            {
                pos: { line: 3, character: 0 },
                expected: { type: CMakeCompletionType.Command, }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor argument', () => {
        const input = `
mock_command ( arg1 

arg2  arg3          arg4 ) 
`;
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 1, character: 14 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 0 }
            },
            {
                pos: { line: 1, character: 15 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 0 }
            },
            {
                pos: { line: 1, character: 16 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 0 }
            },
            {
                pos: { line: 1, character: 19 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 0 }
            },
            {
                pos: { line: 1, character: 20 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 1 }
            },
            {
                pos: { line: 2, character: 0 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 1 }
            },
            {
                pos: { line: 3, character: 0 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 1 }
            },
            {
                pos: { line: 3, character: 1 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 1 }
            },
            {
                pos: { line: 3, character: 4 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 1 }
            },
            {
                pos: { line: 3, character: 5 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 2 }
            },
            {
                pos: { line: 3, character: 7 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 2 }
            },
            {
                pos: { line: 3, character: 11 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 3 }
            },
            {
                pos: { line: 3, character: 19 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 3 }
            },
            {
                pos: { line: 3, character: 20 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 3 }
            },
            {
                pos: { line: 3, character: 24 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 3 }
            },
            {
                pos: { line: 3, character: 25 },
                expected: { type: CMakeCompletionType.Argument, command: "mock_command", index: 4 }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
            assert.strictEqual(result.command, expected.command);
            assert.strictEqual(result.index, expected.index);
        });
    });

    test('getCompletionInfoAtCursor variable 1', () => {
        const input = 'mock_command(arg1 ${})';
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 0, character: 20 },
                expected: { type: CMakeCompletionType.Variable, }
            },

            {
                pos: { line: 0, character: 21 },
                expected: { type: CMakeCompletionType.Argument, }
            },
            {
                pos: { line: 0, character: 19 },
                expected: { type: CMakeCompletionType.Argument, }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor variable 2', () => {
        const input = "mock_command( arg1 ${CMAKE})";
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 0, character: 21 },
                expected: { type: CMakeCompletionType.Variable, }
            },

            {
                pos: { line: 0, character: 22 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 26 },
                expected: { type: CMakeCompletionType.Variable, }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor variable 3', () => {
        const input = "mock_command(arg1 ${CMAKE} ${FOO})";
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 0, character: 20 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 22 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 25 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 28 },
                expected: { type: CMakeCompletionType.Argument, }
            },
            {
                pos: { line: 0, character: 29 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 32 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 33 },
                expected: { type: CMakeCompletionType.Argument, }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('multi variable reference in single argument should work', () => {
        const input = 'mock_command(arg1 ${Foo}${Bar})';
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            {
                pos: { line: 0, character: 19 },
                expected: { type: CMakeCompletionType.Argument, }
            },
            {
                pos: { line: 0, character: 20 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 22 },
                expected: { type: CMakeCompletionType.Variable, }
            },
            {
                pos: { line: 0, character: 23 },
                expected: { type: CMakeCompletionType.Variable, }
            },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });
});
