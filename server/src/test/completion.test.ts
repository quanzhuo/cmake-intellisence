import { CharStreams, CommonTokenStream } from "antlr4";
import * as assert from 'assert';
import { before } from "mocha";
import { CompletionItem, CompletionItemKind, CompletionList, Position } from "vscode-languageserver";
import { CMakeInfo } from "../cmakeInfo";
import Completion, { CMakeCompletionType, getCompletionInfoAtCursor, isCursorWithinParentheses } from "../completion";
import CMakeSimpleLexer from "../generated/CMakeSimpleLexer";
import CMakeSimpleParser, * as cmsp from "../generated/CMakeSimpleParser";
import { getSimpleFileContext } from "../utils";

suite('Completion Tests', () => {
    let cmakeInfo: CMakeInfo;

    before(async () => {
        cmakeInfo = new CMakeInfo({ cmakePath: "cmake", cmakeModulePath: "", pkgConfigPath: "", cmdCaseDiagnostics: false, loggingLevel: 'off' }, null);
        await cmakeInfo.init();
    });

    async function getSuggestions(input: string, position: Position, word: string): Promise<CompletionItem[] | CompletionList | null> {
        const charStream = CharStreams.fromString(input);
        const lexer = new CMakeSimpleLexer(charStream);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokenStream);
        parser.removeErrorListeners();
        const fileContext = parser.file();
        const simpleFileContexts = new Map<string, cmsp.FileContext>();
        const simpleTokenStreams = new Map<string, CommonTokenStream>();
        const fileUri = 'file:///test/CMakeLists.txt';
        simpleFileContexts.set(fileUri, fileContext);
        simpleTokenStreams.set(fileUri, tokenStream);
        const params = { textDocument: { uri: fileUri }, position };
        const completion = new Completion(cmakeInfo, simpleFileContexts, simpleTokenStreams, {}, word);
        return completion.onCompletion(params);
    }

    test('should suggest all builtin commands', async () => {
        const input = ``;
        const suggestions = await getSuggestions(input, { line: 0, character: 0 }, "");
        assert(Array.isArray(suggestions));
        cmakeInfo.commands.forEach(cmd => {
            const suggest = suggestions.find(s => s.label === cmd);
            assert(suggest !== undefined);
            assert.strictEqual(suggest.kind, CompletionItemKind.Function);
        });
        assert(suggestions.length > cmakeInfo.commands.length);
        assert.strictEqual(suggestions[0].kind, CompletionItemKind.Function);
    });

    test('cmake_minimum_required', async () => {
        const input = `cmake_mini`;
        const suggestions = await getSuggestions(input, { line: 0, character: 10 }, "cmake_mini");
        assert(Array.isArray(suggestions));
        const suggestion = suggestions.find(s => s.label === "cmake_minimum_required");
        assert(suggestion !== undefined);
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
        const fileContext = getSimpleFileContext(input);
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
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor argument', () => {
        const input = `
mock_command ( arg1 

arg2  arg3          arg4 ) 
`;
        const fileContext = getSimpleFileContext(input);
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
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
            assert.strictEqual(result.command, expected.command);
            assert.strictEqual(result.index, expected.index);
        });
    });

    test('getCompletionInfoAtCursor variable 1', () => {
        const input = 'mock_command(arg1 ${})';
        const fileContext = getSimpleFileContext(input);
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
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor variable 2', () => {
        const input = "mock_command( arg1 ${CMAKE})";
        const fileContext = getSimpleFileContext(input);
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
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('getCompletionInfoAtCursor variable 3', () => {
        const input = "mock_command(arg1 ${CMAKE} ${FOO})";
        const fileContext = getSimpleFileContext(input);
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
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });

    test('multi variable reference in single argument should work', () => {
        const input = 'mock_command(arg1 ${Foo}${Bar})';
        const fileContext = getSimpleFileContext(input);
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
            // {
            //     pos: { line: 0, character: 26 },
            //     expected: { type: CMakeCompletionType.Variable, }
            // },
            // {
            //     pos: { line: 0, character: 27 },
            //     expected: { type: CMakeCompletionType.Variable, }
            // },
            // {
            //     pos: { line: 0, character: 29 },
            //     expected: { type: CMakeCompletionType.Variable, }
            // },
            // {
            //     pos: { line: 0, character: 30 },
            //     expected: { type: CMakeCompletionType.Argument, }
            // },
        ];

        testCases.forEach(({ pos, expected }) => {
            const result = getCompletionInfoAtCursor(fileContext, pos);
            assert.strictEqual(result.type, expected.type);
        });
    });
});
