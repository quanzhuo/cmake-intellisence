const HEADING_LEVELS: Record<string, number> = {
    '=': 1,
    '-': 2,
    '^': 3,
    '~': 4,
    '"': 5,
};

const CODE_BLOCK_DIRECTIVES = new Set(['code-block', 'code']);
const CODE_SPAN_ROLES = new Set([
    'cmake:command',
    'cmake:genex',
    'command',
    'envvar',
    'file',
    'genex',
    'module',
    'policy',
    'prop_cache',
    'prop_dir',
    'prop_gbl',
    'prop_inst',
    'prop_sf',
    'prop_test',
    'prop_tgt',
    'property',
    'target',
    'variable',
]);
const ADMONITION_LABELS: Record<string, string> = {
    attention: 'Attention',
    caution: 'Caution',
    danger: 'Danger',
    error: 'Error',
    hint: 'Hint',
    important: 'Important',
    note: 'Note',
    seealso: 'See also',
    tip: 'Tip',
    warning: 'Warning',
};

function normalizeInline(text: string): string {
    return text
        .replace(/``([^`]+)``/g, '`$1`')
        .replace(/:([a-zA-Z0-9:_-]+):`([^`]+)`/g, (_, role: string, value: string) => {
            const display = extractRoleText(value);
            return shouldWrapRoleInCode(role) ? `\`${display}\`` : display;
        })
        .replace(/\|([A-Za-z0-9_+-]+)\|/g, '$1');
}

function extractRoleText(value: string): string {
    const trimmed = value.trim();
    const explicitTitle = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
    if (explicitTitle) {
        return explicitTitle[1].trim() || explicitTitle[2].trim();
    }
    return trimmed;
}

function shouldWrapRoleInCode(role: string): boolean {
    return CODE_SPAN_ROLES.has(role);
}

function getUnderlineChar(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed.length < 3) {
        return null;
    }
    const marker = trimmed[0];
    if (!Object.prototype.hasOwnProperty.call(HEADING_LEVELS, marker)) {
        return null;
    }
    return Array.from(trimmed).every(char => char === marker) ? marker : null;
}

function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') {
        start++;
    }
    while (end > start && lines[end - 1].trim() === '') {
        end--;
    }
    return lines.slice(start, end);
}

function collectIndentedBlock(lines: string[], start: number): { lines: string[]; nextIndex: number; } {
    const collected: string[] = [];
    let index = start;

    while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') {
            collected.push('');
            index++;
            continue;
        }
        if (!/^[ \t]+/.test(line)) {
            break;
        }
        collected.push(line);
        index++;
    }

    const trimmed = trimBlankEdges(collected);
    const indents = trimmed
        .filter(line => line.trim() !== '')
        .map(line => line.match(/^[ \t]+/)?.[0].length ?? 0);
    const minIndent = indents.length === 0 ? 0 : Math.min(...indents);

    return {
        lines: trimmed.map(line => line.trim() === '' ? '' : line.slice(minIndent)),
        nextIndex: index,
    };
}

function emitAdmonition(label: string, inlineText: string, bodyLines: string[]): string[] {
    const content = trimBlankEdges([inlineText, ...bodyLines]);
    if (content.length === 0) {
        return [`> **${label}:**`];
    }

    const result: string[] = [];
    let usedTitle = false;
    for (const line of content) {
        if (line.trim() === '') {
            result.push('>');
            continue;
        }

        const normalized = normalizeInline(line.trim());
        if (!usedTitle) {
            result.push(`> **${label}:** ${normalized}`);
            usedTitle = true;
        } else {
            result.push(`> ${normalized}`);
        }
    }

    return result;
}

function emitCodeFence(language: string, bodyLines: string[]): string[] {
    const content = trimBlankEdges(bodyLines);
    if (content.length === 0) {
        return [];
    }

    const fence = language ? `\`\`\`${language}` : '\`\`\`';
    return [fence, ...content, '\`\`\`'];
}

