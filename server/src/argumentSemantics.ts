import { Position } from 'vscode-languageserver';
import { FlatCommand } from './flatCommands';

export enum ArgumentSemanticKind {
    Command = 'command',
    Variable = 'variable',
    Target = 'target',
    FilePath = 'file-path',
    IncludeModule = 'include-module',
    FindPackage = 'find-package',
}

export enum DefinitionSubject {
    Command = 'command',
    Variable = 'variable',
    Target = 'target',
    FilePath = 'file-path',
    IncludeModule = 'include-module',
    FindPackage = 'find-package',
}

export interface ArgumentSpan {
    argumentIndex: number;
    text: string;
    start: Position;
    end: Position;
}

export interface ResolvedCursorTarget {
    text: string;
    subject: DefinitionSubject;
    semanticKind: ArgumentSemanticKind;
    argumentSpan: ArgumentSpan | null;
}

const TARGET_LINK_LIBRARY_KEYWORDS = new Set([
    'PRIVATE',
    'PUBLIC',
    'INTERFACE',
    'LINK_INTERFACE_LIBRARIES',
    'LINK_PRIVATE',
    'LINK_PUBLIC',
]);

const ADD_EXECUTABLE_KEYWORDS = new Set(['WIN32', 'MACOSX_BUNDLE', 'EXCLUDE_FROM_ALL', 'IMPORTED', 'ALIAS']);
const ADD_LIBRARY_KEYWORDS = new Set(['STATIC', 'SHARED', 'MODULE', 'OBJECT', 'ALIAS', 'GLOBAL', 'INTERFACE', 'IMPORTED']);
const TARGET_SOURCES_KEYWORDS = new Set(['INTERFACE', 'PUBLIC', 'PRIVATE', 'FILE_SET', 'TYPE', 'BASE_DIRS', 'FILES']);

export function getArgumentSpanAtPosition(command: FlatCommand, pos: Position): ArgumentSpan | null {
    const args = command.argument_list();
    const targetLine = pos.line + 1;

    for (const [index, arg] of args.entries()) {
        const token = arg.start;
        if (!token || token.line !== targetLine) {
            continue;
        }

        const text = arg.getText();
        const startColumn = token.column;
        const endColumn = startColumn + text.length;
        if (pos.character < startColumn || pos.character > endColumn) {
            continue;
        }

        return {
            argumentIndex: index,
            text,
            start: { line: token.line - 1, character: startColumn },
            end: { line: token.line - 1, character: endColumn },
        };
    }

    return null;
}

export function isCommandPosition(command: FlatCommand, word: string, pos: Position): boolean {
    const commandToken = command.ID().symbol;
    if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
        return true;
    }

    const cmdName = commandToken.text.toLowerCase();
    if (cmdName === 'function' || cmdName === 'macro') {
        const args = command.argument_list();
        if (args.length > 0 && args[0].start?.text === word) {
            const token = args[0].start;
            if ((pos.line + 1 === token.line) && (pos.character >= token.column) && (pos.character <= token.column + token.text.length)) {
                return true;
            }
        }
    }

    return false;
}

export function isTargetArgumentIndex(command: FlatCommand, argIndex: number): boolean {
    const args = command.argument_list();
    const argText = args[argIndex]?.getText();
    const commandName = command.ID().symbol.text.toLowerCase();

    switch (commandName) {
        case 'add_executable':
        case 'add_library':
            return argIndex === 0;
        case 'target_compile_definitions':
        case 'target_compile_features':
        case 'target_compile_options':
        case 'target_include_directories':
        case 'target_link_directories':
        case 'target_link_options':
        case 'target_precompile_headers':
        case 'target_sources':
            return argIndex === 0;
        case 'target_link_libraries':
            if (argIndex === 0) {
                return true;
            }

            return !!argText && !TARGET_LINK_LIBRARY_KEYWORDS.has(argText);
        case 'get_target_property':
            return argIndex === 1;
        case 'if':
        case 'elseif':
        case 'while':
            return argIndex > 0 && args[argIndex - 1]?.getText().toUpperCase() === 'TARGET';
        default:
            return false;
    }
}

function isSourceFileArgument(commandName: string, argIndex: number, argText: string): boolean {
    if (argIndex === 0) {
        return false;
    }

    switch (commandName) {
        case 'add_executable':
            return !ADD_EXECUTABLE_KEYWORDS.has(argText);
        case 'add_library':
            return !ADD_LIBRARY_KEYWORDS.has(argText);
        case 'target_sources':
            return !TARGET_SOURCES_KEYWORDS.has(argText);
        default:
            return false;
    }
}

export function getDefinitionSubject(command: FlatCommand, word: string, pos: Position): DefinitionSubject {
    if (isCommandPosition(command, word, pos)) {
        return DefinitionSubject.Command;
    }

    const argumentSpan = getArgumentSpanAtPosition(command, pos);
    if (!argumentSpan) {
        return DefinitionSubject.Variable;
    }

    if (isTargetArgumentIndex(command, argumentSpan.argumentIndex)) {
        return DefinitionSubject.Target;
    }

    const commandName = command.ID().symbol.text.toLowerCase();
    switch (commandName) {
        case 'include':
            if (argumentSpan.argumentIndex === 0) {
                return argumentSpan.text.includes('/') || argumentSpan.text.includes('\\') || argumentSpan.text.includes('${')
                    ? DefinitionSubject.FilePath
                    : DefinitionSubject.IncludeModule;
            }
            break;
        case 'find_package':
            return argumentSpan.argumentIndex === 0 ? DefinitionSubject.FindPackage : DefinitionSubject.Variable;
        case 'add_subdirectory':
            return argumentSpan.argumentIndex === 0 ? DefinitionSubject.FilePath : DefinitionSubject.Variable;
        case 'configure_file':
            return argumentSpan.argumentIndex <= 1 ? DefinitionSubject.FilePath : DefinitionSubject.Variable;
        case 'add_executable':
        case 'add_library':
        case 'target_sources':
            return isSourceFileArgument(commandName, argumentSpan.argumentIndex, argumentSpan.text)
                ? DefinitionSubject.FilePath
                : DefinitionSubject.Variable;
        default:
            return DefinitionSubject.Variable;
    }

    return DefinitionSubject.Variable;
}

export function resolveCursorTarget(command: FlatCommand, word: string, pos: Position): ResolvedCursorTarget {
    const subject = getDefinitionSubject(command, word, pos);
    const argumentSpan = getArgumentSpanAtPosition(command, pos);

    switch (subject) {
        case DefinitionSubject.Command:
            return { text: word, subject, semanticKind: ArgumentSemanticKind.Command, argumentSpan };
        case DefinitionSubject.Target:
            return { text: word, subject, semanticKind: ArgumentSemanticKind.Target, argumentSpan };
        case DefinitionSubject.FilePath:
            return { text: word, subject, semanticKind: ArgumentSemanticKind.FilePath, argumentSpan };
        case DefinitionSubject.IncludeModule:
            return { text: word, subject, semanticKind: ArgumentSemanticKind.IncludeModule, argumentSpan };
        case DefinitionSubject.FindPackage:
            return { text: word, subject, semanticKind: ArgumentSemanticKind.FindPackage, argumentSpan };
        case DefinitionSubject.Variable:
        default:
            return { text: word, subject: DefinitionSubject.Variable, semanticKind: ArgumentSemanticKind.Variable, argumentSpan };
    }
}