import { Position, Range } from 'vscode-languageserver';
import { Token } from 'antlr4';

class TokenPositionMapper {
    private readonly lineStarts: number[] = [0];
    private readonly columnCache = new Map<number, Map<number, number>>();

    constructor(private readonly text: string) {
        for (let offset = 0; offset < text.length; offset++) {
            const char = text[offset];
            if (char === '\r' && text[offset + 1] === '\n') {
                this.lineStarts.push(offset + 2);
                offset++;
            } else if (char === '\n' || char === '\r') {
                this.lineStarts.push(offset + 1);
            }
        }
    }

    position(line: number, codePointColumn: number): Position {
        const boundedLine = Math.max(0, Math.min(line, this.lineStarts.length - 1));
        const boundedColumn = Math.max(codePointColumn, 0);
        const cachedColumns = this.columnCache.get(boundedLine) ?? new Map<number, number>([[0, 0]]);
        this.columnCache.set(boundedLine, cachedColumns);
        const cached = cachedColumns.get(boundedColumn);
        if (cached !== undefined) {
            return { line: boundedLine, character: cached };
        }

        const lineStart = this.lineStarts[boundedLine];
        const lineEnd = boundedLine + 1 < this.lineStarts.length
            ? this.lineStarts[boundedLine + 1]
            : this.text.length;
        let codePoints = 0;
        let utf16Column = 0;
        while (lineStart + utf16Column < lineEnd && codePoints < boundedColumn) {
            const codePoint = this.text.codePointAt(lineStart + utf16Column);
            if (codePoint === undefined || codePoint === 0x0a || codePoint === 0x0d) {
                break;
            }
            utf16Column += codePoint > 0xffff ? 2 : 1;
            codePoints++;
        }
        cachedColumns.set(boundedColumn, utf16Column);
        return { line: boundedLine, character: utf16Column };
    }
}

const tokenPositionMappers = new WeakMap<object, TokenPositionMapper>();

function getTokenPositionMapper(token: Token): TokenPositionMapper | undefined {
    try {
        const input = token.getInputStream();
        if (!input || typeof input !== 'object') {
            return undefined;
        }

        let mapper = tokenPositionMappers.get(input);
        if (!mapper) {
            mapper = new TokenPositionMapper(input.toString());
            tokenPositionMappers.set(input, mapper);
        }
        return mapper;
    } catch {
        return undefined;
    }
}

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
    const line = Math.max(token.line - 1, 0);
    return getTokenPositionMapper(token)?.position(line, token.column) ?? {
        line,
        character: Math.max(token.column, 0),
    };
}

export function rangeForTokenOffsets(token: Token, startOffset: number, endOffset: number): Range {
    return rangeForTextOffsets(tokenStartPosition(token), token.text, startOffset, endOffset);
}
