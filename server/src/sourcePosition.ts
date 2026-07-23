import { Position, Range } from 'vscode-languageserver';
import { Token } from 'antlr4';

export function positionAtTextOffset(start: Position, text: string, offset: number): Position {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    let line = start.line;
    let character = start.character;

    for (let index = 0; index < boundedOffset; index++) {
        const char = text[index];
        if (char === '\r' && text[index + 1] === '\n') {
            line++;
            character = 0;
            index++;
        } else if (char === '\n' || char === '\r') {
            line++;
            character = 0;
        } else {
            character++;
        }
    }

    return { line, character };
}

export function textOffsetAtPosition(start: Position, text: string, position: Position): number | null {
    if (position.line < start.line || (position.line === start.line && position.character < start.character)) {
        return null;
    }

    let line = start.line;
    let character = start.character;
    for (let offset = 0; offset <= text.length; offset++) {
        if (line === position.line && character === position.character) {
            return offset;
        }
        if (line > position.line || (line === position.line && character > position.character) || offset === text.length) {
            return null;
        }

        const char = text[offset];
        if (char === '\r' && text[offset + 1] === '\n') {
            line++;
            character = 0;
            offset++;
        } else if (char === '\n' || char === '\r') {
            line++;
            character = 0;
        } else {
            character++;
        }
    }

    return null;
}

export function rangeForTextOffsets(start: Position, text: string, startOffset: number, endOffset: number): Range {
    return {
        start: positionAtTextOffset(start, text, startOffset),
        end: positionAtTextOffset(start, text, endOffset),
    };
}

export function tokenStartPosition(token: Token): Position {
    return {
        line: Math.max(token.line - 1, 0),
        character: Math.max(token.column, 0),
    };
}

export function rangeForTokenOffsets(token: Token, startOffset: number, endOffset: number): Range {
    return rangeForTextOffsets(tokenStartPosition(token), token.text, startOffset, endOffset);
}
