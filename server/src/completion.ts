import { CommonTokenStream, Token } from "antlr4";
import * as fs from 'fs';
import * as path from 'path';
import { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionParams, InsertTextFormat, Position } from "vscode-languageserver";
import { URI } from "vscode-uri";
import * as builtinCmds from './builtin-cmds.json';
import { FlatCommand } from "./flatCommands";
import CMakeLexer from "./generated/CMakeLexer";
import { Logger } from "./logging";
import { SymbolIndex, SymbolKind } from "./symbolIndex";

export { builtinCmds };

export enum CMakeCompletionType {
    Command,
    Module,
    Policy,
    Variable,
    Property,
    Argument,
}

export enum CompletionItemType {
    BuiltInCommand,
    BuiltInModule,
    BuiltInPolicy,
    BuiltInProperty,
    BuiltInVariable,

    UserDefinedCommand,
    UserDefinedVariable,
    PkgConfigModules,
}

export interface BuiltinCompletionItemData {
    type: CompletionItemType,
    helpLabel?: string,
}

export type CompletionItemData = CompletionItemType | BuiltinCompletionItemData;

export function getCompletionItemType(data: unknown): CompletionItemType | undefined {
    if (typeof data === 'number') {
        return data;
    }

    if (typeof data === 'object' && data !== null && 'type' in data && typeof (data as { type?: unknown }).type === 'number') {
        return (data as BuiltinCompletionItemData).type;
    }

    return undefined;
}

export function getCompletionHelpLabel(data: unknown): string | undefined {
    if (typeof data === 'object' && data !== null && 'helpLabel' in data && typeof (data as { helpLabel?: unknown }).helpLabel === 'string') {
        return (data as BuiltinCompletionItemData).helpLabel;
    }

    return undefined;
}

export interface CMakeCompletionInfo {
    type: CMakeCompletionType,

    /**
     * if type is CMakeCompletionType.Argument, this field is the current command context
     */
    context?: FlatCommand,

    /**
     * if type is CMakeCompletionType.Argument, this field is the active command name
     */
    command?: string,

    /**
     * if type is CMakeCompletionType.Argument, this field is the current argument index
     */
    index?: number,
    /**
     * fallback argument texts when the command is recovered from lexer tokens instead of the parser tree
     */
    arguments?: string[],

    /**
     * current argument text when recovered from lexer tokens
     */
    currentArgumentText?: string,

    /**
     * zero-based cursor offset inside currentArgumentText when recovered from lexer tokens
     */
    currentArgumentCursorOffset?: number,
}

export interface RecoveredCommandInfo {
    name: string,
    isOnCommandName: boolean,
}

export interface ProjectTargetInfo {
    executables?: Set<string>,
    libraries?: Set<string>,
}

function matchesCompletionQuery(candidate: string, word: string): boolean {
    return candidate.toLowerCase().includes(word.toLowerCase());
}

/**
 * Determines if a given position is within a list of comments.
 *
 * This function performs a binary search on the sorted list of comments to check if the specified position
 * falls within any of the comment ranges.
 *
 * @param pos - The position to check, represented by a `Position` object with `line` and `character` properties.
 * @param comments - An array of `Token` objects representing the comments, each with `line` and `column` properties.
 * @returns `true` if the position is within a comment, `false` otherwise.
 */
export function inComments(pos: Position, comments: Token[]): boolean {
    const targetLine = pos.line + 1; // Token lines are 1-based
    let left = 0;
    let right = comments.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const comment = comments[mid];
        const startLine = comment.line;
        const text = comment.text;
        const isBracket = /^#\[=*\[/.test(text);
        const newlines = isBracket ? (text.match(/\n/g) || []).length : 0;
        const endLine = startLine + newlines;

        if (targetLine < startLine) {
            right = mid - 1;
        } else if (targetLine > endLine) {
            left = mid + 1;
        } else if (targetLine === startLine && pos.character < comment.column) {
            // Cursor is before the comment on its start line
            right = mid - 1;
        } else if (isBracket && targetLine === endLine) {
            // On the last line of a bracket comment — check end column
            const lastNL = newlines > 0 ? text.lastIndexOf('\n') : -1;
            const endCol = lastNL >= 0
                ? (text.length - lastNL - 1)
                : (comment.column + text.length);
            if (pos.character < endCol) {
                return true;
            }
            left = mid + 1;
        } else {
            // Line comment (extends to EOL), interior of multi-line bracket comment,
            // or start line of multi-line bracket comment with cursor after '#'
            return true;
        }
    }

    return false;
}

/**
 * Retrieves the current command context based on the given position.
 * Utilizes binary search to determine if the position falls within the range of any command.
 * 
 * @param contexts - An array of command contexts to search within.
 * @param position - The position to check against the command contexts.
 * @returns The command context if the position is within any command's range, otherwise null.
 */
