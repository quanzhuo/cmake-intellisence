import { ParseTreeWalker } from 'antlr4';
import * as assert from 'assert';
import { InitializeParams } from 'vscode-languageserver';
import { SemanticTokenListener, encodeTokenModifiers, getTokenModifiers, getTokenTypes } from '../../semanticTokens';
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
                    }
                }
            }
            : {},
    } as InitializeParams;
}

suite('Semantic Token Tests', () => {
    teardown(() => {
        getTokenTypes(initializeParams());
        getTokenModifiers(initializeParams());
    });

    test('modifier bits should follow the negotiated legend order', () => {
        const legend = getTokenModifiers(initializeParams([], ['definition', 'readonly']));

        assert.deepStrictEqual(legend, ['definition', 'readonly']);
        assert.strictEqual(encodeTokenModifiers(['definition']), 1);
        assert.strictEqual(encodeTokenModifiers(['readonly']), 2);
        assert.strictEqual(encodeTokenModifiers(['declaration']), 0);
    });

    test('generator-expression tokens should retain multiline source positions', () => {
        getTokenTypes(initializeParams());
        getTokenModifiers(initializeParams());
        const uri = 'file:///semantic-multiline.cmake';
        const parsed = parseCMakeText('message("$<CONFIG:\nDebug>")');
        const listener = new SemanticTokenListener(uri, new SymbolIndex(), uri);
        ParseTreeWalker.DEFAULT.walk(listener, parsed.fileContext);

        const data = listener.getSemanticTokens().data;
        const decoded: Array<{ line: number; character: number; length: number; type: number }> = [];
        let line = 0;
        let character = 0;
        for (let index = 0; index < data.length; index += 5) {
            line += data[index];
            character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
            decoded.push({
                line,
                character,
                length: data[index + 2],
                type: data[index + 3],
            });
        }

        assert(decoded.some(token => token.line === 1
            && token.character === 0
            && token.length === 'Debug'.length
            && token.type === 3));
    });
});
