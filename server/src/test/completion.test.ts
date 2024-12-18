import { CharStreams, CommonTokenStream } from "antlr4";
import * as assert from 'assert';
import { CompletionItem, CompletionItemKind, CompletionList, Position } from "vscode-languageserver";
import { CMakeInfo } from "../cmakeInfo";
import Completion from "../completion";
import CMakeSimpleLexer from "../generated/CMakeSimpleLexer";
import CMakeSimpleParser, * as cmsp from "../generated/CMakeSimpleParser";
import { before } from "mocha";

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
