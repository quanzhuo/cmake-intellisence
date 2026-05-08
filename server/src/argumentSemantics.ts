import { Position } from 'vscode-languageserver';
import { FlatCommand } from './flatCommands';

export enum ArgumentSemanticKind {
    Command = 'command',
    Variable = 'variable',
    Target = 'target',
    FilePath = 'file-path',
    Property = 'property',
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

export interface TargetOccurrence {
    text: string;
    startOffset: number;
    endOffset: number;
}

const GENERATOR_EXPRESSION_TARGET_ROOTS = new Set([
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

function isIdentifierCharacter(char: string): boolean {
    return /[a-zA-Z0-9_]/.test(char);
}

function getArgumentOffset(argumentSpan: ArgumentSpan, pos: Position): number {
    return Math.max(0, Math.min(pos.character - argumentSpan.start.character, argumentSpan.text.length));
}

function extractVariableReferenceAtOffset(argumentText: string, offset: number): string | null {
    const matches = argumentText.matchAll(/\$\{([^{}]+)\}/g);
    for (const match of matches) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset >= start && offset <= end) {
            return match[1];
        }
    }

    return null;
}

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

function findTrimmedSegmentRange(text: string, segment: string, searchOffset: number): TargetOccurrence | null {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const startOffset = text.indexOf(trimmed, searchOffset);
    if (startOffset === -1) {
        return null;
    }

    return {
        text: trimmed,
        startOffset,
        endOffset: startOffset + trimmed.length,
    };
}

function getGeneratorExpressionTargetOccurrences(argumentText: string): TargetOccurrence[] {
    const occurrences: TargetOccurrence[] = [];
    const stack: number[] = [];

    for (let index = 0; index < argumentText.length; index++) {
        if (argumentText[index] === '$' && argumentText[index + 1] === '<') {
            stack.push(index);
            index++;
            continue;
        }

        if (argumentText[index] !== '>' || stack.length === 0) {
            continue;
        }

        const start = stack.pop()!;
        const content = argumentText.slice(start + 2, index);
        const colonSegments = splitTopLevelGenexSegments(content, ':');
        if (colonSegments.length <= 1) {
            continue;
        }

        const root = colonSegments[0].trim();
        if (!isNamedGeneratorExpression(root)) {
            continue;
        }

        const argumentPortion = colonSegments.slice(1).join(':');
        const args = splitTopLevelGenexSegments(argumentPortion, ',');
        const argumentBaseOffset = start + 2 + root.length + 1;

        if (GENERATOR_EXPRESSION_TARGET_ROOTS.has(root) && args.length > 0) {
            const occurrence = findTrimmedSegmentRange(argumentText, args[0], argumentBaseOffset);
            if (occurrence) {
                occurrences.push(occurrence);
            }
            continue;
        }

        if (root === 'TARGET_PROPERTY' && args.length > 1) {
            const occurrence = findTrimmedSegmentRange(argumentText, args[0], argumentBaseOffset);
            if (occurrence) {
                occurrences.push(occurrence);
            }
        }
    }

    return occurrences;
}

function extractIdentifierAtOffset(argumentText: string, offset: number): string {
    if (argumentText.length === 0) {
        return '';
    }

    let pivot = Math.min(offset, argumentText.length - 1);
    if (!isIdentifierCharacter(argumentText[pivot] ?? '') && pivot > 0 && isIdentifierCharacter(argumentText[pivot - 1] ?? '')) {
        pivot--;
    }

    if (!isIdentifierCharacter(argumentText[pivot] ?? '')) {
        return '';
    }

    let start = pivot;
    let end = pivot + 1;
    while (start > 0 && isIdentifierCharacter(argumentText[start - 1])) {
        start--;
    }
    while (end < argumentText.length && isIdentifierCharacter(argumentText[end])) {
        end++;
    }

    return argumentText.slice(start, end);
}

function resolveCursorWord(command: FlatCommand, pos: Position, argumentSpan: ArgumentSpan | null): string {
    const commandToken = command.ID().symbol;
    if ((pos.line + 1 === commandToken.line) && (pos.character >= commandToken.column) && (pos.character <= commandToken.column + commandToken.text.length)) {
        return commandToken.text;
    }

    if (!argumentSpan) {
        return '';
    }

    const offset = getArgumentOffset(argumentSpan, pos);
    const variableReference = extractVariableReferenceAtOffset(argumentSpan.text, offset);
    return variableReference ?? extractIdentifierAtOffset(argumentSpan.text, offset);
}

function extractVariableName(argumentText: string): string {
    const exactVariableMatch = argumentText.match(/^\$\{([^}]+)\}$/);
    return exactVariableMatch ? exactVariableMatch[1] : argumentText;
}