function looksLikeCodeBlock(lines: string[]): boolean {
    const nonEmpty = lines.filter(line => line.trim() !== '');
    if (nonEmpty.length === 0) {
        return false;
    }

    return nonEmpty.every(line => /[()<>\[\]]|^\w[\w.+-]*\(/.test(line.trim()));
}

function collapseAdjacentBlankLines(lines: string[]): string[] {
    const result: string[] = [];
    for (const line of lines) {
        if (line === '' && result[result.length - 1] === '') {
            continue;
        }
        result.push(line);
    }
    while (result.length > 0 && result[0] === '') {
        result.shift();
    }
    while (result.length > 0 && result[result.length - 1] === '') {
        result.pop();
    }
    return result;
}

export function rstToMarkdown(input: string): string {
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    const output: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();
        const nextLine = index + 1 < lines.length ? lines[index + 1] : undefined;

        if (trimmed === '') {
            output.push('');
            continue;
        }

        if (/^\.\.\s+_[^:]+:$/.test(trimmed)) {
            continue;
        }

        if (nextLine !== undefined) {
            const underline = getUnderlineChar(nextLine);
            if (underline) {
                const level = HEADING_LEVELS[underline] ?? 2;
                output.push(`${'#'.repeat(level)} ${normalizeInline(trimmed)}`);
                output.push('');
                index++;
                continue;
            }
        }

        const directiveMatch = trimmed.match(/^\.\.\s+([a-zA-Z0-9_-]+)::\s*(.*)$/);
        if (directiveMatch) {
            const [, directiveName, directiveArg] = directiveMatch;
            const { lines: bodyLines, nextIndex } = collectIndentedBlock(lines, index + 1);
            index = nextIndex - 1;

            if (CODE_BLOCK_DIRECTIVES.has(directiveName)) {
                output.push(...emitCodeFence(directiveArg.trim(), bodyLines));
                output.push('');
                continue;
            }

            if (directiveName === 'versionadded') {
                output.push(...emitAdmonition(`Version added ${directiveArg.trim()}`, '', bodyLines));
                output.push('');
                continue;
            }

            if (directiveName === 'versionchanged') {
                output.push(...emitAdmonition(`Version changed ${directiveArg.trim()}`, '', bodyLines));
                output.push('');
                continue;
            }

            if (directiveName === 'deprecated') {
                output.push(...emitAdmonition(`Deprecated ${directiveArg.trim()}`.trim(), '', bodyLines));
                output.push('');
                continue;
            }

            const admonitionLabel = ADMONITION_LABELS[directiveName];
            if (admonitionLabel) {
                output.push(...emitAdmonition(admonitionLabel, directiveArg.trim(), bodyLines));
                output.push('');
                continue;
            }

            const fallback = trimBlankEdges([directiveArg.trim(), ...bodyLines]).map(entry => normalizeInline(entry));
            output.push(...fallback);
            output.push('');
            continue;
        }

        if (trimmed === '::') {
            const { lines: bodyLines, nextIndex } = collectIndentedBlock(lines, index + 1);
            index = nextIndex - 1;
            output.push(...emitCodeFence('', bodyLines));
            output.push('');
            continue;
        }

        if (trimmed.endsWith('::')) {
            const { lines: bodyLines, nextIndex } = collectIndentedBlock(lines, index + 1);
            index = nextIndex - 1;
            const intro = normalizeInline(trimmed.slice(0, -1));
            if (intro.trim() !== '') {
                output.push(intro);
                output.push('');
            }
            output.push(...emitCodeFence('', bodyLines));
            output.push('');
            continue;
        }

        if (/^[ \t]+/.test(line)) {
            const { lines: bodyLines, nextIndex } = collectIndentedBlock(lines, index);
            index = nextIndex - 1;
            if (looksLikeCodeBlock(bodyLines)) {
                output.push(...emitCodeFence('cmake', bodyLines));
            } else {
                output.push(...bodyLines.map(entry => normalizeInline(entry.trim())));
            }
            output.push('');
            continue;
        }

        output.push(normalizeInline(trimmed));
    }

    return collapseAdjacentBlankLines(output).join('\n');
}