export function findCommandAtPosition(contexts: FlatCommand[], position: Position): FlatCommand | null {
    if (contexts.length === 0) {
        return null;
    }

    let left = 0, right = contexts.length - 1;
    let mid = 0;

    while (left <= right) {
        mid = Math.floor((left + right) / 2);
        // line is 1-based, column is 0-based in antlr4
        const context = contexts[mid];
        const start = context.start.line - 1;
        const stopToken = context.stop;

        if (!stopToken) {
            const leftMatch = scanCommandAtPosition(contexts, mid - 1, -1, position);
            if (leftMatch) {
                return leftMatch;
            }
            return scanCommandAtPosition(contexts, mid + 1, 1, position);
        }

        const stop = stopToken.line - 1;
        if (position.line >= start && position.line <= stop) {
            return context;
        } else if (position.line < start) {
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }
    return null;
}

function scanCommandAtPosition(contexts: FlatCommand[], startIndex: number, step: -1 | 1, position: Position): FlatCommand | null {
    for (let index = startIndex; index >= 0 && index < contexts.length; index += step) {
        const context = contexts[index];
        if (!context.stop) {
            continue;
        }

        const start = context.start.line - 1;
        const stop = context.stop.line - 1;
        if (position.line >= start && position.line <= stop) {
            return context;
        }

        if (step === -1 && position.line > stop) {
            return null;
        }

        if (step === 1 && position.line < start) {
            return null;
        }
    }

    return null;
}

/**
 * Checks if the cursor position is within the parentheses defined by the given positions.
 *
 * @param position - The current cursor position.
 * @param lParenLine - The line number of the left parenthesis.
 * @param lParenColumn - The column number of the left parenthesis.
 * @param rParenLine - The line number of the right parenthesis.
 * @param rParenColumn - The column number of the right parenthesis.
 * @returns `true` if the cursor is within the parentheses, otherwise `false`.
 */
export function isCursorWithinParentheses(position: Position, lParenLine: number, lParenColumn: number, rParenLine: number, rParenColumn: number): boolean {
    if (position.line < lParenLine || position.line > rParenLine) {
        return false;
    }
    if (position.line === lParenLine && position.character <= lParenColumn) {
        return false;
    }
    if (position.line === rParenLine && position.character > rParenColumn) {
        return false;
    }
    return true;
}

/**
 * Retrieves completion information at the given cursor position within a CMake file context.
 *
 * @param tree - The CMake file context containing the command list.
 * @param pos - The cursor position for which to retrieve completion information.
 * @returns An object containing the type of completion (command or argument) and additional context if applicable.
 *
 * The function determines if the cursor is within a command's parentheses and identifies the current argument index if so.
 * If the cursor is not within any command's parentheses, it returns a completion type of `Command`.
 */
export function getCompletionInfoAtCursor(commands: FlatCommand[], pos: Position, tokenStream?: CommonTokenStream): CMakeCompletionInfo {
    const currentCommand = findCommandAtPosition(commands, pos);
    if (currentCommand === null) {
        if (tokenStream) {
            const fallbackInfo = getTokenBasedCompletionInfo(tokenStream.tokens, pos);
            if (fallbackInfo) {
                return fallbackInfo;
            }
        }
        return { type: CMakeCompletionType.Command };
    }

    const lParen = currentCommand.LP();
    const rParen = currentCommand.RP();
    if (lParen === null || rParen === null) {
        return { type: CMakeCompletionType.Command };
    }
    // line is 1-based, column is 0-based in antlr4
    const lParenLine = lParen.symbol.line - 1;
    const rParenLine = rParen.symbol.line - 1;
    const lParenColumn = lParen.symbol.column;
    const rParenColumn = rParen.symbol.column;

    // Check if the cursor is within the parentheses
    if (isCursorWithinParentheses(pos, lParenLine, lParenColumn, rParenLine, rParenColumn)) {
        // Get the current argument index
        const args = currentCommand.argument_list();
        let index = 0;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            const argStart = arg.start;

            // Check if the cursor is within the current argument
            if (pos.line === argStart.line - 1 && pos.character >= argStart.column && pos.character <= argStart.column + argStart.text.length) {
                const argText = argStart.text;
                for (const variableRange of findVariableRanges(argText, argStart.column)) {
                    if (pos.character >= variableRange.start && pos.character <= variableRange.end) {
                        return { type: CMakeCompletionType.Variable };
                    }
                }
                index = i;
                break;
            }
            // Check if the cursor is before the current argument
            else if (pos.line < argStart.line - 1 || (pos.line === argStart.line - 1 && pos.character < argStart.column)) {
                index = i;
                break;
            }
            // If the cursor is after the current argument
            else {
                index = i + 1;
            }
        }
        return { type: CMakeCompletionType.Argument, context: currentCommand, command: currentCommand.ID().symbol.text, index: index };
    } else {
        return { type: CMakeCompletionType.Command };
    }
}

type TokenArgument = {
    text: string,
    line: number,
    column: number,
    endLine: number,
    endColumn: number,
};

type TokenCommand = {
    name: string,
    nameToken: Token,
    lParen: Token,
    rParen?: Token,
    args: TokenArgument[],
};

export function findRecoveredCommandInfoAtPosition(tokenStream: CommonTokenStream | undefined, pos: Position): RecoveredCommandInfo | null {
    if (!tokenStream) {
        return null;
    }

    const command = findTokenCommandAtPosition(tokenStream.tokens, pos, true);
    if (!command) {
        return null;
    }

    return {
        name: command.name,
        isOnCommandName: isPositionWithinToken(pos, command.nameToken),
    };
}

function getTokenBasedCompletionInfo(tokens: Token[], pos: Position): CMakeCompletionInfo | null {
    const currentCommand = findTokenCommandAtPosition(tokens, pos, false);
    if (!currentCommand) {
        return null;
    }

    if (!isCursorWithinOpenCommand(pos, currentCommand) && !isCursorWithinClosedCommand(pos, currentCommand)) {
        return null;
    }

    return getCompletionInfoFromTokenCommand(currentCommand, pos);
}

function findTokenCommandAtPosition(tokens: Token[], pos: Position, allowCommandName: boolean): TokenCommand | null {
    const defaultTokens = tokens.filter(token => token.channel === 0);
    let currentCommand: TokenCommand | null = null;
    let depth = 0;

    for (let index = 0; index < defaultTokens.length; index++) {
        const token = defaultTokens[index];
        if (token.type === Token.EOF) {
            if (currentCommand && (isCursorWithinOpenCommand(pos, currentCommand) || (allowCommandName && isPositionWithinToken(pos, currentCommand.nameToken)))) {
                return currentCommand;
            }
            return null;
        }

        if (!currentCommand) {
            const nextToken = defaultTokens[index + 1];
            if (nextToken?.type === CMakeLexer.LP && token.type !== CMakeLexer.LP && token.type !== CMakeLexer.RP) {
                currentCommand = {
                    name: token.text,
                    nameToken: token,
                    lParen: nextToken,
                    args: [],
                };
                if (allowCommandName && isPositionWithinToken(pos, token)) {
                    return currentCommand;
                }
                depth = 1;
                index++;
            }
            continue;
        }

        if (token.type === CMakeLexer.LP) {
            if (depth === 1) {
                const nestedArg = collectNestedArgument(defaultTokens, index);
                currentCommand.args.push(nestedArg.argument);
                index = nestedArg.lastIndex;
                continue;
            }
            depth++;
            continue;
        }

        if (token.type === CMakeLexer.RP) {
            depth--;
            if (depth === 0) {
                currentCommand.rParen = token;
                if (isCursorWithinClosedCommand(pos, currentCommand) || (allowCommandName && isPositionWithinToken(pos, currentCommand.nameToken))) {
                    return currentCommand;
                }
                currentCommand = null;
            }
            continue;
        }

        if (depth === 1) {
            currentCommand.args.push({
                text: token.text,
                line: token.line - 1,
                column: token.column,
                endLine: token.line - 1,
                endColumn: token.column + token.text.length,
            });
        }
    }

    return null;
}

function collectNestedArgument(tokens: Token[], startIndex: number): { argument: TokenArgument, lastIndex: number } {
    const startToken = tokens[startIndex];
    let depth = 0;
    let endToken = startToken;
    let text = '';

    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type === Token.EOF) {
            return {
                argument: {
                    text,
                    line: startToken.line - 1,
                    column: startToken.column,
                    endLine: endToken.line - 1,
                    endColumn: endToken.column + endToken.text.length,
                },
                lastIndex: index,
            };
        }

        text += token.text;
        endToken = token;
        if (token.type === CMakeLexer.LP) {
            depth++;
        } else if (token.type === CMakeLexer.RP) {
            depth--;
            if (depth === 0) {
                return {
                    argument: {
                        text,
                        line: startToken.line - 1,
                        column: startToken.column,
                        endLine: endToken.line - 1,
                        endColumn: endToken.column + endToken.text.length,
                    },
                    lastIndex: index,
                };
            }
        }
    }

    return {
        argument: {
            text,
            line: startToken.line - 1,
            column: startToken.column,
            endLine: endToken.line - 1,
            endColumn: endToken.column + endToken.text.length,
        },
        lastIndex: tokens.length - 1,
    };
}

function isCursorWithinClosedCommand(pos: Position, command: TokenCommand): boolean {
    const lParenLine = command.lParen.line - 1;
    const rParenLine = command.rParen ? command.rParen.line - 1 : lParenLine;
    const rParenColumn = command.rParen ? command.rParen.column : command.lParen.column;
    return isCursorWithinParentheses(pos, lParenLine, command.lParen.column, rParenLine, rParenColumn);
}

