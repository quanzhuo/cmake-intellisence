import * as assert from 'assert';
import * as fs from 'fs';
import { before } from "mocha";
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { ExtensionSettings, initializeCMakeEnvironment } from "../../cmakeEnvironment";
import Completion, { CMakeCompletionType, findCommandAtPosition, getCompletionInfoAtCursor, isCursorWithinParentheses } from '../../completion';
import { extractFlatCommands, FlatCommand } from "../../flatCommands";
import { Logger } from '../../logging';
import { SymbolIndex, SymbolKind } from "../../symbolIndex";
import { getFileContext, getIncludeFileUri, parseCMakeText } from "../../utils";

suite('Completion Tests', () => {
    let symbolIndex: SymbolIndex;

    before(async function () {
        this.timeout(10000);
        symbolIndex = new SymbolIndex();
        const extSettings: ExtensionSettings = {
            cmakePath: "cmake",
            pkgConfigPath: "",
            cmdCaseDiagnostics: false,
            loggingLevel: 'off'
        };
        await initializeCMakeEnvironment(extSettings, symbolIndex);
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
        const duplicates = findDuplicates(symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinVariable));
        assert.strictEqual(duplicates.length, 0, `Duplicate variables found: ${duplicates.join(', ')}`);
    });

    test('modules should be unique', () => {
        const duplicates = findDuplicates(symbolIndex.getAllSystemSymbols(SymbolKind.Module));
        assert.strictEqual(duplicates.length, 0, `Duplicate modules found: ${duplicates.join(', ')}`);
    });

    test('policies should be unique', () => {
        const duplicates = findDuplicates(symbolIndex.getAllSystemSymbols(SymbolKind.Policy));
        assert.strictEqual(duplicates.length, 0, `Duplicate policies found: ${duplicates.join(', ')}`);
    });

    test('properties should be unique', () => {
        const duplicates = findDuplicates(symbolIndex.getAllSystemSymbols(SymbolKind.Property));
        assert.strictEqual(duplicates.length, 0, `Duplicate properties found: ${duplicates.join(', ')}`);
    });

    test('commands should be unique', () => {
        const duplicates = findDuplicates(symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinCommand));
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

    test('multiple variable references in a mixed argument should all be detected', () => {
        const input = 'mock_command(${FOO}_${BAR})';
        const commands = extractFlatCommands(getFileContext(input));
        const testCases = [
            { pos: { line: 0, character: 15 }, expected: CMakeCompletionType.Variable },
            { pos: { line: 0, character: 17 }, expected: CMakeCompletionType.Variable },
            { pos: { line: 0, character: 22 }, expected: CMakeCompletionType.Variable },
            { pos: { line: 0, character: 24 }, expected: CMakeCompletionType.Variable },
            { pos: { line: 0, character: 20 }, expected: CMakeCompletionType.Argument },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(commands, pos);
            assert.strictEqual(result.type, expected);
        });
    });

    test('findCommandAtPosition should skip malformed commands without aborting search', () => {
        const validBefore = {
            start: { line: 1 },
            stop: { line: 1 },
        } as FlatCommand;
        const malformed = {
            start: { line: 2 },
            stop: null,
        } as FlatCommand;
        const validAfter = {
            start: { line: 3 },
            stop: { line: 3 },
        } as FlatCommand;

        const found = findCommandAtPosition([validBefore, malformed, validAfter], { line: 2, character: 0 });

        assert.strictEqual(found, validAfter);
    });

    test('extractFlatCommands should not recover invalid set() commands', () => {
        const parsed = parseCMakeText('set()');

        assert.strictEqual(parsed.flatCommands.length, 0);
    });

    test('getCompletionInfoAtCursor should treat set() as argument context', () => {
        const parsed = parseCMakeText('set()');
        const result = getCompletionInfoAtCursor(parsed.flatCommands, { line: 0, character: 4 }, parsed.tokenStream);

        assert.strictEqual(result.type, CMakeCompletionType.Argument);
        assert.strictEqual(result.command, 'set');
        assert.strictEqual(result.index, 0);
    });

    test('incomplete block commands should still produce argument completion info from tokens', () => {
        const testCases = [
            { input: 'if()', pos: { line: 0, character: 3 }, command: 'if' },
            { input: 'if(', pos: { line: 0, character: 3 }, command: 'if' },
            { input: 'while()', pos: { line: 0, character: 6 }, command: 'while' },
            { input: 'function()', pos: { line: 0, character: 9 }, command: 'function' },
            { input: 'macro()', pos: { line: 0, character: 6 }, command: 'macro' },
            { input: 'foreach()', pos: { line: 0, character: 8 }, command: 'foreach' },
        ];

        testCases.forEach(({ input, pos, command }) => {
            const parsed = parseCMakeText(input);
            const result = getCompletionInfoAtCursor(parsed.flatCommands, pos, parsed.tokenStream);

            assert.strictEqual(result.type, CMakeCompletionType.Argument, input);
            assert.strictEqual(result.command, command, input);
            assert.strictEqual(result.index, 0, input);
        });
    });
});

