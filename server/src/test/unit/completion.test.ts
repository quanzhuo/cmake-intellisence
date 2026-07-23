import * as assert from 'assert';
import * as fs from 'fs';
import { before } from "mocha";
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { ExtensionSettings, initializeCMakeEnvironment } from "../../cmakeEnvironment";
import Completion, { CMakeCompletionType, findCommandAtPosition, getCompletionInfoAtCursor, isCursorWithinParentheses } from '../../completion';
import { FlatCommand } from "../../flatCommands";
import { Logger } from '../../logging';
import { SymbolIndex, SymbolKind } from "../../symbolIndex";
import { getIncludeFileUri, parseCMakeText } from "../../utils";

suite('Completion Tests', () => {
    let symbolIndex: SymbolIndex;

    before(async function () {
        this.timeout(10000);
        symbolIndex = new SymbolIndex();
        const extSettings: ExtensionSettings = {
            cmakePath: "cmake",
            pkgConfigPath: "",
            cmdCaseDiagnostics: false,
            loggingLevel: 'off',
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

    test('command completion should include block snippets for control commands', async () => {
        const completion = new Completion(
            new Map(),
            new Map(),
            [],
            'if',
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri: 'file:///command-snippet.cmake' },
            position: { line: 0, character: 2 },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const snippet = items.find(item => item.label === 'if ... endif');

        assert(snippet !== undefined, 'Should suggest if block snippet');
        assert.strictEqual(snippet?.insertText, 'if(${1:condition})\n\t${0}\nendif()');
    });

    test('command completion should preserve specialized snippets for builtin commands', async () => {
        const completion = new Completion(
            new Map(),
            new Map(),
            [],
            'cmake_mini',
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri: 'file:///command-specialized-snippet.cmake' },
            position: { line: 0, character: 10 },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const snippet = items.find(item => item.label === 'cmake_minimum_required');

        assert(snippet !== undefined, 'Should suggest cmake_minimum_required');
        assert.strictEqual(snippet?.insertText, 'cmake_minimum_required(VERSION ${1:3.16})');
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
        const commands = parseCMakeText(input).flatCommands;
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
            loggingLevel: 'off',
        };
        await initializeCMakeEnvironment(extSettings, symbolIndex);
    });

    async function completeCondition(input: string, word: string, character: number, externalTargetNames: string[] = []): Promise<string[]> {
        const parsed = parseCMakeText(input);
        const uri = URI.file(path.resolve(__dirname, 'condition-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            externalTargetNames,
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
        const labels = await completeCondition('if(TARGET My)', 'My', 12, ['MyExe', 'MyLib']);

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
                [],
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

    test('add_subdirectory should suggest filesystem directories for the first argument', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-add-subdir-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const childDir = path.join(tempDir, 'app');

        try {
            fs.writeFileSync(docPath, 'add_subdirectory(ap)', 'utf8');
            fs.mkdirSync(childDir);

            const parsed = parseCMakeText('add_subdirectory(ap)');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'ap',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'add_subdirectory(ap'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('app'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('configure_file should suggest filesystem paths for the input argument', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-configure-file-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const configDir = path.join(tempDir, 'config');
        const inputPath = path.join(configDir, 'input.in');

        try {
            fs.mkdirSync(configDir);
            fs.writeFileSync(docPath, 'configure_file(config/in)', 'utf8');
            fs.writeFileSync(inputPath, 'value=@VALUE@', 'utf8');

            const parsed = parseCMakeText('configure_file(config/in)');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'config/in',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'configure_file(config/in'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('input.in'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('add_subdirectory should suggest filesystem directories for unfinished first arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-add-subdir-open-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const childDir = path.join(tempDir, 'app');

        try {
            fs.writeFileSync(docPath, 'add_subdirectory(ap', 'utf8');
            fs.mkdirSync(childDir);

            const parsed = parseCMakeText('add_subdirectory(ap');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'ap',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'add_subdirectory(ap'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('app'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('configure_file should suggest filesystem paths for unfinished input arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-configure-file-open-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const configDir = path.join(tempDir, 'config');
        const inputPath = path.join(configDir, 'input.in');

        try {
            fs.mkdirSync(configDir);
            fs.writeFileSync(docPath, 'configure_file(config/in', 'utf8');
            fs.writeFileSync(inputPath, 'value=@VALUE@', 'utf8');

            const parsed = parseCMakeText('configure_file(config/in');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'config/in',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'configure_file(config/in'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('input.in'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('configure_file should suggest filesystem paths for unfinished output arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-configure-file-output-open-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const configDir = path.join(tempDir, 'config');
        const inputPath = path.join(configDir, 'input.in');
        const outputPath = path.join(tempDir, 'output.txt');

        try {
            fs.mkdirSync(configDir);
            fs.writeFileSync(docPath, 'configure_file(config/input.in out', 'utf8');
            fs.writeFileSync(inputPath, 'value=@VALUE@', 'utf8');
            fs.writeFileSync(outputPath, 'generated', 'utf8');

            const parsed = parseCMakeText('configure_file(config/input.in out');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'out',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'configure_file(config/input.in out'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('output.txt'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('add_library should suggest filesystem paths for source arguments', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-add-library-'));
        const docPath = path.join(tempDir, 'CMakeLists.txt');
        const sourceDir = path.join(tempDir, 'src');
        const sourcePath = path.join(sourceDir, 'lib.cpp');

        try {
            fs.mkdirSync(sourceDir);
            fs.writeFileSync(docPath, 'add_library(sample STATIC src/li)', 'utf8');
            fs.writeFileSync(sourcePath, 'int lib() { return 0; }', 'utf8');

            const parsed = parseCMakeText('add_library(sample STATIC src/li)');
            const uri = URI.file(docPath).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                'src/li',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'add_library(sample STATIC src/li'.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('lib.cpp'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('target_include_directories should suggest project targets for the first argument', async () => {
        const parsed = parseCMakeText('target_include_directories(My)');
        const uri = URI.file(path.resolve(__dirname, 'target-include-dirs-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            ['MyExe', 'MyLib'],
            'My',
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'target_include_directories(My'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
    });

    test('target_link_libraries should suggest both targets and scope keywords for dependency positions', async () => {
        const parsed = parseCMakeText('target_link_libraries(root My)');
        const uri = URI.file(path.resolve(__dirname, 'target-link-libraries-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            ['MyExe', 'MyLib'],
            'My',
            new Logger('test', 'off'),
            symbolIndex,
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'target_link_libraries(root My'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
        assert(labels.includes('PRIVATE'));
        assert(labels.includes('INTERFACE'));
    });

    test('shared target receiver commands should suggest project targets for the first argument', async () => {
        const commands = [
            'target_compile_definitions',
            'target_compile_features',
            'target_compile_options',
            'target_link_directories',
            'target_link_options',
            'target_precompile_headers',
            'target_sources',
        ];

        for (const commandName of commands) {
            const parsed = parseCMakeText(`${commandName}(My)`);
            const uri = URI.file(path.resolve(__dirname, `${commandName}-receiver-completion.cmake`)).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                ['MyExe', 'MyLib'],
                'My',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: `${commandName}(My`.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('MyExe'), `${commandName} should suggest executable targets`);
            assert(labels.includes('MyLib'), `${commandName} should suggest library targets`);
        }
    });

    test('target completions should include snapshot targets when local target info is empty', async () => {
        const parsed = parseCMakeText('target_link_libraries(root Ext)');
        const uri = URI.file(path.resolve(__dirname, 'target-link-libraries-snapshot-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            ['ExtCore', 'ExtRuntime'],
            'Ext',
            new Logger('test', 'off'),
            symbolIndex,
            undefined,
            undefined,
            undefined,
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'target_link_libraries(root Ext'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('ExtCore'));
        assert(labels.includes('ExtRuntime'));
    });

    test('condition test completions should include snapshot tests when local test info is empty', async () => {
        const parsed = parseCMakeText('if(TEST Smoke)');
        const uri = URI.file(path.resolve(__dirname, 'condition-test-snapshot-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            [],
            'Smoke',
            new Logger('test', 'off'),
            symbolIndex,
            undefined,
            undefined,
            undefined,
            ['SmokeSuite', 'SmokeFast'],
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'if(TEST Smoke'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('SmokeSuite'));
        assert(labels.includes('SmokeFast'));
    });

    test('get_test_property should suggest snapshot tests for the first argument', async () => {
        const parsed = parseCMakeText('get_test_property(Smoke PROPERTY TIMEOUT)');
        const uri = URI.file(path.resolve(__dirname, 'get-test-property-snapshot-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            [],
            'Smoke',
            new Logger('test', 'off'),
            symbolIndex,
            undefined,
            undefined,
            undefined,
            ['SmokeSuite', 'SmokeFast'],
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'get_test_property(Smoke'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('SmokeSuite'));
        assert(labels.includes('SmokeFast'));
    });

    test('set_tests_properties should suggest snapshot tests before PROPERTIES', async () => {
        const parsed = parseCMakeText('set_tests_properties(Smoke PROPERTIES TIMEOUT 10)');
        const uri = URI.file(path.resolve(__dirname, 'set-tests-properties-snapshot-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            [],
            'Smoke',
            new Logger('test', 'off'),
            symbolIndex,
            undefined,
            undefined,
            undefined,
            ['SmokeSuite', 'SmokeFast'],
        );

        const result = await completion.onCompletion({
            textDocument: { uri },
            position: { line: 0, character: 'set_tests_properties(Smoke'.length },
        });

        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const labels = items.map(item => item.label.toString());

        assert(labels.includes('SmokeSuite'));
        assert(labels.includes('SmokeFast'));
    });

    test('pkg_check_modules should suggest pkg-config keywords and modules after the prefix argument', async () => {
        symbolIndex.pkgConfigModules = new Map([
            ['zlib', 'compression library'],
            ['openssl', 'TLS library'],
        ]);

        try {
            const parsed = parseCMakeText('pkg_check_modules(PREFIX )');
            const uri = URI.file(path.resolve(__dirname, 'pkg-check-modules-completion.cmake')).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                '',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'pkg_check_modules(PREFIX '.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes('REQUIRED'));
            assert(labels.includes('zlib'));
            assert(labels.includes('openssl'));
        } finally {
            symbolIndex.pkgConfigModules = new Map();
        }
    });

    test('pkg_check_modules should not suggest pkg-config items for the first argument', async () => {
        symbolIndex.pkgConfigModules = new Map([
            ['zlib', 'compression library'],
        ]);

        try {
            const parsed = parseCMakeText('pkg_check_modules()');
            const uri = URI.file(path.resolve(__dirname, 'pkg-check-modules-first-arg.cmake')).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                '',
                new Logger('test', 'off'),
                symbolIndex,
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: 'pkg_check_modules('.length },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            assert.strictEqual(items.length, 0, 'First pkg_check_modules argument should not suggest pkg-config items');
        } finally {
            symbolIndex.pkgConfigModules = new Map();
        }
    });

    test('shared property commands should suggest builtin properties at their property slots', async () => {
        const cases = [
            { commandName: 'get_property', input: 'get_property(out TARGET my_target PROPERTY posi)', cursor: 'get_property(out TARGET my_target PROPERTY posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'set_property', input: 'set_property(TARGET my_target PROPERTY posi)', cursor: 'set_property(TARGET my_target PROPERTY posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'define_property', input: 'define_property(TARGET PROPERTY posi)', cursor: 'define_property(TARGET PROPERTY posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'get_target_property', input: 'get_target_property(out my_target posi)', cursor: 'get_target_property(out my_target posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'get_cmake_property', input: 'get_cmake_property(out posi)', cursor: 'get_cmake_property(out posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'get_test_property', input: 'get_test_property(Smoke time)', cursor: 'get_test_property(Smoke time'.length, expected: 'TIMEOUT' },
            { commandName: 'set_directory_properties', input: 'set_directory_properties(PROPERTIES posi)', cursor: 'set_directory_properties(PROPERTIES posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'set_source_files_properties', input: 'set_source_files_properties(main.cpp PROPERTIES posi)', cursor: 'set_source_files_properties(main.cpp PROPERTIES posi'.length, expected: 'POSITION_INDEPENDENT_CODE' },
            { commandName: 'set_tests_properties', input: 'set_tests_properties(Smoke PROPERTIES time)', cursor: 'set_tests_properties(Smoke PROPERTIES time'.length, expected: 'TIMEOUT' },
        ];

        for (const testCase of cases) {
            const parsed = parseCMakeText(testCase.input);
            const uri = URI.file(path.resolve(__dirname, `${testCase.commandName}-property-completion.cmake`)).toString();
            const completion = new Completion(
                new Map([[uri, parsed.flatCommands]]),
                new Map([[uri, parsed.tokenStream]]),
                [],
                testCase.input.slice(0, testCase.cursor).split(/[^A-Za-z0-9_]+/).pop() ?? '',
                new Logger('test', 'off'),
                symbolIndex,
                undefined,
                undefined,
                undefined,
                ['SmokeSuite', 'SmokeFast'],
            );

            const result = await completion.onCompletion({
                textDocument: { uri },
                position: { line: 0, character: testCase.cursor },
            });

            const items = Array.isArray(result) ? result : (result?.items ?? []);
            const labels = items.map(item => item.label.toString());

            assert(labels.includes(testCase.expected), `${testCase.commandName} should suggest ${testCase.expected}`);
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
            loggingLevel: 'off',
        };
        await initializeCMakeEnvironment(extSettings, symbolIndex);
    });

    async function completeGenex(input: string, word: string, character: number, externalTargetNames: string[] = []): Promise<string[]> {
        const parsed = parseCMakeText(input);
        const uri = URI.file(path.resolve(__dirname, 'genex-completion.cmake')).toString();
        const completion = new Completion(
            new Map([[uri, parsed.flatCommands]]),
            new Map([[uri, parsed.tokenStream]]),
            externalTargetNames,
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
        const labels = await completeGenex(input, 'My', 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:My'.length, ['MyExe', 'MyLib']);

        assert(labels.includes('MyExe'));
        assert(labels.includes('MyLib'));
    });

    test('TARGET_PROPERTY genex should suggest properties after target name', async () => {
        const input = 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:MyExe,IN>)';
        const labels = await completeGenex(input, 'IN', 'target_compile_definitions(tgt PRIVATE $<TARGET_PROPERTY:MyExe,IN'.length, ['MyExe']);

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
        const labels = await completeGenex(input, 'My', 'target_compile_definitions(tgt PRIVATE $<TARGET_FILE:My'.length, ['MyExe', 'MyLib']);

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
