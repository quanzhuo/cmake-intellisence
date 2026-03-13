import { Position, SignatureHelp, SignatureInformation } from 'vscode-languageserver-types';
import * as builtinCmds from './builtin-cmds.json';
import { CMakeCompletionType, getCompletionInfoAtCursor } from './completion';
import { FlatCommand } from './flatCommands';

type SignatureToken = {
    text: string,
    start: number,
    end: number,
};

function getBuiltinSignatures(commandName: string): string[] | null {
    const lowercaseCommandName = commandName.toLowerCase();
    if (commandName in builtinCmds) {
        return (builtinCmds as any)[commandName].sig ?? null;
    }
    if (lowercaseCommandName in builtinCmds) {
        return (builtinCmds as any)[lowercaseCommandName].sig ?? null;
    }
    return null;
}

function tokenizeSignature(label: string): SignatureToken[] {
    const lParen = label.indexOf('(');
    const rParen = label.lastIndexOf(')');
    if (lParen === -1 || rParen <= lParen) {
        return [];
    }

    const tokens: SignatureToken[] = [];
    const text = label.slice(lParen + 1, rParen);
    const tokenPattern = /\S+/g;
    for (const match of text.matchAll(tokenPattern)) {
        const value = match[0];
        if (value === '|' || value === '{' || value === '}') {
            continue;
        }

        const relativeStart = match.index ?? 0;
        const start = lParen + 1 + relativeStart;
        tokens.push({
            text: value,
            start,
            end: start + value.length,
        });
    }

    return tokens;
}

function extractKeywords(label: string): Set<string> {
    const keywords = new Set<string>();
    for (const token of tokenizeSignature(label)) {
        const normalized = token.text.replace(/^[\[({]+|[\])}.,]+$/g, '');
        if (/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
            keywords.add(normalized);
        }
    }
    return keywords;
}

export function createSignatureInformation(label: string): SignatureInformation {
    const tokens = tokenizeSignature(label);
    return {
        label,
        parameters: tokens.map(token => {
            return {
                label: [token.start, token.end] as [number, number],
            };
        }),
        documentation: {
            kind: 'markdown',
            value: `\`\`\`cmdsignature\n${label}\n\`\`\``,
        },
    };
}

export function findActiveArgumentIndex(command: FlatCommand, position: Position): number {
    const args = command.argument_list();
    if (args.length === 0) {
        return 0;
    }

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const startLine = arg.start.line - 1;
        const startColumn = arg.start.column;
        const stopToken = arg.stop ?? arg.start;
        const endLine = stopToken.line - 1;
        const endColumn = stopToken.column + stopToken.text.length;

        if (position.line < startLine || (position.line === startLine && position.character < startColumn)) {
            return index;
        }

        const afterEnd = position.line > endLine || (position.line === endLine && position.character > endColumn);
        if (!afterEnd) {
            return index;
        }
    }

    return args.length - 1;
}

export function findActiveSignature(command: FlatCommand, signatures: string[], activeArgumentIndex: number): number {
    return findActiveSignatureForArgs(command.argument_list().map(arg => arg.getText()), signatures, activeArgumentIndex);
}

export function findActiveSignatureForArgs(argsText: string[], signatures: string[], activeArgumentIndex: number): number {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    signatures.forEach((signature, index) => {
        const keywords = extractKeywords(signature);
        const matchedKeywords = argsText.reduce((count, arg) => count + (keywords.has(arg) ? 1 : 0), 0);
        const parameterCount = Math.max(tokenizeSignature(signature).length, 1);
        const distancePenalty = Math.abs(Math.min(activeArgumentIndex, parameterCount - 1) - activeArgumentIndex);
        const keywordWeight = matchedKeywords * 100;
        const parameterWeight = -parameterCount;
        const score = keywordWeight + parameterWeight - distancePenalty;

        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });

    return bestIndex;
}

export function buildSignatureHelpForInvocation(commandName: string, argsText: string[], activeArgumentIndex: number): SignatureHelp | null {
    const signatures = getBuiltinSignatures(commandName);
    if (!signatures || signatures.length === 0) {
        return null;
    }

    const signatureInfos = signatures.map(createSignatureInformation);
    const activeSignature = findActiveSignatureForArgs(argsText, signatures, activeArgumentIndex);
    const activeParameter = Math.min(activeArgumentIndex, Math.max((signatureInfos[activeSignature].parameters?.length ?? 1) - 1, 0));

    return {
        signatures: signatureInfos,
        activeSignature,
        activeParameter,
    };
}

export function buildSignatureHelp(command: FlatCommand, position: Position, commands: FlatCommand[]): SignatureHelp | null {
    const completionInfo = getCompletionInfoAtCursor(commands, position);
    let activeArgumentIndex = 0;
    if (completionInfo.type === CMakeCompletionType.Argument && completionInfo.index !== undefined) {
        activeArgumentIndex = completionInfo.index;
    } else {
        activeArgumentIndex = findActiveArgumentIndex(command, position);
    }

    return buildSignatureHelpForInvocation(command.ID().getText(), command.argument_list().map(arg => arg.getText()), activeArgumentIndex);
}