suite('Condition Completion Tests', () => {
    let symbolIndex: SymbolIndex;

    before(async function () {
        this.timeout(10000);
        symbolIndex = new SymbolIndex();
        const extSettings: ExtensionSettings = {
            cmakePath: 'cmake',
            pkgConfigPath: '',
            cmdCaseDiagnostics: false,
            loggingLevel: 'off'
        };
        await initializeCMakeEnvironment(extSettings, symbolIndex);
    });

    async function completeCondition(input: string, word: string, character: number, targetInfo = {}): Promise<string[]> {
        const parsed = parseCMakeText(input);
        const uri = URI.file(path.resolve(__dirname, 'condition-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            targetInfo,
            word,
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        return items.map(item => item.label.toString());
    }

    test('condition start should suggest unary keywords instead of binary operators', async () => {
        const labels = await completeCondition('if(COMM)', 'COMM', 7);

        assert(labels.includes('COMMAND'));
        assert(!labels.includes('STREQUAL'));
    });

    test('COMMAND predicate should suggest command names only', async () => {
        const labels = await completeCondition('if(COMMAND mes)', 'mes', 14);

        assert(labels.includes('message'));
        assert(!labels.includes('COMMAND'));
    });

    test('completed operand should suggest condition operators', async () => {
        const labels = await completeCondition('if(VAR )', '', 7);

        assert(labels.includes('STREQUAL'));
        assert(labels.includes('AND'));
        assert(!labels.includes('COMMAND'));
    });

    test('DEFINED predicate should suggest ENV and CACHE forms', async () => {
        const labels = await completeCondition('if(DEFINED EN)', 'EN', 13);

        assert(labels.includes('ENV{}'));
        assert(!labels.includes('TARGET'));
    });

    test('TARGET predicate should suggest project targets', async () => {
        const labels = await completeCondition('if(TARGET My)', 'My', 12, {
            executables: new Set(['MyExe']),
            libraries: new Set(['MyLib']),
        });

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
        assert(!labels.includes('TARGET'));
    });

    test('include should suggest both builtin modules and filesystem files for the first argument', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-include-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const includePath = path.join(tempDir, 'helper.cmake');

        try {
            fs.writeFileSync(docPath, 'include(he)', 'utf8');
            fs.writeFileSync(includePath, '# helper', 'utf8');

            const parsed = parseCMakeText('include(he)');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                {},
                'he',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'include(he'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('helper.cmake'));
            assert(labels.includes('CMakePrintHelpers'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('include dependency resolution should ignore directories', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-include-dir-'));
        const childDir = path.join(tempDir, '.vscode');
        fs.mkdirSync(childDir);

        try {
            const baseUri = URI.file(tempDir);
            assert.strictEqual(getIncludeFileUri(symbolIndex, baseUri, '.vscode/'), null);
            assert.strictEqual(getIncludeFileUri(symbolIndex, baseUri, '.vscode'), null);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

suite('Generator Expression Completion Tests', () => {
    let symbolIndex: SymbolIndex;

    before(async function () {
        this.timeout(10000);
        symbolIndex = new SymbolIndex();
        const extSettings: ExtensionSettings = {
            cmakePath: 'cmake',
            pkgConfigPath: '',
            cmdCaseDiagnostics: false,
            loggingLevel: 'off'
        };
        await initializeCMakeEnvironment(extSettings, symbolIndex);
    });

    async function completeGenex(input: string, word: string, character: number, targetInfo = {}): Promise<string[]> {
        const parsed = parseCMakeText(input);
        const uri = URI.file(path.resolve(__dirname, 'genex-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            targetInfo,
            word,
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        return items.map(item => item.label.toString());
    }

    test('top-level genex name completion should suggest target expressions', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<TA>)';
        const labels = await completeGenex(input, 'TA', 'target_compile_definitions(tgt PRIVATE $<TA'.length);

        assert(labels.includes('TARGET_PROPERTY'));
        assert(labels.includes('TARGET_EXISTS'));
    });

    test('CONFIG genex should suggest common configuration names', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<CONFIG:De>)';
        const labels = await completeGenex(input, 'De', 'target_compile_definitions(tgt PRIVATE $<CONFIG:De'.length);

        assert(labels.includes('Debug'));
    });

    test('CONFIG genex should still suggest configuration names in incomplete commands', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<CONFIG:De';
        const labels = await completeGenex(input, 'De', 'target_compile_definitions(tgt PRIVATE $<CONFIG:De'.length);

        assert(labels.includes('Debug'));
    });

    test('TARGET_PROPERTY genex should suggest targets first', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:My>)';
        const labels = await completeGenex(input, 'My', 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:My'.length, {
            executables: new Set(['MyExe']),
            libraries: new Set(['MyLib']),
        });

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
    });

    test('TARGET_PROPERTY genex should suggest properties after target name', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:MyExe,IN>)';
        const labels = await completeGenex(input, 'IN', 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:MyExe,IN'.length, {
            executables: new Set(['MyExe']),
        });

        assert(labels.includes('INCLUDE_DIRECTORIES'));
    });

    test('BOOL genex should suggest boolean constants and builtin variables', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<BOOL:>)';
        const labels = await completeGenex(input, '', 'target_compile_definitions(tgt PRIVATE $<BOOL:'.length);

        assert(labels.includes('CMAKE_SOURCE_DIR'));
        assert(labels.includes('TRUE'));
    });

    test('shorthand conditional genex should suggest condition expressions in the first segment', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<$<CO>)';
        const labels = await completeGenex(input, 'CO', 'target_compile_definitions(tgt PRIVATE $<$<CO'.length);

        assert(labels.includes('CONFIG'));
        assert(labels.includes('COMPILE_LANGUAGE'));
    });

    test('shorthand conditional genex should suggest payload values in the second segment', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<$<CONFIG:Debug>:CMAKE_>)';
        const labels = await completeGenex(input, 'CMAKE_', 'target_compile_definitions(tgt PRIVATE $<$<CONFIG:Debug>:CMAKE_'.length);

        assert(labels.includes('CMAKE_SOURCE_DIR'));
    });

    test('TARGET_FILE genex should suggest targets', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<TARGET_FILE:My>)';
        const labels = await completeGenex(input, 'My', 'target_compile_definitions(tgt PRIVATE $<TARGET_FILE:My'.length, {
            executables: new Set(['MyExe']),
            libraries: new Set(['MyLib']),
        });

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
    });

    test('STRING genex should suggest subcommands', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<STRING:HA>)';
        const labels = await completeGenex(input, 'HA', 'target_compile_definitions(tgt PRIVATE $<STRING:HA'.length);

        assert(labels.includes('HASH'));
    });

    test('STRING HASH genex should suggest algorithm options', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<STRING:HASH,value,ALGORITHM:SHA>)';
        const labels = await completeGenex(input, 'ALGORITHM:SHA', 'target_compile_definitions(tgt PRIVATE $<STRING:HASH,value,ALGORITHM:SHA'.length);

        assert(labels.includes('ALGORITHM:SHA256'));
    });

    test('STRING MATCH genex should suggest seek options', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<STRING:MATCH,value,SEEK:>)';
        const labels = await completeGenex(input, 'SEEK:', 'target_compile_definitions(tgt PRIVATE $<STRING:MATCH,value,SEEK:'.length);

        assert(labels.includes('SEEK:ONCE'));
        assert(labels.includes('SEEK:ALL'));
    });

    test('STRING REPLACE genex should suggest replacement mode options', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<STRING:REPLACE,RE>)';
        const labels = await completeGenex(input, 'RE', 'target_compile_definitions(tgt PRIVATE $<STRING:REPLACE,RE'.length);

        assert(labels.includes('REGEX'));
    });

    test('STRING UUID genex should suggest UUID option keys', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<STRING:UUID,TY>)';
        const labels = await completeGenex(input, 'TY', 'target_compile_definitions(tgt PRIVATE $<STRING:UUID,TY'.length);

        assert(labels.includes('TYPE:MD5'));
    });

    test('LIST genex should suggest filter modes', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<LIST:FILTER,my_list,IN>)';
        const labels = await completeGenex(input, 'IN', 'target_compile_definitions(tgt PRIVATE $<LIST:FILTER,my_list,IN'.length);

        assert(labels.includes('INCLUDE'));
    });

    test('LIST TRANSFORM genex should suggest actions', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<LIST:TRANSFORM,my_list,TO>)';
        const labels = await completeGenex(input, 'TO', 'target_compile_definitions(tgt PRIVATE $<LIST:TRANSFORM,my_list,TO'.length);

        assert(labels.includes('TOLOWER'));
        assert(labels.includes('TOUPPER'));
    });

    test('LIST TRANSFORM genex should suggest selectors after the action', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<LIST:TRANSFORM,my_list,TOLOWER,RE>)';
        const labels = await completeGenex(input, 'RE', 'target_compile_definitions(tgt PRIVATE $<LIST:TRANSFORM,my_list,TOLOWER,RE'.length);

        assert(labels.includes('REGEX'));
    });

    test('LIST SORT genex should suggest sort option keys', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<LIST:SORT,my_list,CASE:>)';
        const labels = await completeGenex(input, 'CASE:', 'target_compile_definitions(tgt PRIVATE $<LIST:SORT,my_list,CASE:'.length);

        assert(labels.includes('CASE:SENSITIVE'));
    });

    test('PATH genex should suggest subcommands', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<PATH:GET_FI>)';
        const labels = await completeGenex(input, 'GET_FI', 'target_compile_definitions(tgt PRIVATE $<PATH:GET_FI'.length);

        assert(labels.includes('GET_FILENAME'));
    });

    test('PATH genex should suggest NORMALIZE where supported', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<PATH:CMAKE_PATH,NO>)';
        const labels = await completeGenex(input, 'NO', 'target_compile_definitions(tgt PRIVATE $<PATH:CMAKE_PATH,NO'.length);

        assert(labels.includes('NORMALIZE'));
    });

    test('PATH genex should suggest LAST_ONLY for extension-like operations', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<PATH:GET_EXTENSION,LA>)';
        const labels = await completeGenex(input, 'LA', 'target_compile_definitions(tgt PRIVATE $<PATH:GET_EXTENSION,LA'.length);

        assert(labels.includes('LAST_ONLY'));
    });
});
