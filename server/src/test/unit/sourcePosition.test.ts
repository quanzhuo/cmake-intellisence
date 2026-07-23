import * as assert from 'assert';
import {
    positionAtTextOffset,
    rangeForTextOffsets,
    rangeForTokenOffsets,
    textOffsetAtPosition,
    tokenStartPosition,
} from '../../sourcePosition';
import { parseCMakeText } from '../../utils';

suite('Source Position Tests', () => {
    test('offset conversion should preserve CRLF and multiline columns', () => {
        const text = 'before\r\n${VALUE}\r\nafter';
        const start = { line: 3, character: 8 };
        const valueOffset = text.indexOf('VALUE');
        const position = positionAtTextOffset(start, text, valueOffset);

        assert.deepStrictEqual(position, { line: 4, character: 2 });
        assert.strictEqual(textOffsetAtPosition(start, text, position), valueOffset);
        assert.deepStrictEqual(
            rangeForTextOffsets(start, text, valueOffset, valueOffset + 'VALUE'.length),
            {
                start: { line: 4, character: 2 },
                end: { line: 4, character: 7 },
            },
        );
    });

    test('ANTLR code-point columns should be converted to LSP UTF-16 columns', () => {
        const text = 'message("😀" $<CONFIG:Debug>)';
        const token = parseCMakeText(text).tokenStream.tokens
            .find(candidate => candidate.text.startsWith('$<CONFIG'))!;

        assert.deepStrictEqual(tokenStartPosition(token), {
            line: 0,
            character: text.indexOf('$<CONFIG'),
        });
        assert.deepStrictEqual(rangeForTokenOffsets(token, 2, 8), {
            start: { line: 0, character: text.indexOf('CONFIG') },
            end: { line: 0, character: text.indexOf('CONFIG') + 'CONFIG'.length },
        });
    });
});
