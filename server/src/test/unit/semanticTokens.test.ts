import * as assert from 'assert';
import { InitializeParams } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import {
    SemanticTokenDescriptor,
    collectSemanticTokens,
    encodeTokenModifiers,
    getTokenModifiers,
    getTokenTypes,
} from '../../semanticTokens';
import { extractSymbols } from '../../symbolExtractor';
import { SymbolIndex } from '../../symbolIndex';
import { parseCMakeText } from '../../utils';

function initializeParams(tokenTypes?: string[], tokenModifiers?: string[]): InitializeParams {
    return {
        capabilities: tokenTypes || tokenModifiers
            ? {
                textDocument: {
                    semanticTokens: {
                        tokenTypes: tokenTypes ?? [],
                        tokenModifiers: tokenModifiers ?? [],
                        formats: ['relative'],
                    },
                },
            }
            : {},
    } as InitializeParams;
}

async function analyze(text: string): Promise<SemanticTokenDescriptor[]> {
    const uri = 'file:///semantic-tokens/CMakeLists.txt';
    const parsed = parseCMakeText(text);
    const symbolIndex = new SymbolIndex();
    const cache = await extractSymbols(
        uri,
        parsed.flatCommands,
        URI.parse('file:///semantic-tokens/'),
        symbolIndex,
        {
            entryFile: uri,
            tokenStream: parsed.tokenStream,
            getFlatCommands: async () => parsed.flatCommands,
        },
    );
    symbolIndex.setCache(uri, cache, 'test', uri);
    return collectSemanticTokens({
        uri,
        entryUri: uri,
        symbolIndex,
        commands: parsed.flatCommands,
    });
}

function tokenAt(
    tokens: readonly SemanticTokenDescriptor[],
    line: number,
    character: number,
): SemanticTokenDescriptor | undefined {
    return tokens.find(token => token.line === line && token.character === character);
}