function isCursorWithinOpenCommand(pos: Position, command: TokenCommand): boolean {
    const lParenLine = command.lParen.line - 1;
    if (pos.line < lParenLine) {
        return false;
    }
    if (pos.line === lParenLine && pos.character <= command.lParen.column) {
        return false;
    }
    return true;
}

function isPositionWithinToken(pos: Position, token: Token): boolean {
    const line = token.line - 1;
    return pos.line === line && pos.character >= token.column && pos.character <= token.column + token.text.length;
}

function getCompletionInfoFromTokenCommand(command: TokenCommand, pos: Position): CMakeCompletionInfo {
    const argumentTexts = command.args.map(arg => arg.text);
    let index = 0;

    for (let argIndex = 0; argIndex < command.args.length; argIndex++) {
        const arg = command.args[argIndex];
        const isWithinLine = pos.line === arg.line || pos.line === arg.endLine;
        if (isWithinLine && pos.line === arg.line && pos.character >= arg.column && pos.character <= arg.endColumn) {
            for (const variableRange of findVariableRanges(arg.text, arg.column)) {
                if (pos.character >= variableRange.start && pos.character <= variableRange.end) {
                    return {
                        type: CMakeCompletionType.Variable,
                        command: command.name,
                        arguments: argumentTexts,
                        currentArgumentText: arg.text,
                        currentArgumentCursorOffset: Math.max(0, pos.character - arg.column),
                    };
                }
            }
            return {
                type: CMakeCompletionType.Argument,
                command: command.name,
                index: argIndex,
                arguments: argumentTexts,
                currentArgumentText: arg.text,
                currentArgumentCursorOffset: Math.max(0, pos.character - arg.column),
            };
        }

        if (pos.line < arg.line || (pos.line === arg.line && pos.character < arg.column)) {
            index = argIndex;
            return { type: CMakeCompletionType.Argument, command: command.name, index, arguments: argumentTexts };
        }

        index = argIndex + 1;
    }

    return { type: CMakeCompletionType.Argument, command: command.name, index, arguments: argumentTexts };
}

function findVariableRanges(argText: string, baseColumn: number): Array<{ start: number, end: number }> {
    const ranges: Array<{ start: number, end: number }> = [];
    for (let index = 0; index < argText.length - 1; index++) {
        if (argText[index] !== '$' || argText[index + 1] !== '{') {
            continue;
        }

        const closingBraceIndex = argText.indexOf('}', index + 2);
        if (closingBraceIndex === -1) {
            break;
        }

        ranges.push({
            start: baseColumn + index + 2,
            end: baseColumn + closingBraceIndex,
        });
        index = closingBraceIndex;
    }

    return ranges;
}

export const CONDITION_UNARY_KEYWORDS = [
    'COMMAND',
    'POLICY',
    'TARGET',
    'TEST',
    'DEFINED',
    'EXISTS',
    'IS_READABLE',
    'IS_WRITABLE',
    'IS_EXECUTABLE',
    'IS_DIRECTORY',
    'IS_SYMLINK',
    'IS_ABSOLUTE',
];

export const CONDITION_BINARY_KEYWORDS = [
    'IN_LIST',
    'IS_NEWER_THAN',
    'MATCHES',
    'LESS',
    'GREATER',
    'EQUAL',
    'LESS_EQUAL',
    'GREATER_EQUAL',
    'STRLESS',
    'STRGREATER',
    'STREQUAL',
    'STRLESS_EQUAL',
    'STRGREATER_EQUAL',
    'VERSION_LESS',
    'VERSION_GREATER',
    'VERSION_EQUAL',
    'VERSION_LESS_EQUAL',
    'VERSION_GREATER_EQUAL',
    'PATH_EQUAL',
];

export const CONDITION_CONSTANTS = ['1', '0', 'ON', 'OFF', 'YES', 'NO', 'TRUE', 'FALSE', 'Y', 'N', 'IGNORE', 'NOTFOUND'];
export const CONDITION_FILE_UNARY_KEYWORDS = ['EXISTS', 'IS_READABLE', 'IS_WRITABLE', 'IS_EXECUTABLE', 'IS_DIRECTORY', 'IS_SYMLINK', 'IS_ABSOLUTE'];

export type ConditionExpectation =
    | 'operand'
    | 'operator'
    | 'command-name'
    | 'policy-id'
    | 'target-name'
    | 'test-name'
    | 'defined-name'
    | 'file-path'
    | 'list-variable';