function resolveCursorText(command: FlatCommand, subject: DefinitionSubject, word: string, argumentSpan: ArgumentSpan | null): string {
    if (subject === DefinitionSubject.Command) {
        if (argumentSpan && (command.commandName.toLowerCase() === 'function' || command.commandName.toLowerCase() === 'macro') && argumentSpan.argumentIndex === 0) {
            return argumentSpan.text;
        }

        return command.ID().getText();
    }

    if (argumentSpan) {
        switch (subject) {
            case DefinitionSubject.Variable:
                return word || extractVariableName(argumentSpan.text);
            case DefinitionSubject.Target:
            case DefinitionSubject.FilePath:
            case DefinitionSubject.IncludeModule:
            case DefinitionSubject.FindPackage:
                return argumentSpan.text;
            default:
                break;
        }
    }

    return word;
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
const TARGET_SOURCES_SCOPE_KEYWORDS = new Set(['INTERFACE', 'PUBLIC', 'PRIVATE']);

function isTargetSourcesFileArgument(command: FlatCommand, argIndex: number): boolean {
    if (argIndex <= 0) {
        return false;
    }

    const args = command.argument_list();
    let inFileSet = false;
    let expectFileSetName = false;
    let expectTypeValue = false;
    let currentSection: 'direct' | 'base-dirs' | 'files' = 'direct';

    for (let index = 1; index < args.length; index++) {
        const argText = args[index]?.getText();
        if (!argText) {
            continue;
        }

        if (TARGET_SOURCES_SCOPE_KEYWORDS.has(argText)) {
            inFileSet = false;
            expectFileSetName = false;
            expectTypeValue = false;
            currentSection = 'direct';
            continue;
        }

        if (argText === 'FILE_SET') {
            inFileSet = true;
            expectFileSetName = true;
            expectTypeValue = false;
            currentSection = 'direct';
            continue;
        }

        if (expectFileSetName) {
            expectFileSetName = false;
            continue;
        }

        if (inFileSet && argText === 'TYPE') {
            expectTypeValue = true;
            continue;
        }

        if (expectTypeValue) {
            expectTypeValue = false;
            continue;
        }

        if (inFileSet && argText === 'BASE_DIRS') {
            currentSection = 'base-dirs';
            continue;
        }

        if (inFileSet && argText === 'FILES') {
            currentSection = 'files';
            continue;
        }

        const isFileArgument = !inFileSet || currentSection === 'files';
        if (index === argIndex) {
            return isFileArgument;
        }
    }

    return false;
}

function getPropertyKeywordIndex(args: ReturnType<FlatCommand['argument_list']>): number {
    for (let index = 0; index < args.length; index++) {
        const text = args[index]?.getText();
        if (text === 'PROPERTY' || text === 'PROPERTIES') {
            return index;
        }
    }

    return -1;
}

export function isPropertyArgumentIndex(command: FlatCommand, argIndex: number): boolean {
    const args = command.argument_list();
    const commandName = command.ID().symbol.text.toLowerCase();

    switch (commandName) {
        case 'get_property':
        case 'set_property':
        case 'define_property':
        case 'set_directory_properties':
        case 'set_target_properties':
        case 'set_tests_properties':
        case 'set_source_files_properties': {
            const propertyKeywordIndex = getPropertyKeywordIndex(args);
            if (propertyKeywordIndex === -1 || argIndex <= propertyKeywordIndex) {
                return false;
            }

            const keyword = args[propertyKeywordIndex]?.getText();
            const offset = argIndex - propertyKeywordIndex;
            if (keyword === 'PROPERTY') {
                return offset === 1;
            }

            return offset % 2 === 1;
        }
        case 'get_target_property':
            return argIndex === 2;
        case 'get_cmake_property':
        case 'get_test_property':
            return argIndex === 1;
        default:
            return false;
    }
}

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

export function isCommandPosition(command: FlatCommand, _word: string, pos: Position): boolean {
    const commandToken = command.ID().symbol;
    if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
        return true;
    }

    const cmdName = commandToken.text.toLowerCase();
    if (cmdName === 'function' || cmdName === 'macro') {
        const argumentSpan = getArgumentSpanAtPosition(command, pos);
        if (argumentSpan?.argumentIndex === 0) {
            return true;
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

export function getTargetOccurrencesInArgument(command: FlatCommand, argIndex: number): TargetOccurrence[] {
    const argText = command.argument_list()[argIndex]?.getText();
    if (!argText) {
        return [];
    }

    if (isTargetArgumentIndex(command, argIndex)) {
        return [{ text: argText, startOffset: 0, endOffset: argText.length }];
    }

    return getGeneratorExpressionTargetOccurrences(argText);
}

function getTargetOccurrenceAtPosition(command: FlatCommand, argumentSpan: ArgumentSpan, pos: Position): TargetOccurrence | null {
    const offset = getArgumentOffset(argumentSpan, pos);
    return getTargetOccurrencesInArgument(command, argumentSpan.argumentIndex)
        .find(occurrence => offset >= occurrence.startOffset && offset <= occurrence.endOffset)
        ?? null;
}

export function getTargetLinkLibraryKeywords(): string[] {
    return Array.from(TARGET_LINK_LIBRARY_KEYWORDS);
}

function isSourceFileArgument(command: FlatCommand, argIndex: number, argText: string): boolean {
    if (argIndex === 0) {
        return false;
    }

    const commandName = command.ID().symbol.text.toLowerCase();

    switch (commandName) {
        case 'add_executable':
            return !ADD_EXECUTABLE_KEYWORDS.has(argText);
        case 'add_library':
            return !ADD_LIBRARY_KEYWORDS.has(argText);
        case 'target_sources':
            return isTargetSourcesFileArgument(command, argIndex);
        default:
            return false;
    }
}

export function getArgumentSemanticKinds(command: FlatCommand, argIndex: number): Set<ArgumentSemanticKind> {
    const kinds = new Set<ArgumentSemanticKind>();
    const args = command.argument_list();
    const argText = args[argIndex]?.getText();
    if (!argText) {
        return kinds;
    }

    if (isTargetArgumentIndex(command, argIndex)) {
        kinds.add(ArgumentSemanticKind.Target);
    }

    if (isPropertyArgumentIndex(command, argIndex)) {
        kinds.add(ArgumentSemanticKind.Property);
    }

    const commandName = command.ID().symbol.text.toLowerCase();
    switch (commandName) {
        case 'include':
            if (argIndex === 0) {
                // Completion should offer both module and path candidates here.
                kinds.add(ArgumentSemanticKind.IncludeModule);
                kinds.add(ArgumentSemanticKind.FilePath);
            }
            break;
        case 'find_package':
            if (argIndex === 0) {
                kinds.add(ArgumentSemanticKind.FindPackage);
            }
            break;
        case 'add_subdirectory':
            if (argIndex === 0) {
                kinds.add(ArgumentSemanticKind.FilePath);
            }
            break;
        case 'configure_file':
            if (argIndex <= 1) {
                kinds.add(ArgumentSemanticKind.FilePath);
            }
            break;
        case 'add_executable':
        case 'add_library':
        case 'target_sources':
            if (isSourceFileArgument(command, argIndex, argText)) {
                kinds.add(ArgumentSemanticKind.FilePath);
            }
            break;
        default:
            break;
    }

    return kinds;
}

export function getDefinitionSubject(command: FlatCommand, word: string, pos: Position): DefinitionSubject {
    if (isCommandPosition(command, word, pos)) {
        return DefinitionSubject.Command;
    }

    const argumentSpan = getArgumentSpanAtPosition(command, pos);
    if (!argumentSpan) {
        return DefinitionSubject.Variable;
    }

    if (getTargetOccurrenceAtPosition(command, argumentSpan, pos)) {
        return DefinitionSubject.Target;
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
            return isSourceFileArgument(command, argumentSpan.argumentIndex, argumentSpan.text)
                ? DefinitionSubject.FilePath
                : DefinitionSubject.Variable;
        default:
            return DefinitionSubject.Variable;
    }

    return DefinitionSubject.Variable;
}

export function resolveCursorTarget(command: FlatCommand, word: string, pos: Position): ResolvedCursorTarget {
    const argumentSpan = getArgumentSpanAtPosition(command, pos);
    if (argumentSpan) {
        const targetOccurrence = getTargetOccurrenceAtPosition(command, argumentSpan, pos);
        if (targetOccurrence) {
            return {
                text: targetOccurrence.text,
                subject: DefinitionSubject.Target,
                semanticKind: ArgumentSemanticKind.Target,
                argumentSpan,
            };
        }
    }

    const cursorWord = word || resolveCursorWord(command, pos, argumentSpan);
    const subject = getDefinitionSubject(command, cursorWord, pos);
    const text = resolveCursorText(command, subject, cursorWord, argumentSpan);

    switch (subject) {
        case DefinitionSubject.Command:
            return { text, subject, semanticKind: ArgumentSemanticKind.Command, argumentSpan };
        case DefinitionSubject.Target:
            return { text, subject, semanticKind: ArgumentSemanticKind.Target, argumentSpan };
        case DefinitionSubject.FilePath:
            return { text, subject, semanticKind: ArgumentSemanticKind.FilePath, argumentSpan };
        case DefinitionSubject.IncludeModule:
            return { text, subject, semanticKind: ArgumentSemanticKind.IncludeModule, argumentSpan };
        case DefinitionSubject.FindPackage:
            return { text, subject, semanticKind: ArgumentSemanticKind.FindPackage, argumentSpan };
        case DefinitionSubject.Variable:
        default:
            return { text, subject: DefinitionSubject.Variable, semanticKind: ArgumentSemanticKind.Variable, argumentSpan };
    }
}

export function resolveArgumentTarget(command: FlatCommand, argIndex: number): ResolvedCursorTarget | null {
    const arg = command.argument_list()[argIndex];
    const token = arg?.start;
    if (!arg || !token) {
        return null;
    }

    return resolveCursorTarget(
        command,
        arg.getText(),
        { line: token.line - 1, character: token.column },
    );
}