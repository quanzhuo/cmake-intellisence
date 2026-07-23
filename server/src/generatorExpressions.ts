export const GENERATOR_EXPRESSION_TARGET_ROOTS: ReadonlySet<string> = new Set([
    'TARGET_EXISTS',
    'TARGET_NAME_IF_EXISTS',
    'TARGET_FILE',
    'TARGET_FILE_NAME',
    'TARGET_FILE_DIR',
    'TARGET_IMPORT_FILE',
    'TARGET_IMPORT_FILE_NAME',
    'TARGET_IMPORT_FILE_DIR',
    'TARGET_LINKER_FILE',
    'TARGET_LINKER_FILE_NAME',
    'TARGET_LINKER_FILE_DIR',
]);

export function isNamedGeneratorExpression(text: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(text.trim());
}

export function splitTopLevelGeneratorExpressionSegments(text: string, separator: ':' | ','): string[] {
    const segments: string[] = [];
    let current = '';
    let depth = 0;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '$' && text[index + 1] === '<') {
            depth++;
            current += '$<';
            index++;
            continue;
        }

        if (char === '>' && depth > 0) {
            depth--;
            current += char;
            continue;
        }

        if (char === separator && depth === 0) {
            segments.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    segments.push(current);
    return segments;
}