suite('Semantic Token Tests', () => {
    setup(() => {
        getTokenTypes(initializeParams());
        getTokenModifiers(initializeParams());
    });

    teardown(() => {
        getTokenTypes(initializeParams());
        getTokenModifiers(initializeParams());
    });

    test('modifier bits should follow the negotiated legend order', () => {
        const legend = getTokenModifiers(initializeParams([], ['definition', 'modification']));

        assert.deepStrictEqual(legend, ['definition', 'modification']);
        assert.strictEqual(encodeTokenModifiers(['definition']), 1);
        assert.strictEqual(encodeTokenModifiers(['modification']), 2);
        assert.strictEqual(encodeTokenModifiers(['declaration']), 0);
    });

    test('TextMate-owned condition syntax should not produce semantic tokens', async () => {
        const tokens = await analyze('if(ON AND EXISTS path)\nendif()');

        assert.deepStrictEqual(tokens, []);
    });

    test('contextual builtin options should be keywords and targets should be definitions', async () => {
        const text = 'add_library(app STATIC src/app.cpp)';
        const tokens = await analyze(text);
        const target = tokenAt(tokens, 0, text.indexOf('app'));
        const keyword = tokenAt(tokens, 0, text.indexOf('STATIC'));

        assert.strictEqual(target?.tokenType, 'class');
        assert.deepStrictEqual(target?.modifiers, ['declaration', 'definition']);
        assert.strictEqual(keyword?.tokenType, 'keyword');
    });

    test('resolved custom commands and parameter bindings should refine TextMate scopes', async () => {
        const text = [
            'function(do_work value)',
            '  message("${value}")',
            'endfunction()',
            'do_work(data)',
        ].join('\n');
        const tokens = await analyze(text);
        const functionDefinition = tokenAt(tokens, 0, text.split('\n')[0].indexOf('do_work'));
        const parameterDeclaration = tokenAt(tokens, 0, text.split('\n')[0].indexOf('value'));

        assert.strictEqual(functionDefinition?.tokenType, 'function');
        assert.deepStrictEqual(functionDefinition?.modifiers, ['declaration', 'definition']);
        assert.strictEqual(tokenAt(tokens, 3, 0)?.tokenType, 'function');
        assert.strictEqual(parameterDeclaration?.tokenType, 'parameter');
        assert.deepStrictEqual(parameterDeclaration?.modifiers, ['declaration']);
        assert.strictEqual(tokenAt(tokens, 1, text.split('\n')[1].indexOf('value'))?.tokenType, 'parameter');
    });

    test('ambiguous function and macro bindings should keep the TextMate fallback', async () => {
        const text = [
            'if(FLAG)',
            '  function(run)',
            '  endfunction()',
            'else()',
            '  macro(run)',
            '  endmacro()',
            'endif()',
            'run()',
        ].join('\n');
        const tokens = await analyze(text);

        assert.strictEqual(tokenAt(tokens, 7, 0), undefined);
    });

    test('bracket arguments should remain opaque raw strings', async () => {
        const tokens = await analyze('message([=[$<CONFIG:Debug>]=])');

        assert.deepStrictEqual(tokens, []);
    });

    test('generator roots should remain TextMate scopes while operands receive semantic types', async () => {
        const text = 'message("😀$<CONFIG:Debug>")';
        const tokens = await analyze(text);
        const configOffset = text.indexOf('CONFIG');
        const debugOffset = text.indexOf('Debug');

        assert.strictEqual(tokenAt(tokens, 0, configOffset), undefined);
        assert.strictEqual(tokenAt(tokens, 0, debugOffset)?.tokenType, 'enum');
        assert.strictEqual(tokenAt(tokens, 0, debugOffset)?.length, 'Debug'.length);
    });

    test('multiline generator operands should retain UTF-16 line positions', async () => {
        const tokens = await analyze('message("$<CONFIG:\nDebug>")');

        assert.strictEqual(tokenAt(tokens, 1, 0)?.tokenType, 'enum');
        assert.strictEqual(tokenAt(tokens, 1, 0)?.length, 'Debug'.length);
    });

    test('property roles should refine quoted values without consuming quotes', async () => {
        const text = 'set_target_properties(app PROPERTIES "POSITION_INDEPENDENT_CODE" ON)';
        const tokens = await analyze(text);
        const propertyOffset = text.indexOf('POSITION_INDEPENDENT_CODE');
        const property = tokenAt(tokens, 0, propertyOffset);

        assert.strictEqual(property?.tokenType, 'property');
        assert.strictEqual(property?.length, 'POSITION_INDEPENDENT_CODE'.length);
    });

    test('mixed-case builtin catalog entries should provide contextual keywords', async () => {
        const text = 'FetchContent_Declare(pkg SYSTEM)';
        const tokens = await analyze(text);

        assert.strictEqual(tokenAt(tokens, 0, text.indexOf('SYSTEM'))?.tokenType, 'keyword');
    });

    test('payloads equal to subcommand names should not be misclassified as keywords', async () => {
        const text = 'message(STATUS STATUS)';
        const tokens = await analyze(text);
        const firstStatus = text.indexOf('STATUS');
        const secondStatus = text.lastIndexOf('STATUS');

        assert.strictEqual(tokenAt(tokens, 0, firstStatus)?.tokenType, 'keyword');
        assert.strictEqual(tokenAt(tokens, 0, secondStatus), undefined);
    });

    test('user commands shadowing builtins should not receive builtin argument semantics', async () => {
        const text = [
            'function(message value)',
            'endfunction()',
            'message(STATUS)',
        ].join('\n');
        const tokens = await analyze(text);

        assert.strictEqual(tokenAt(tokens, 2, 0)?.tokenType, 'function');
        assert.strictEqual(tokenAt(tokens, 2, 'message('.length), undefined);
    });

    test('semantic token output should always be single-line and non-overlapping', async () => {
        const tokens = await analyze('function(f "$<CONFIG:Debug>")\nendfunction()');

        for (let index = 0; index < tokens.length; index++) {
            assert(tokens[index].length > 0);
            for (let other = index + 1; other < tokens.length; other++) {
                if (tokens[index].line !== tokens[other].line) {
                    continue;
                }
                assert(
                    tokens[index].character + tokens[index].length <= tokens[other].character
                    || tokens[other].character + tokens[other].length <= tokens[index].character,
                    `overlapping tokens: ${JSON.stringify(tokens[index])} and ${JSON.stringify(tokens[other])}`,
                );
            }
        }
    });
});
