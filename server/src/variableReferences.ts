import { SymbolNamespace } from './symbolIndex';

export interface VariableReferenceSpan {
    name: string;
    namespace: Extract<SymbolNamespace, 'variable' | 'cache-variable' | 'environment-variable'>;
    startOffset: number;
    endOffset: number;
}

const OPENINGS: ReadonlyArray<{
    prefix: string;
    namespace: VariableReferenceSpan['namespace'];
}> = [
    { prefix: '$CACHE{', namespace: 'cache-variable' },
    { prefix: '$ENV{', namespace: 'environment-variable' },
    { prefix: '${', namespace: 'variable' },
];

function isEscaped(text: string, offset: number): boolean {
    let backslashCount = 0;
    for (let index = offset - 1; index >= 0 && text[index] === '\\'; index--) {
        backslashCount++;
    }
    return backslashCount % 2 === 1;
}

function findClosingBrace(text: string, contentStart: number): number | null {
    let depth = 1;
    for (let index = contentStart; index < text.length; index++) {
        if (text[index] === '{' && !isEscaped(text, index)) {
            depth++;
        } else if (text[index] === '}' && !isEscaped(text, index)) {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return null;
}

export function findVariableReferences(
    text: string,
    allowsVariableExpansion = true,
): VariableReferenceSpan[] {
    if (!allowsVariableExpansion) {
        return [];
    }

    const references: VariableReferenceSpan[] = [];
    for (let offset = 0; offset < text.length; offset++) {
        if (text[offset] !== '$' || isEscaped(text, offset)) {
            continue;
        }

        const opening = OPENINGS.find(candidate => text.startsWith(candidate.prefix, offset));
        if (!opening) {
            continue;
        }

        const startOffset = offset + opening.prefix.length;
        const closingOffset = findClosingBrace(text, startOffset);
        if (closingOffset === null) {
            continue;
        }

        const name = text.slice(startOffset, closingOffset);
        // A dynamically computed name such as ${${name}} cannot be assigned a
        // stable symbol identity, but its nested references are discovered by
        // subsequent iterations of this loop.
        if (name.length > 0 && !/[${}]/.test(name)) {
            references.push({
                name,
                namespace: opening.namespace,
                startOffset,
                endOffset: closingOffset,
            });
        }
    }

    return references;
}