function splitConditionArgTokens(arg: string): string[] {
    const tokens: string[] = [];
    let current = '';

    for (const char of arg) {
        if (char === '(' || char === ')') {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            tokens.push(char);
            continue;
        }

        current += char;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

function tokenizeConditionArgs(args: string[], currentIndex: number): string[] {
    return args
        .slice(0, currentIndex)
        .flatMap(arg => splitConditionArgTokens(arg))
        .filter(token => token.length > 0);
}

export function getConditionExpectation(args: string[], currentIndex: number): ConditionExpectation {
    const tokens = tokenizeConditionArgs(args, currentIndex);
    let expectsOperand = true;
    let pendingUnary: string | null = null;
    let pendingBinary: string | null = null;

    for (const rawToken of tokens) {
        const token = rawToken.toUpperCase();

        if (rawToken === '(') {
            expectsOperand = true;
            pendingUnary = null;
            pendingBinary = null;
            continue;
        }

        if (rawToken === ')') {
            expectsOperand = false;
            pendingUnary = null;
            pendingBinary = null;
            continue;
        }

        if (pendingUnary) {
            expectsOperand = false;
            pendingUnary = null;
            continue;
        }

        if (pendingBinary) {
            expectsOperand = false;
            pendingBinary = null;
            continue;
        }

        if (expectsOperand) {
            if (token === 'NOT') {
                continue;
            }

            if (CONDITION_UNARY_KEYWORDS.includes(token)) {
                pendingUnary = token;
                continue;
            }

            expectsOperand = false;
            continue;
        }

        if (token === 'AND' || token === 'OR') {
            expectsOperand = true;
            continue;
        }

        if (CONDITION_BINARY_KEYWORDS.includes(token)) {
            pendingBinary = token;
            expectsOperand = true;
            continue;
        }
    }

    if (pendingUnary === 'COMMAND') {
        return 'command-name';
    }
    if (pendingUnary === 'POLICY') {
        return 'policy-id';
    }
    if (pendingUnary === 'TARGET') {
        return 'target-name';
    }
    if (pendingUnary === 'TEST') {
        return 'test-name';
    }
    if (pendingUnary === 'DEFINED') {
        return 'defined-name';
    }
    if (pendingUnary && CONDITION_FILE_UNARY_KEYWORDS.includes(pendingUnary)) {
        return 'file-path';
    }

    if (pendingBinary === 'IN_LIST') {
        return 'list-variable';
    }
    if (pendingBinary === 'IS_NEWER_THAN' || pendingBinary === 'PATH_EQUAL') {
        return 'file-path';
    }
    if (pendingBinary) {
        return 'operand';
    }

    return expectsOperand ? 'operand' : 'operator';
}

function uniqueCompletionItems(items: CompletionItem[]): CompletionItem[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const key = `${item.label}|${item.kind ?? -1}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

const GENERATOR_EXPRESSION_NAMES = [
    'BOOL',
    'IF',
    'AND',
    'OR',
    'NOT',
    'CONFIG',
    'TARGET_EXISTS',
    'TARGET_NAME_IF_EXISTS',
    'TARGET_PROPERTY',
    'TARGET_FILE',
    'TARGET_FILE_NAME',
    'TARGET_FILE_DIR',
    'TARGET_IMPORT_FILE',
    'TARGET_IMPORT_FILE_NAME',
    'TARGET_IMPORT_FILE_DIR',
    'TARGET_LINKER_FILE',
    'TARGET_LINKER_FILE_NAME',
    'TARGET_LINKER_FILE_DIR',
    'STRING',
    'LIST',
    'PATH',
    'COMPILE_LANGUAGE',
    'LINK_LANGUAGE',
    'C_COMPILER_ID',
    'CXX_COMPILER_ID',
    'VERSION_LESS',
    'VERSION_GREATER',
    'VERSION_EQUAL',
    'VERSION_LESS_EQUAL',
    'VERSION_GREATER_EQUAL',
];

const GENERATOR_EXPRESSION_CONFIGS = ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'];
const GENERATOR_EXPRESSION_LANGUAGES = ['C', 'CXX', 'CUDA', 'OBJC', 'OBJCXX', 'Fortran', 'HIP', 'ISPC'];
const GENERATOR_EXPRESSION_COMPILER_IDS = ['GNU', 'Clang', 'AppleClang', 'MSVC', 'Intel', 'IntelLLVM', 'NVIDIA', 'ARMClang'];
const GENERATOR_EXPRESSION_STRING_SUBCOMMANDS = ['LENGTH', 'SUBSTRING', 'FIND', 'MATCH', 'JOIN', 'ASCII', 'TIMESTAMP', 'RANDOM', 'UUID', 'REPLACE', 'APPEND', 'PREPEND', 'TOLOWER', 'TOUPPER', 'STRIP', 'QUOTE', 'HEX', 'HASH', 'MAKE_C_IDENTIFIER'];
const GENERATOR_EXPRESSION_LIST_SUBCOMMANDS = ['LENGTH', 'GET', 'SUBLIST', 'FIND', 'JOIN', 'APPEND', 'PREPEND', 'INSERT', 'POP_BACK', 'POP_FRONT', 'REMOVE_ITEM', 'REMOVE_AT', 'REMOVE_DUPLICATES', 'FILTER', 'TRANSFORM', 'REVERSE', 'SORT'];
const GENERATOR_EXPRESSION_PATH_SUBCOMMANDS = ['HAS_ROOT_NAME', 'HAS_ROOT_DIRECTORY', 'HAS_ROOT_PATH', 'HAS_FILENAME', 'HAS_EXTENSION', 'HAS_STEM', 'HAS_RELATIVE_PART', 'HAS_PARENT_PATH', 'IS_ABSOLUTE', 'IS_RELATIVE', 'IS_PREFIX', 'GET_ROOT_NAME', 'GET_ROOT_DIRECTORY', 'GET_ROOT_PATH', 'GET_FILENAME', 'GET_EXTENSION', 'GET_STEM', 'GET_RELATIVE_PART', 'GET_PARENT_PATH', 'CMAKE_PATH', 'NATIVE_PATH', 'APPEND', 'REMOVE_FILENAME', 'REPLACE_FILENAME', 'REMOVE_EXTENSION', 'REPLACE_EXTENSION', 'NORMAL_PATH', 'RELATIVE_PATH', 'ABSOLUTE_PATH'];
const GENERATOR_EXPRESSION_HASH_ALGORITHMS = ['ALGORITHM:MD5', 'ALGORITHM:SHA1', 'ALGORITHM:SHA224', 'ALGORITHM:SHA256', 'ALGORITHM:SHA384', 'ALGORITHM:SHA512', 'ALGORITHM:SHA3_224', 'ALGORITHM:SHA3_256', 'ALGORITHM:SHA3_384', 'ALGORITHM:SHA3_512'];
const GENERATOR_EXPRESSION_STRING_MATCH_OPTIONS = ['SEEK:ONCE', 'SEEK:ALL'];
const GENERATOR_EXPRESSION_STRING_REPLACE_OPTIONS = ['STRING', 'REGEX'];
const GENERATOR_EXPRESSION_STRING_STRIP_OPTIONS = ['SPACES'];
const GENERATOR_EXPRESSION_STRING_QUOTE_OPTIONS = ['REGEX'];
const GENERATOR_EXPRESSION_STRING_TIMESTAMP_OPTIONS = ['UTC'];
const GENERATOR_EXPRESSION_STRING_UUID_OPTIONS = ['NAMESPACE:', 'TYPE:MD5', 'TYPE:SHA1', 'NAME:', 'CASE:LOWER', 'CASE:UPPER'];
const GENERATOR_EXPRESSION_STRING_RANDOM_OPTIONS = ['LENGTH:', 'ALPHABET:', 'RANDOM_SEED:'];
const GENERATOR_EXPRESSION_LIST_FILTER_MODES = ['INCLUDE', 'EXCLUDE'];
const GENERATOR_EXPRESSION_LIST_TRANSFORM_ACTIONS = ['APPEND', 'PREPEND', 'TOLOWER', 'TOUPPER', 'STRIP', 'REPLACE'];
const GENERATOR_EXPRESSION_LIST_TRANSFORM_SELECTORS = ['AT', 'FOR', 'REGEX'];
const GENERATOR_EXPRESSION_LIST_SORT_OPTIONS = ['CASE:SENSITIVE', 'CASE:INSENSITIVE', 'COMPARE:STRING', 'COMPARE:FILE_BASENAME', 'COMPARE:NATURAL', 'ORDER:ASCENDING', 'ORDER:DESCENDING'];
const GENERATOR_EXPRESSION_PATH_OPTIONS = ['NORMALIZE'];
const GENERATOR_EXPRESSION_PATH_LAST_ONLY = ['LAST_ONLY'];

type GeneratorExpressionContext = {
    name: string,
    argumentIndex: number,
    currentSegment: string,
    isShorthandConditional?: boolean,
    arguments: string[],
};

function isNamedGeneratorExpression(text: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(text.trim());
}

function splitTopLevelGenexSegments(text: string, separator: ':' | ','): string[] {
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

function getGeneratorExpressionContext(argText: string, cursorOffset: number): GeneratorExpressionContext | null {
    const stack: number[] = [];
    const limit = Math.min(cursorOffset, argText.length);

    for (let index = 0; index < limit; index++) {
        if (argText[index] === '$' && argText[index + 1] === '<') {
            stack.push(index);
            index++;
            continue;
        }

        if (argText[index] === '>' && stack.length > 0) {
            stack.pop();
        }
    }

    const start = stack.at(-1);
    if (start === undefined) {
        return null;
    }

    const insideText = argText.slice(start + 2, limit);
    const colonSegments = splitTopLevelGenexSegments(insideText, ':');

    if (colonSegments.length === 0) {
        return null;
    }

    if (colonSegments.length === 1) {
        return {
            name: '',
            argumentIndex: -1,
            currentSegment: colonSegments[0],
            arguments: [],
        };
    }

    const name = colonSegments[0].trim();
    if (!isNamedGeneratorExpression(name)) {
        return {
            name: '',
            argumentIndex: Math.max(0, colonSegments.length - 2),
            currentSegment: colonSegments.at(-1) ?? '',
            isShorthandConditional: true,
            arguments: colonSegments,
        };
    }

    const argumentText = colonSegments.slice(1).join(':');
    const args = splitTopLevelGenexSegments(argumentText, ',');

    return {
        name,
        argumentIndex: Math.max(0, args.length - 1),
        currentSegment: args.at(-1) ?? '',
        arguments: args,
    };
}

export default class Completion {
    private completionParams?: CompletionParams;

    constructor(
        private flatCommandsMap: Map<string, FlatCommand[]>,
        private tokenStreams: Map<string, CommonTokenStream>,
        private targetInfo: ProjectTargetInfo = {} as ProjectTargetInfo,
        private word: string,
        private logger: Logger,
        private symbolIndex?: SymbolIndex,
        private currentUri?: string,
        private entryUri?: string,
    ) { }

    private getIndexedSymbols(kind: SymbolKind): string[] {
        if (!this.symbolIndex) {
            return [];
        }

        return Array.from(this.symbolIndex.getAllWorkspaceSymbols(kind));
    }

    private getProjectTargetNames(): string[] {
        return Array.from(new Set<string>([
            ...this.getIndexedSymbols(SymbolKind.Target),
            ...this.targetInfo.executables ?? [],
            ...this.targetInfo.libraries ?? [],
        ]));
    }

    private getCommandSuggestion(commandName: string, type: CompletionItemType): CompletionItem {
        let item: CompletionItem;
        switch (commandName) {
            case 'cmake_minimum_required': {
                item = {
                    label: 'cmake_minimum_required',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_minimum_required(VERSION ${1:3.16})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_host_system_information': {
                item = {
                    label: 'cmake_host_system_information',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_host_system_information(RESULT ${1:variable} QUERY ${2:key})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_pkg_config': {
                item = {
                    label: 'cmake_pkg_config',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_pkg_config(EXTRACT ${1:package})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'execute_process': {
                item = {
                    label: 'execute_process',
                    kind: CompletionItemKind.Function,
                    insertText: 'execute_process(COMMAND ${1:command} ${2:args})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'set_directory_properties': {
                item = {
                    label: 'set_directory_properties',
                    kind: CompletionItemKind.Function,
                    insertText: 'set_directory_properties(PROPERTIES ${1:prop1} ${2:value1})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'get_cmake_property': {
                item = {
                    label: 'get_cmake_property',
                    kind: CompletionItemKind.Function,
                    insertText: 'get_cmake_property(${1:variable} ${2:property})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'add_test': {
                item = {
                    label: 'add_test',
                    kind: CompletionItemKind.Function,
                    insertText: 'add_test(NAME ${1:name} COMMAND ${2:command} ${3:args})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_file_api': {
                item = {
                    label: 'cmake_file_api',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_file_api(QUERY API_VERSION ${1:version})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            default:
                item = {
                    label: commandName,
                    kind: CompletionItemKind.Function,
                    insertText: `${commandName}($0)`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
        }
        if (commandName in builtinCmds) {
            if ("deprecated" in (builtinCmds as any)[commandName]) {
                item.tags = [CompletionItemTag.Deprecated];
            }
        }
        return item;
    }

    private getCommandSuggestions(word: string): CompletionItem[] {
        const userFunctions = new Set<string>(this.getIndexedSymbols(SymbolKind.Function));
        const userMacros = new Set<string>(this.getIndexedSymbols(SymbolKind.Macro));

        const internalCommands = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinCommand))
            : [];
        const allCommands = [
            ...internalCommands.map(value => { return { name: value, type: CompletionItemType.BuiltInCommand }; }),
            ...Array.from(userFunctions).map(value => { return { name: value, type: CompletionItemType.UserDefinedCommand }; }),
            ...Array.from(userMacros).map(value => { return { name: value, type: CompletionItemType.UserDefinedCommand }; }),
        ];
        const similarCmds = allCommands.filter(cmd => { return cmd.name.toLowerCase().includes(word.toLowerCase()); });
        const similarNames = similarCmds.map(cmd => cmd.name);
        const suggestedCommands: CompletionItem[] = similarCmds.map((command, index, array) => {
            return this.getCommandSuggestion(command.name, command.type);
        });

        if (similarNames.includes('block')) {
            suggestedCommands.push({
                label: 'block ... endblock',
                kind: CompletionItemKind.Snippet,
                insertText: 'block(${1:name})\n\t${0}\nendblock()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        if (similarNames.includes('if')) {
            suggestedCommands.push({
                label: 'if ... endif',
                kind: CompletionItemKind.Snippet,
                insertText: 'if(${1:condition})\n\t${0}\nendif()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        if (similarNames.includes('foreach')) {
            suggestedCommands.push({
                label: 'foreach ... endforeach',
                kind: CompletionItemKind.Snippet,
                insertText: 'foreach(${1:item} ${2:items})\n\t${0}\nendforeach()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        if (similarNames.includes('while')) {
            suggestedCommands.push({
                label: 'while ... endwhile',
                kind: CompletionItemKind.Snippet,
                insertText: 'while(${1:condition})\n\t${0}\nendwhile()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        if (similarNames.includes('function')) {
            suggestedCommands.push({
                label: 'function ... endfunction',
                kind: CompletionItemKind.Snippet,
                insertText: 'function(${1:name} ${2:args})\n\t${0}\nendfunction()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        if (similarNames.includes('macro')) {
            suggestedCommands.push({
                label: 'macro ... endmacro',
                kind: CompletionItemKind.Snippet,
                insertText: 'macro(${1:name} ${2:args})\n\t${0}\nendmacro()',
                insertTextFormat: InsertTextFormat.Snippet,
            });
        }

        return suggestedCommands;
    }

    private getCommandNameSuggestions(word: string): CompletionItem[] {
        const internalCommands = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinCommand))
            : [];
        const commandNames = Array.from(new Set<string>([
            ...internalCommands,
            ...this.getIndexedSymbols(SymbolKind.Function),
            ...this.getIndexedSymbols(SymbolKind.Macro),
        ])).filter(name => matchesCompletionQuery(name, word));

        return commandNames.map(name => {
            return {
                label: name,
                kind: CompletionItemKind.Function,
            };
        });
    }

    private getModuleSuggestions(word: string, mode: 'include' | 'find_package'): CompletionItem[] {
        const modules = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.Module))
            : [];
        const relevantModules = modules.filter(candidate => {
            return mode === 'find_package'
                ? candidate.startsWith('Find')
                : !candidate.startsWith('Find');
        });

        const similar = relevantModules.filter(candidate => {
            const label = mode === 'find_package' ? candidate.substring(4) : candidate;
            return matchesCompletionQuery(candidate, word) || matchesCompletionQuery(label, word);
        });

        const proposals: CompletionItem[] = similar.map((value) => {
            const label = mode === 'find_package' ? value.substring(4) : value;
            return {
                label,
                insertText: label,
                filterText: mode === 'find_package' ? `${label} ${value}` : value,
                kind: CompletionItemKind.Module,
                data: mode === 'find_package'
                    ? { type: CompletionItemType.BuiltInModule, helpLabel: value }
                    : CompletionItemType.BuiltInModule,
            };
        });

        return proposals;
    }

    private async getFileSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
        if (!this.completionParams) {
            return null;
        }

        const uri: URI = URI.parse(this.completionParams.textDocument.uri);
        const curDir = path.dirname(uri.fsPath);
        // Get the directory part and the filter part from the word
        const lastSlashIndex = word.lastIndexOf('/');
        const dir = path.join(curDir, word.substring(0, lastSlashIndex + 1));
        const filter = word.substring(lastSlashIndex + 1);

        // Read the directory contents
        const files = await new Promise<string[]>((resolve, reject) => {
            fs.readdir(dir, (err: NodeJS.ErrnoException | null, files: string[]) => {
                if (err) {
                    this.logger.error(`Error reading directory ${dir}: ${err.message}`);
                    resolve([]);
                } else {
                    resolve(files);
                }
            });
        });

        // Filter the files based on the filter part
        const filteredFiles = files.filter(file => file.includes(filter));

        // Create completion items
        const suggestions: CompletionItem[] = await Promise.all(filteredFiles.map(async (file) => {
            const filePath = path.join(dir, file);
            const stat = await fs.promises.stat(filePath);
            return {
                label: file,
                kind: stat.isDirectory() ? CompletionItemKind.Folder : CompletionItemKind.File,
            };
        }));

        return suggestions;
    }

    private getVariableSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const userVariables = new Set<string>();

        if (this.symbolIndex && this.entryUri && this.currentUri) {
            const visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryUri, this.currentUri);
            if (!visibleFiles.includes(this.currentUri)) {
                visibleFiles.push(this.currentUri);
            }
            for (const uri of visibleFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (cache) {
                    for (const varName of cache.variables.keys()) {
                        userVariables.add(varName);
                    }
                }
            }
        }

        const variables = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.BuiltinVariable))
            : [];
        let similar = variables.filter(candidate => {
            return matchesCompletionQuery(candidate, word);
        });

        let similarEnv = process.env ? Object.keys(process.env).filter(candidate => {
            return matchesCompletionQuery(candidate, word);
        }) : [];

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Variable,
                data: CompletionItemType.BuiltInVariable,
            };
        });

        const envVariables: CompletionItem[] = similarEnv.map((value, index, array) => {
            return {
                label: `ENV{${value}}`,
                kind: CompletionItemKind.Variable,
            };
        });

        const userVarSuggestions: CompletionItem[] = Array.from(userVariables)
            .filter(v => matchesCompletionQuery(v, word))
            .map(value => {
                return {
                    label: value,
                    kind: CompletionItemKind.Variable,
                    data: CompletionItemType.UserDefinedVariable,
                };
            });

        return [...suggestions, ...envVariables, ...userVarSuggestions];
    }

    private getTargetsSuggestion(info: CMakeCompletionInfo): CompletionItem[] | undefined {
        const targets = this.getProjectTargetNames();
        if (targets.length > 0) {
            return targets.map((target) => {
                return {
                    label: target,
                    kind: CompletionItemKind.Variable,
                };
            });
        }
    }

    private getPropertySuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const properties = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.Property))
            : [];
        let similar = properties.filter(candidate => {
            return matchesCompletionQuery(candidate, word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Property,
                data: CompletionItemType.BuiltInProperty,
            };
        });

        return suggestions;
    }

    private pkgCheckModulesSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        if (info.index === 0) {
            return [];
        }

        const keywords = ['REQUIRED', 'QUIET', 'NO_CMAKE_PATH', 'NO_CMAKE_ENVIRONMENT_PATH', 'IMPORTED_TARGET', 'GLOBAL',];
        const pkgConfigModules = this.symbolIndex?.pkgConfigModules.keys() ?? [];
        const items = [...keywords, ...pkgConfigModules];
        const similar = items.filter(candidate => {
            return matchesCompletionQuery(candidate, word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Unit,
                data: CompletionItemType.PkgConfigModules,
            };
        });
        return suggestions;
    }

    private async getArgumentSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
        const args = info.context?.argument_list().map(arg => arg.getText()) ?? info.arguments ?? [];
        const propertyKeywordIndex = this.getPropertyKeywordIndex(args);

        if (this.completionParams && info.index !== undefined) {
            const currentArgument = info.context?.argument(info.index);
            const argText = currentArgument?.getText() ?? info.currentArgumentText;
            const cursorOffset = currentArgument
                ? this.completionParams.position.character - currentArgument.start.column
                : info.currentArgumentCursorOffset;

            if (argText !== undefined && cursorOffset !== undefined) {
                const genexSuggestions = await this.getGeneratorExpressionSuggestions(info, word, argText, cursorOffset);
                if (genexSuggestions) {
                    return genexSuggestions;
                }
            }
        }

        if (info.command === 'if' || info.command === 'elseif' || info.command === 'while') {
            return this.getConditionSuggestions(info, word);
        }

        switch (info.command) {
            case 'find_package': {
                if (info.index === 0) {
                    return this.getModuleSuggestions(word, 'find_package');
                }
                break;
            }
            case 'include': {
                if (info.index === 0) {
                    return this.getModuleSuggestions(word, 'include');
                }
                break;
            }
            case 'cmake_policy': {
                if (info.index === 1) {
                    const firstArg = info.context?.argument(0)?.getText() ?? args[0];
                    if (firstArg === 'GET' || firstArg === 'SET') {
                        return this.getPolicySuggestions(info, word);
                    }
                }
                break;
            }
            case 'target_compile_definitions':
            case 'target_compile_features':
            case 'target_compile_options':
            case 'target_include_directories':
            case 'target_link_directories':
            case 'target_link_options':
            case 'target_precompile_headers':
            case 'target_sources': {
                if (info.index === 0) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                }
                break;
            }
            case 'target_link_libraries': {
                if (info.index === 0) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                } else {
                    const items = [
                        ...this.getProjectTargetNames(),
                        'PRIVATE', 'PUBLIC', 'INTERFACE',
                        'LINK_INTERFACE_LIBRARIES',
                        'LINK_PRIVATE',
                        'LINK_PUBLIC',
                    ];
                    if (items.length > 0) {
                        return items.map((lib) => {
                            return {
                                label: lib,
                                kind: CompletionItemKind.Variable,
                            };
                        });
                    }
                }
                break;
            }
            case 'get_property':
            case 'set_property':
            case 'define_property': {
                if (this.isPropertyNamePosition(args, info.index, propertyKeywordIndex)) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'get_target_property': {
                if (info.index === 1) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                } else if (info.index === 2) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'get_cmake_property':
            case 'get_test_property': {

                if (info.index === 1) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'set_directory_properties':
            case 'set_target_properties':
            case 'set_tests_properties':
            case 'set_source_files_properties': {
                if (this.isPropertyNamePosition(args, info.index, propertyKeywordIndex)) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'pkg_check_modules': {
                return this.pkgCheckModulesSuggestions(info, word);
            }
            case 'get_directory_property': {
                if (info.index === 1) {
                    const arg1 = args[1];
                    if (arg1 !== 'DIRECTORY' && arg1 !== 'DEFINITION') {
                        return [
                            ...this.getPropertySuggestions(info, word),
                            ...this.getKeywordSuggestions(['DIRECTORY', 'DEFINITION'], word),
                        ];
                    }
                } else if (info.index === 3 && args[1] === 'DIRECTORY') {
                    return [
                        ...this.getPropertySuggestions(info, word),
                        ...this.getKeywordSuggestions(['DEFINITION'], word),
                    ];
                }
                break;
            }
            case 'get_source_file_property': {
                if (info.index === 2) {
                    const arg2 = args[2];
                    if (arg2 !== 'DIRECTORY' && arg2 !== 'TARGET_DIRECTORY') {
                        return [
                            ...this.getPropertySuggestions(info, word),
                            ...this.getKeywordSuggestions(['DIRECTORY', 'TARGET_DIRECTORY'], word),
                        ];
                    }
                } else if (info.index === 4 && (args[2] === 'DIRECTORY' || args[2] === 'TARGET_DIRECTORY')) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'set': {
                if (info.index === 0) {
                    return this.getVariableSuggestions(info, word);
                }
                break;
            }
            default:
                break;
        }

        if (info.command && !(info.command in builtinCmds)) {
            return null;
        }

        const keywords: string[] = ((builtinCmds as any)[info.command!]['keyword']) ?? [];
        const argsCompletions = keywords.map((arg) => {
            return {
                label: arg,
                kind: CompletionItemKind.Keyword,
            };
        });
        return [...argsCompletions, ...(await this.getFileSuggestions(info, word) ?? [])];
    }

    private getPolicySuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const policies = this.symbolIndex
            ? Array.from(this.symbolIndex.getAllSystemSymbols(SymbolKind.Policy))
            : [];
        let similar = policies.filter(candidate => {
            return matchesCompletionQuery(candidate, word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Constant,
                data: CompletionItemType.BuiltInPolicy,
            };
        });

        return suggestions;
    }

    private getConditionConstantSuggestions(word: string): CompletionItem[] {
        return CONDITION_CONSTANTS
            .filter(candidate => matchesCompletionQuery(candidate, word))
            .map(value => {
                return {
                    label: value,
                    kind: CompletionItemKind.Constant,
                };
            });
    }

    private getDefinedNameSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const variableSuggestions = this.getVariableSuggestions(info, word);
        const specialSuggestions: CompletionItem[] = [
            {
                label: 'CACHE{}',
                kind: CompletionItemKind.Variable,
                insertText: 'CACHE{${1:name}}',
                insertTextFormat: InsertTextFormat.Snippet,
            },
            {
                label: 'ENV{}',
                kind: CompletionItemKind.Variable,
                insertText: 'ENV{${1:name}}',
                insertTextFormat: InsertTextFormat.Snippet,
            },
        ].filter(item => matchesCompletionQuery(item.label, word) || matchesCompletionQuery(item.insertText as string, word));

        return uniqueCompletionItems([...specialSuggestions, ...variableSuggestions]);
    }

    private getGeneratorExpressionNameSuggestions(word: string): CompletionItem[] {
        return GENERATOR_EXPRESSION_NAMES
            .filter(name => matchesCompletionQuery(name, word))
            .map(name => {
                return {
                    label: name,
                    kind: CompletionItemKind.Function,
                };
            });
    }

    private getSimpleValueSuggestions(values: string[], kind: CompletionItemKind, word: string): CompletionItem[] {
        return values
            .filter(value => matchesCompletionQuery(value, word))
            .map(value => {
                return {
                    label: value,
                    kind,
                };
            });
    }

    private getGeneratorNamespaceSuggestions(values: string[], word: string): CompletionItem[] {
        return this.getSimpleValueSuggestions(values, CompletionItemKind.EnumMember, word);
    }

    private async getGeneratorExpressionSuggestions(info: CMakeCompletionInfo, word: string, argText: string, cursorOffset: number): Promise<CompletionItem[] | null> {
        const context = getGeneratorExpressionContext(argText, cursorOffset);
        if (!context) {
            return null;
        }

        const currentWord = context.currentSegment || word;
        if (context.argumentIndex === -1) {
            return this.getGeneratorExpressionNameSuggestions(currentWord);
        }

        if (context.isShorthandConditional) {
            if (context.argumentIndex === 0) {
                return uniqueCompletionItems([
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                    ...this.getKeywordSuggestions([...CONDITION_UNARY_KEYWORDS, 'NOT'], currentWord),
                    ...this.getConditionConstantSuggestions(currentWord),
                    ...this.getVariableSuggestions(info, currentWord),
                ]);
            }

            return uniqueCompletionItems([
                ...this.getVariableSuggestions(info, currentWord),
                ...this.getGeneratorExpressionNameSuggestions(currentWord),
            ]);
        }

        switch (context.name.toUpperCase()) {
            case 'CONFIG':
                return this.getSimpleValueSuggestions(GENERATOR_EXPRESSION_CONFIGS, CompletionItemKind.EnumMember, currentWord);
            case 'BOOL':
                return uniqueCompletionItems([
                    ...this.getConditionConstantSuggestions(currentWord),
                    ...this.getVariableSuggestions(info, currentWord),
                ]);
            case 'IF':
                if (context.argumentIndex === 0) {
                    return uniqueCompletionItems([
                        ...this.getGeneratorExpressionNameSuggestions(currentWord),
                        ...this.getConditionConstantSuggestions(currentWord),
                        ...this.getVariableSuggestions(info, currentWord),
                    ]);
                }
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, currentWord),
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                ]);
            case 'AND':
            case 'OR':
            case 'NOT':
                return uniqueCompletionItems([
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                    ...this.getConditionConstantSuggestions(currentWord),
                    ...this.getVariableSuggestions(info, currentWord),
                ]);
            case 'TARGET_EXISTS':
            case 'TARGET_NAME_IF_EXISTS':
            case 'TARGET_FILE':
            case 'TARGET_FILE_NAME':
            case 'TARGET_FILE_DIR':
            case 'TARGET_IMPORT_FILE':
            case 'TARGET_IMPORT_FILE_NAME':
            case 'TARGET_IMPORT_FILE_DIR':
            case 'TARGET_LINKER_FILE':
            case 'TARGET_LINKER_FILE_NAME':
            case 'TARGET_LINKER_FILE_DIR':
                return this.getTargetsSuggestion(info) ?? [];
            case 'TARGET_PROPERTY':
                if (context.argumentIndex === 0) {
                    return this.getTargetsSuggestion(info) ?? [];
                }
                return this.getPropertySuggestions(info, currentWord);
            case 'COMPILE_LANGUAGE':
            case 'LINK_LANGUAGE':
                return this.getSimpleValueSuggestions(GENERATOR_EXPRESSION_LANGUAGES, CompletionItemKind.EnumMember, currentWord);
            case 'C_COMPILER_ID':
            case 'CXX_COMPILER_ID':
                return this.getSimpleValueSuggestions(GENERATOR_EXPRESSION_COMPILER_IDS, CompletionItemKind.EnumMember, currentWord);
            case 'STRING': {
                const subcommand = context.arguments[0]?.toUpperCase();
                if (context.argumentIndex === 0) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_SUBCOMMANDS, currentWord);
                }
                if (subcommand === 'MATCH' && context.argumentIndex === 2) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_MATCH_OPTIONS, currentWord);
                }
                if (subcommand === 'REPLACE' && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_REPLACE_OPTIONS, currentWord);
                }
                if (subcommand === 'STRIP' && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_STRIP_OPTIONS, currentWord);
                }
                if (subcommand === 'QUOTE' && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_QUOTE_OPTIONS, currentWord);
                }
                if (subcommand === 'TIMESTAMP' && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_TIMESTAMP_OPTIONS, currentWord);
                }
                if (subcommand === 'UUID' && context.argumentIndex >= 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_UUID_OPTIONS, currentWord);
                }
                if (subcommand === 'RANDOM' && context.argumentIndex >= 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_STRING_RANDOM_OPTIONS, currentWord);
                }
                if (subcommand === 'HASH' && context.argumentIndex >= 2) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_HASH_ALGORITHMS, currentWord);
                }
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, currentWord),
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                ]);
            }
            case 'LIST': {
                const subcommand = context.arguments[0]?.toUpperCase();
                if (context.argumentIndex === 0) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_LIST_SUBCOMMANDS, currentWord);
                }
                if (subcommand === 'FILTER' && context.argumentIndex === 2) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_LIST_FILTER_MODES, currentWord);
                }
                if (subcommand === 'TRANSFORM' && context.argumentIndex === 2) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_LIST_TRANSFORM_ACTIONS, currentWord);
                }
                if (subcommand === 'TRANSFORM' && context.argumentIndex >= 3) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_LIST_TRANSFORM_SELECTORS, currentWord);
                }
                if (subcommand === 'SORT' && context.argumentIndex >= 2) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_LIST_SORT_OPTIONS, currentWord);
                }
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, currentWord),
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                ]);
            }
            case 'PATH': {
                const subcommand = context.arguments[0]?.toUpperCase();
                if (context.argumentIndex === 0) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_PATH_SUBCOMMANDS, currentWord);
                }
                if ((subcommand === 'CMAKE_PATH' || subcommand === 'NATIVE_PATH' || subcommand === 'ABSOLUTE_PATH' || subcommand === 'IS_PREFIX') && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_PATH_OPTIONS, currentWord);
                }
                if ((subcommand === 'GET_EXTENSION' || subcommand === 'GET_STEM' || subcommand === 'REMOVE_EXTENSION' || subcommand === 'REPLACE_EXTENSION') && context.argumentIndex === 1) {
                    return this.getGeneratorNamespaceSuggestions(GENERATOR_EXPRESSION_PATH_LAST_ONLY, currentWord);
                }
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, currentWord),
                    ...(await this.getFileSuggestions(info, currentWord) ?? []),
                    ...this.getGeneratorExpressionNameSuggestions(currentWord),
                ]);
            }
            case 'VERSION_LESS':
            case 'VERSION_GREATER':
            case 'VERSION_EQUAL':
            case 'VERSION_LESS_EQUAL':
            case 'VERSION_GREATER_EQUAL':
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, currentWord),
                    ...this.getConditionConstantSuggestions(currentWord),
                ]);
            default:
                return this.getGeneratorExpressionNameSuggestions(currentWord);
        }
    }

    private async getConditionSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[]> {
        const args = info.context?.argument_list().map(arg => arg.getText()) ?? info.arguments ?? [];
        const expectation = getConditionExpectation(args, info.index ?? 0);

        switch (expectation) {
            case 'command-name':
                return this.getCommandNameSuggestions(word);
            case 'policy-id':
                return this.getPolicySuggestions(info, word);
            case 'target-name':
                return this.getTargetsSuggestion(info) ?? [];
            case 'test-name':
                return [];
            case 'defined-name':
                return this.getDefinedNameSuggestions(info, word);
            case 'list-variable':
                return this.getVariableSuggestions(info, word);
            case 'file-path':
                return uniqueCompletionItems([
                    ...this.getVariableSuggestions(info, word),
                    ...(await this.getFileSuggestions(info, word) ?? []),
                ]);
            case 'operator':
                return this.getKeywordSuggestions([...CONDITION_BINARY_KEYWORDS, 'AND', 'OR'], word);
            case 'operand':
            default:
                return uniqueCompletionItems([
                    ...this.getKeywordSuggestions([...CONDITION_UNARY_KEYWORDS, 'NOT'], word),
                    ...this.getConditionConstantSuggestions(word),
                    ...this.getVariableSuggestions(info, word),
                ]);
        }
    }

    private getKeywordSuggestions(keywords: string[], word: string): CompletionItem[] {
        return keywords
            .filter(keyword => matchesCompletionQuery(keyword, word))
            .map(keyword => {
                return {
                    label: keyword,
                    kind: CompletionItemKind.Keyword,
                };
            });
    }

    private getPropertyKeywordIndex(args: string[]): number {
        for (let index = 0; index < args.length; index++) {
            if (args[index] === 'PROPERTY' || args[index] === 'PROPERTIES') {
                return index;
            }
        }

        return -1;
    }

    private isPropertyNamePosition(args: string[], currentIndex: number | undefined, propertyKeywordIndex: number): boolean {
        if (currentIndex === undefined || propertyKeywordIndex === -1 || currentIndex <= propertyKeywordIndex) {
            return false;
        }

        const keyword = args[propertyKeywordIndex];
        const offset = currentIndex - propertyKeywordIndex;

        if (keyword === 'PROPERTY') {
            return offset === 1;
        }

        return offset % 2 === 1;
    }

    public async onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        this.completionParams = params;
        const tokenStream = this.tokenStreams.get(params.textDocument.uri);
        const fallbackCommands = this.flatCommandsMap.get(params.textDocument.uri);

        if (!tokenStream || !fallbackCommands) {
            return this.getCommandSuggestions(this.word);
        }

        const comments = tokenStream.tokens.filter(token => token.channel === CMakeLexer.channelNames.indexOf("COMMENTS"));

        // if the cursor is in comments, return null
        if (inComments(params.position, comments)) {
            return null;
        }

        const commands = fallbackCommands;
        const info = getCompletionInfoAtCursor(commands, params.position, tokenStream);
        if (info.type === CMakeCompletionType.Command) {
            return this.getCommandSuggestions(this.word);
        } else if (info.type === CMakeCompletionType.Argument) {
            return this.getArgumentSuggestions(info, this.word);
        } else if (info.type === CMakeCompletionType.Variable) {
            return this.getVariableSuggestions(info, this.word);
        }
        return null;
    }
}
