import * as assert from 'assert';
import { positionAtTextOffset, rangeForTextOffsets, textOffsetAtPosition } from '../../sourcePosition';

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
});
