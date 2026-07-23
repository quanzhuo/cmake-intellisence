import { CommonTokenStream, Token } from 'antlr4';
import { URI } from 'vscode-uri';
import { isBracketArgumentText } from './argumentText';
import * as builtinCmds from './builtin-cmds.json';
import { getTargetOccurrencesInArgument, isCommandArgumentIndex } from './argumentSemantics';
import { analyzeDependencyStructure, DependencyStructureAnalysis } from './dependencyStructure';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import CMakeLexer from './generated/CMakeLexer';
import { PathExpressionResolver } from './pathExpressionResolver';
import { extractIncludeDependency, extractSubdirectoryDependency, SourceDependencyOptions } from './sourceDependencyResolver';
import { rangeForTokenOffsets, tokenStartPosition } from './sourcePosition';
import { FileSymbolCache, SemanticScope, SemanticScopeKind, Symbol, SymbolIndex, SymbolKind, SymbolNamespace, SymbolOccurrenceRole, SymbolWriteKind } from './symbolIndex';
import { findVariableReferences } from './variableReferences';

export interface ExtractSymbolsOptions extends SourceDependencyOptions {
    tokenStream?: CommonTokenStream;
    dependencyStructure?: DependencyStructureAnalysis;
}

type ActiveScope = SemanticScope & { kind: SemanticScopeKind };

const CONDITION_NON_VARIABLE_KEYWORDS = new Set([
    'AND', 'OR', 'NOT', 'COMMAND', 'POLICY', 'TARGET', 'TEST', 'DEFINED', 'EXISTS',
    'IS_READABLE', 'IS_WRITABLE', 'IS_EXECUTABLE', 'IS_DIRECTORY', 'IS_SYMLINK',
    'IS_ABSOLUTE', 'IS_NEWER_THAN', 'MATCHES', 'LESS', 'GREATER', 'EQUAL',
    'LESS_EQUAL', 'GREATER_EQUAL', 'STRLESS', 'STRGREATER', 'STREQUAL',
    'STRLESS_EQUAL', 'STRGREATER_EQUAL', 'VERSION_LESS', 'VERSION_GREATER',
    'VERSION_EQUAL', 'VERSION_LESS_EQUAL', 'VERSION_GREATER_EQUAL', 'IN_LIST',
    'TRUE', 'FALSE', 'ON', 'OFF', 'YES', 'NO', 'Y', 'N', 'IGNORE', 'NOTFOUND',
]);

const CONDITION_LITERAL_OPERATORS = new Set([
    'COMMAND', 'POLICY', 'TARGET', 'TEST', 'EXISTS', 'IS_READABLE', 'IS_WRITABLE',
    'IS_EXECUTABLE', 'IS_DIRECTORY', 'IS_SYMLINK', 'IS_ABSOLUTE', 'MATCHES',
]);

const LIST_VARIABLE_ARGUMENT_INDEX: Record<string, number> = {
    APPEND: 1,
    FILTER: 1,
    FIND: 1,
    GET: 1,
    INSERT: 1,
    JOIN: 1,
    LENGTH: 1,
    POP_BACK: 1,
    POP_FRONT: 1,
    PREPEND: 1,
    REMOVE_AT: 1,
    REMOVE_DUPLICATES: 1,
    REMOVE_ITEM: 1,
    REVERSE: 1,
    SORT: 1,
    SUBLIST: 1,
    TRANSFORM: 1,
};

export async function extractSymbols(
    uri: string,
    commands: FlatCommand[],
    baseDir: URI,
    symbolIndex: SymbolIndex,
    options?: ExtractSymbolsOptions,
): Promise<FileSymbolCache> {
    const cache = new FileSymbolCache(uri);
    const dependencyStructure = options?.dependencyStructure ?? analyzeDependencyStructure(commands);
    for (const variableName of dependencyStructure.dependencyInputVariables) {
        cache.addDependencyInputVariable(variableName);
    }
    for (const [variableName, references] of dependencyStructure.variableReferences) {
        for (const referencedVariable of references) {
            cache.addVariableValueReference(variableName, referencedVariable);
        }
    }
    const pathExpressionResolver = options
        ? new PathExpressionResolver({
            symbolIndex,
            getFlatCommands: options.getFlatCommands,
            entryFile: URI.parse(options.entryFile),
            cacheOverrides: new Map([[uri, cache]]),
        })
        : undefined;

    const fileScopeId = `${uri}#file`;
    const scopeStack: ActiveScope[] = [cache.scopes.get(fileScopeId)! as ActiveScope];
    let controlFlowDepth = 0;

    for (const [order, cmd] of commands.entries()) {
        const cmdName = cmd.commandName.toLowerCase();
        if (cmdName === 'endif' || cmdName === 'endwhile' || cmdName === 'endforeach') {
            controlFlowDepth = Math.max(controlFlowDepth - 1, 0);
        }
        closeScopeForCommand(cache, scopeStack, cmdName, order);
        const currentScopeId = scopeStack[scopeStack.length - 1].id;
        const executionIsUncertain = controlFlowDepth > 0
            || scopeStack.some(scope => scope.kind === 'function' || scope.kind === 'macro');
        if (controlFlowDepth > 0) {
            cache.markOrderConditional(order);
        }
        if (executionIsUncertain) {
            cache.markOrderUncertain(order);
        }

        addCommandReference(cache, cmd, currentScopeId, order);
        addCommandArgumentOccurrences(cache, cmd, currentScopeId, order);
        addExplicitVariableReferences(cache, cmd, currentScopeId, order);
        addTargetOccurrences(cache, cmd, currentScopeId, order, uri);

        switch (cmdName) {
            case 'function': {
                const functionScope = createNestedScope(cache, scopeStack, cmd, 'function', order);
                extractFunctionOrMacro(cmd, SymbolKind.Function, cache, uri, currentScopeId, functionScope.id, order);
                break;
            }
            case 'macro': {
                const macroScope = createNestedScope(cache, scopeStack, cmd, 'macro', order);
                extractFunctionOrMacro(cmd, SymbolKind.Macro, cache, uri, currentScopeId, macroScope.id, order);
                break;
            }
            case 'set':
                extractVariableDeclaration(cmd, cache, uri, currentScopeId, order, getSetVariableNamespace(cmd));
                break;
            case 'option':
                extractVariableDeclaration(cmd, cache, uri, currentScopeId, order, 'cache-variable');
                break;
            case 'foreach':
                extractForeachVariable(cmd, cache, uri, createNestedScope(cache, scopeStack, cmd, 'foreach', order).id, order);
                addForeachListReferences(cache, cmd, currentScopeId, order);
                break;
            case 'block':
                createNestedScope(cache, scopeStack, cmd, 'block', order);
                break;
            case 'unset':
                const unsetParentScope = cmd.argument_list()[1]?.getText().toUpperCase() === 'PARENT_SCOPE';
                const unsetParentScopeId = unsetParentScope ? cache.scopes.get(currentScopeId)?.parentId : undefined;
                addVariableWrite(
                    cache,
                    cmd,
                    0,
                    unsetParentScopeId ?? currentScopeId,
                    order,
                    cmd.argument_list()[1]?.getText().toUpperCase() === 'CACHE' ? 'cache-variable' : undefined,
                    !unsetParentScope || unsetParentScopeId !== undefined,
                    'unset',
                );
                break;
            case 'math':
                if (cmd.argument_list()[0]?.getText().toUpperCase() === 'EXPR') {
                    extractVariableDeclarationAtIndex(cmd, 1, cache, uri, currentScopeId, order);
                }
                break;
            case 'list':
                addListVariableReference(cache, cmd, currentScopeId, order);
                break;
            case 'add_executable':
            case 'add_library':
            case 'add_custom_target':
                extractTarget(cmd, cache, uri, currentScopeId, order);
                break;
            case 'include':
                await extractIncludeDependency(cmd, cache, baseDir, symbolIndex, URI.parse(uri), order, executionIsUncertain, pathExpressionResolver, options);
                break;
            case 'add_subdirectory':
                await extractSubdirectoryDependency(cmd, cache, baseDir, URI.parse(uri), order, executionIsUncertain, pathExpressionResolver);
                break;
        }

        addBuiltinVariableOccurrences(cache, cmd, currentScopeId, order);
        addConditionVariableReferences(cache, cmd, currentScopeId, order);
        markPotentiallyUnclassifiedVariableNames(cache, cmd, currentScopeId, order, symbolIndex);
        if (cmdName === 'if' || cmdName === 'while' || cmdName === 'foreach') {
            controlFlowDepth++;
        }
    }

    for (const scope of scopeStack.slice(1)) {
        scope.endOrder = commands.length;
    }

    addRecoveredCommandOccurrences(cache, commands, options?.tokenStream);

    return cache;
}

function addRecoveredCommandOccurrences(
    cache: FileSymbolCache,
    commands: FlatCommand[],
    tokenStream: CommonTokenStream | undefined,
): void {
    if (!tokenStream) {
        return;
    }

    const defaultTokens = tokenStream.tokens.filter(token => token.channel === Token.DEFAULT_CHANNEL);
    const existingCommandStarts = new Set(cache.occurrences
        .filter(occurrence => occurrence.namespace === 'command')
        .map(occurrence => `${occurrence.range.start.line}:${occurrence.range.start.character}`));
    let parenthesisDepth = 0;
    let parsedCommandIndex = 0;
    for (let index = 0; index < defaultTokens.length - 1; index++) {
        const token = defaultTokens[index];
        while (parsedCommandIndex < commands.length && commands[parsedCommandIndex].start.tokenIndex < token.tokenIndex) {
            parsedCommandIndex++;
        }
        if (token.type === CMakeLexer.LP) {
            parenthesisDepth++;
            continue;
        }
        if (token.type === CMakeLexer.RP) {
            parenthesisDepth = Math.max(parenthesisDepth - 1, 0);
            continue;
        }
        if (parenthesisDepth !== 0 || token.type === Token.EOF || defaultTokens[index + 1]?.type !== CMakeLexer.LP) {
            continue;
        }

        const range = rangeForTokenOffsets(token, 0, token.text.length);
        const startKey = `${range.start.line}:${range.start.character}`;
        if (!existingCommandStarts.has(startKey)) {
            existingCommandStarts.add(startKey);
            const scopeId = findRecoveredCommandScope(cache, parsedCommandIndex, commands.length);
            if (isDeferredScope(cache, scopeId)) {
                cache.markOrderUncertain(parsedCommandIndex);
            }
            cache.addOccurrence({
                name: token.text,
                canonicalName: token.text.toLowerCase(),
                namespace: 'command',
                role: 'reference',
                uri: cache.uri,
                range,
                scopeId,
                order: parsedCommandIndex,
                safeForRename: true,
            });
        }
    }
}

function isDeferredScope(cache: FileSymbolCache, scopeId: string): boolean {
    let currentScopeId: string | undefined = scopeId;
    while (currentScopeId) {
        const scope = cache.scopes.get(currentScopeId);
        if (scope?.kind === 'function' || scope?.kind === 'macro') {
            return true;
        }
        currentScopeId = scope?.parentId;
    }
    return false;
}

function findRecoveredCommandScope(cache: FileSymbolCache, order: number, parsedCommandCount: number): string {
    let selectedScopeId = `${cache.uri}#file`;
    let selectedDepth = 0;
    for (const scope of cache.scopes.values()) {
        const containsOrder = scope.startOrder <= order
            && (order < scope.endOrder || (order === parsedCommandCount && scope.endOrder === parsedCommandCount));
        if (!containsOrder) {
            continue;
        }

        let depth = 0;
        let currentScope: SemanticScope | undefined = scope;
        while (currentScope) {
            depth++;
            currentScope = currentScope.parentId ? cache.scopes.get(currentScope.parentId) : undefined;
        }
        if (depth > selectedDepth) {
            selectedDepth = depth;
            selectedScopeId = scope.id;
        }
    }
    return selectedScopeId;
}

function canonicalName(namespace: SymbolNamespace, name: string): string {
    return namespace === 'command' ? name.toLowerCase() : name;
}

function addOccurrence(
    cache: FileSymbolCache,
    token: Token,
    name: string,
    namespace: SymbolNamespace,
    role: SymbolOccurrenceRole,
    scopeId: string,
    order: number,
    startOffset = 0,
    endOffset = startOffset + name.length,
    symbolId?: string,
    safeForRename = true,
    writeKind?: SymbolWriteKind,
): void {
    if (!name) {
        return;
    }

    cache.addOccurrence({
        name,
        canonicalName: canonicalName(namespace, name),
        namespace,
        role,
        uri: cache.uri,
        range: rangeForTokenOffsets(token, startOffset, endOffset),
        scopeId,
        order,
        symbolId,
        safeForRename,
        writeKind,
    });
}

function getLiteralName(token: Token): { name: string; startOffset: number; endOffset: number } | null {
    const text = token.text;
    if (!text) {
        return null;
    }

    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
        return { name: text.slice(1, -1), startOffset: 1, endOffset: text.length - 1 };
    }

    if (text.startsWith('[')) {
        return null;
    }

    return { name: text, startOffset: 0, endOffset: text.length };
}

function addCommandReference(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    const token = cmd.ID().symbol;
    addOccurrence(cache, token, token.text, 'command', 'reference', scopeId, order);
}

function addCommandArgumentOccurrences(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    for (const [argIndex, arg] of cmd.argument_list().entries()) {
        if (!isCommandArgumentIndex(cmd, argIndex)) {
            continue;
        }
        const token = arg.start;
        const literal = token ? getLiteralName(token) : null;
        if (token && literal && !literal.name.includes('${')) {
            addOccurrence(
                cache,
                token,
                literal.name,
                'command',
                'reference',
                scopeId,
                order,
                literal.startOffset,
                literal.endOffset,
            );
        }
    }
}

function addDeclaration(
    cache: FileSymbolCache,
    token: Token,
    name: string,
    kind: SymbolKind,
    namespace: SymbolNamespace,
    scopeId: string,
    order: number,
    startOffset: number,
    endOffset: number,
): Symbol {
    const range = rangeForTokenOffsets(token, startOffset, endOffset);
    const semanticId = namespace === 'variable' || namespace === 'cache-variable' || namespace === 'environment-variable'
        ? `${namespace}:${scopeId}:${name}`
        : undefined;
    const symbol = new Symbol(name, kind, cache.uri, range.start.line, range.start.character, scopeId, order, semanticId);
    switch (namespace) {
        case 'command':
            cache.addCommand(symbol);
            break;
        case 'target':
            cache.addTarget(symbol);
            break;
        case 'variable':
        case 'cache-variable':
        case 'environment-variable':
            cache.addVariable(symbol);
            break;
    }
    addOccurrence(cache, token, name, namespace, 'declaration', scopeId, order, startOffset, endOffset, symbol.id);
    return symbol;
}

function extractFunctionOrMacro(
    cmd: FlatCommand,
    kind: SymbolKind,
    cache: FileSymbolCache,
    uri: string,
    declarationScopeId: string,
    bodyScopeId: string,
    order: number,
): void {
    const args = cmd.argument_list();
    if (args.length > 0) {
        const token = args[0].start;
        const literal = token ? getLiteralName(token) : null;
        if (token && literal) {
            addDeclaration(cache, token, literal.name, kind, 'command', declarationScopeId, order, literal.startOffset, literal.endOffset);
        }
    }

    for (let argIndex = 1; argIndex < args.length; argIndex++) {
        extractVariableDeclarationAtIndex(cmd, argIndex, cache, uri, bodyScopeId, order);
    }
}

function getSetVariableNamespace(cmd: FlatCommand): SymbolNamespace {
    const args = cmd.argument_list();
    return args.some((arg, index) => index > 0 && arg.getText().toUpperCase() === 'CACHE')
        ? 'cache-variable'
        : 'variable';
}

function extractVariableDeclaration(
    cmd: FlatCommand,
    cache: FileSymbolCache,
    uri: string,
    scopeId: string,
    order: number,
    namespace: SymbolNamespace,
): void {
    const args = cmd.argument_list();
    if (args.some(arg => arg.getText().toUpperCase() === 'PARENT_SCOPE')) {
        const parentScopeId = cache.scopes.get(scopeId)?.parentId;
        if (parentScopeId) {
            extractVariableDeclarationAtIndex(cmd, 0, cache, uri, parentScopeId, order, namespace);
            cache.markOrderConditional(order);
        } else {
            addVariableWrite(cache, cmd, 0, scopeId, order, namespace, false);
        }
        return;
    }

    extractVariableDeclarationAtIndex(cmd, 0, cache, uri, scopeId, order, namespace);
}

function extractVariableDeclarationAtIndex(
    cmd: FlatCommand,
    argIndex: number,
    cache: FileSymbolCache,
    _uri: string,
    scopeId: string,
    order: number,
    namespace: SymbolNamespace = 'variable',
): void {
    const token = cmd.argument_list()[argIndex]?.start;
    const literal = token ? getLiteralName(token) : null;
    if (!token || !literal || literal.name.includes('${')) {
        return;
    }

    const environmentMatch = literal.name.match(/^ENV\{([^{}]+)\}$/);
    if (environmentMatch) {
        const nameOffset = literal.startOffset + 4;
        addDeclaration(cache, token, environmentMatch[1], SymbolKind.Variable, 'environment-variable', scopeId, order, nameOffset, nameOffset + environmentMatch[1].length);
        return;
    }

    const cacheMatch = literal.name.match(/^CACHE\{([^{}]+)\}$/);
    if (cacheMatch) {
        const nameOffset = literal.startOffset + 6;
        addDeclaration(cache, token, cacheMatch[1], SymbolKind.Variable, 'cache-variable', scopeId, order, nameOffset, nameOffset + cacheMatch[1].length);
        return;
    }

    addDeclaration(cache, token, literal.name, SymbolKind.Variable, namespace, scopeId, order, literal.startOffset, literal.endOffset);
}

function extractTarget(cmd: FlatCommand, cache: FileSymbolCache, _uri: string, scopeId: string, order: number): void {
    const token = cmd.argument_list()[0]?.start;
    const literal = token ? getLiteralName(token) : null;
    if (token && literal) {
        addDeclaration(cache, token, literal.name, SymbolKind.Target, 'target', scopeId, order, literal.startOffset, literal.endOffset);
    }
}

function createNestedScope(
    cache: FileSymbolCache,
    scopeStack: ActiveScope[],
    cmd: FlatCommand,
    kind: SemanticScopeKind,
    order: number,
): ActiveScope {
    const token = cmd.ID().symbol;
    const scope: ActiveScope = {
        id: `${cache.uri}#${kind}:${token.line - 1}:${token.column}`,
        kind,
        parentId: scopeStack[scopeStack.length - 1].id,
        startOrder: order,
        endOrder: Number.MAX_SAFE_INTEGER,
    };
    cache.addScope(scope);
    scopeStack.push(scope);
    return scope;
}

function closeScopeForCommand(
    _cache: FileSymbolCache,
    scopeStack: ActiveScope[],
    commandName: string,
    order: number,
): void {
    const closingKind: SemanticScopeKind | undefined = {
        endfunction: 'function',
        endmacro: 'macro',
        endforeach: 'foreach',
        endblock: 'block',
    }[commandName] as SemanticScopeKind | undefined;
    if (!closingKind) {
        return;
    }

    for (let index = scopeStack.length - 1; index > 0; index--) {
        const scope = scopeStack[index];
        scope.endOrder = order;
        scopeStack.pop();
        if (scope.kind === closingKind) {
            break;
        }
    }
}

function getArgumentLeafTokens(argument: ArgumentContext): Token[] {
    const nestedArguments = argument.argument_list();
    if (nestedArguments.length === 0) {
        return argument.start ? [argument.start] : [];
    }

    return nestedArguments.flatMap(getArgumentLeafTokens);
}

function addExplicitVariableReferences(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    const seenTokens = new Set<number>();

    for (const argument of cmd.argument_list()) {
        for (const token of getArgumentLeafTokens(argument)) {
            if (seenTokens.has(token.tokenIndex)) {
                continue;
            }
            seenTokens.add(token.tokenIndex);

            for (const reference of findVariableReferences(
                token.text,
                token.type !== CMakeLexer.BracketArgument
                    && !isBracketArgumentText(token.text),
            )) {
                addOccurrence(
                    cache,
                    token,
                    reference.name,
                    reference.namespace,
                    'reference',
                    scopeId,
                    order,
                    reference.startOffset,
                    reference.endOffset,
                );
            }
        }
    }
}

function addVariableArgumentOccurrence(
    cache: FileSymbolCache,
    cmd: FlatCommand,
    argIndex: number,
    scopeId: string,
    order: number,
    role: SymbolOccurrenceRole,
    safeForRename: boolean,
    namespace: SymbolNamespace = 'variable',
    writeKind?: SymbolWriteKind,
): void {
    const token = cmd.argument_list()[argIndex]?.start;
    const literal = token ? getLiteralName(token) : null;
    if (!token || !literal || !literal.name || literal.name.includes('${')) {
        return;
    }

    const environmentMatch = literal.name.match(/^ENV\{([^{}]+)\}$/);
    if (environmentMatch) {
        const startOffset = literal.startOffset + 4;
        addOccurrence(cache, token, environmentMatch[1], 'environment-variable', role, scopeId, order, startOffset, startOffset + environmentMatch[1].length, undefined, safeForRename, writeKind);
        return;
    }

    const cacheMatch = literal.name.match(/^CACHE\{([^{}]+)\}$/);
    if (cacheMatch) {
        const startOffset = literal.startOffset + 6;
        addOccurrence(cache, token, cacheMatch[1], 'cache-variable', role, scopeId, order, startOffset, startOffset + cacheMatch[1].length, undefined, safeForRename, writeKind);
        return;
    }

    addOccurrence(cache, token, literal.name, namespace, role, scopeId, order, literal.startOffset, literal.endOffset, undefined, safeForRename, writeKind);
}

function addVariableWrite(
    cache: FileSymbolCache,
    cmd: FlatCommand,
    argIndex: number,
    scopeId: string,
    order: number,
    namespace?: SymbolNamespace,
    safeForRename = true,
    writeKind: SymbolWriteKind = 'assign',
): void {
    addVariableArgumentOccurrence(cache, cmd, argIndex, scopeId, order, 'write', safeForRename, namespace, writeKind);
}

function addForeachListReferences(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    const args = cmd.argument_list();
    const inIndex = args.findIndex(arg => arg.getText().toUpperCase() === 'IN');
    if (inIndex === -1) {
        return;
    }

    const listsIndex = args.findIndex((arg, index) => index > inIndex && arg.getText().toUpperCase() === 'LISTS');
    if (listsIndex === -1) {
        return;
    }

    for (let index = listsIndex + 1; index < args.length; index++) {
        if (args[index].getText().toUpperCase() === 'ITEMS') {
            break;
        }
        addVariableArgumentOccurrence(cache, cmd, index, scopeId, order, 'reference', true);
    }
}

function addListVariableReference(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    const subcommand = cmd.argument_list()[0]?.getText().toUpperCase();
    const argIndex = subcommand ? LIST_VARIABLE_ARGUMENT_INDEX[subcommand] : undefined;
    if (argIndex === undefined) {
        return;
    }

    const writeSubcommands = new Set([
        'APPEND', 'FILTER', 'INSERT', 'POP_BACK', 'POP_FRONT', 'PREPEND',
        'REMOVE_AT', 'REMOVE_DUPLICATES', 'REMOVE_ITEM', 'REVERSE', 'SORT', 'TRANSFORM',
    ]);
    const outputVariableIndex = cmd.argument_list().findIndex(arg => arg.getText().toUpperCase() === 'OUTPUT_VARIABLE');
    const transformsIntoOutput = subcommand === 'TRANSFORM' && outputVariableIndex !== -1;
    if (writeSubcommands.has(subcommand ?? '') && !transformsIntoOutput) {
        extractVariableDeclarationAtIndex(cmd, argIndex, cache, cache.uri, scopeId, order);
    } else {
        addVariableArgumentOccurrence(cache, cmd, argIndex, scopeId, order, 'reference', true);
    }

    const args = cmd.argument_list();
    switch (subcommand) {
        case 'LENGTH':
            extractVariableDeclarationAtIndex(cmd, 2, cache, cache.uri, scopeId, order);
            break;
        case 'FIND':
        case 'JOIN':
            extractVariableDeclarationAtIndex(cmd, 3, cache, cache.uri, scopeId, order);
            break;
        case 'SUBLIST':
            extractVariableDeclarationAtIndex(cmd, 4, cache, cache.uri, scopeId, order);
            break;
        case 'GET':
            extractVariableDeclarationAtIndex(cmd, args.length - 1, cache, cache.uri, scopeId, order);
            break;
        case 'POP_BACK':
        case 'POP_FRONT':
            for (let index = 2; index < args.length; index++) {
                extractVariableDeclarationAtIndex(cmd, index, cache, cache.uri, scopeId, order);
            }
            break;
        case 'TRANSFORM':
            if (outputVariableIndex !== -1) {
                extractVariableDeclarationAtIndex(cmd, outputVariableIndex + 1, cache, cache.uri, scopeId, order);
            }
            break;
    }
}

function addBuiltinVariableOccurrences(
    cache: FileSymbolCache,
    cmd: FlatCommand,
    scopeId: string,
    order: number,
): void {
    const commandName = cmd.commandName.toLowerCase();
    const args = cmd.argument_list();
    const declare = (index: number, namespace: SymbolNamespace = 'variable'): void => {
        if (index >= 0 && index < args.length) {
            extractVariableDeclarationAtIndex(cmd, index, cache, cache.uri, scopeId, order, namespace);
        }
    };
    const reference = (index: number, namespace: SymbolNamespace = 'variable'): void => {
        if (index >= 0 && index < args.length) {
            addVariableArgumentOccurrence(cache, cmd, index, scopeId, order, 'reference', true, namespace);
        }
    };
    const declareAfterKeywords = (keywords: readonly string[]): void => {
        const keywordSet = new Set(keywords);
        for (let index = 0; index < args.length - 1; index++) {
            if (keywordSet.has(args[index].getText().toUpperCase())) {
                declare(index + 1);
            }
        }
    };

    switch (commandName) {
        case 'string':
            addStringVariableOccurrences(cmd, declare);
            break;
        case 'file':
            addFileVariableOccurrences(cmd, declare);
            break;
        case 'cmake_path':
            addCMakePathVariableOccurrences(cmd, declare, reference);
            break;
        case 'find_file':
        case 'find_library':
        case 'find_path':
        case 'find_program':
            declare(0, 'cache-variable');
            break;
        case 'aux_source_directory':
            declare(1);
            break;
        case 'build_command':
        case 'build_name':
        case 'get_cmake_property':
        case 'get_directory_property':
        case 'get_filename_component':
        case 'get_property':
        case 'get_source_file_property':
        case 'get_target_property':
        case 'separate_arguments':
        case 'site_name':
            declare(0);
            break;
        case 'get_test_property':
            declare(args.length - 1);
            break;
        case 'include':
            declareAfterKeywords(['RESULT_VARIABLE']);
            break;
        case 'execute_process':
            declareAfterKeywords(['RESULT_VARIABLE', 'RESULTS_VARIABLE', 'OUTPUT_VARIABLE', 'ERROR_VARIABLE']);
            break;
        case 'try_compile':
            declare(0);
            declareAfterKeywords(['OUTPUT_VARIABLE', 'COPY_FILE_ERROR']);
            break;
        case 'try_run':
            declare(0);
            declare(1);
            declareAfterKeywords(['COMPILE_OUTPUT_VARIABLE', 'RUN_OUTPUT_VARIABLE', 'OUTPUT_VARIABLE']);
            break;
        case 'cmake_host_system_information':
            declareAfterKeywords(['RESULT', 'ERROR_VARIABLE']);
            break;
        case 'cmake_language': {
            const mode = args[0]?.getText().toUpperCase();
            if (mode === 'GET_MESSAGE_LOG_LEVEL') {
                declare(1);
            } else if (mode === 'DEFER') {
                declareAfterKeywords(['ID_VAR', 'GET_CALL_IDS', 'GET_CALL']);
            } else if (mode === 'EVAL') {
                for (const namespace of ['command', 'variable', 'cache-variable', 'environment-variable', 'target'] as const) {
                    cache.markRenameUnsafe(namespace);
                }
            }
            break;
        }
        case 'cmake_policy':
            if (args[0]?.getText().toUpperCase() === 'GET') {
                declare(2);
            }
            break;
        case 'block':
        case 'return': {
            const propagateIndex = args.findIndex(arg => arg.getText().toUpperCase() === 'PROPAGATE');
            if (propagateIndex !== -1) {
                const targetScopeId = commandName === 'block'
                    ? scopeId
                    : cache.scopes.get(scopeId)?.parentId ?? scopeId;
                for (let index = propagateIndex + 1; index < args.length; index++) {
                    addVariableWrite(cache, cmd, index, targetScopeId, order);
                }
            }
            break;
        }
        case 'mark_as_advanced': {
            let startIndex = 0;
            if (args[0] && (args[0].getText().toUpperCase() === 'CLEAR' || args[0].getText().toUpperCase() === 'FORCE')) {
                startIndex = 1;
            }
            for (let index = startIndex; index < args.length; index++) {
                reference(index, 'cache-variable');
            }
            break;
        }
        case 'variable_watch':
            reference(0);
            break;
        case 'ctest_build':
        case 'ctest_configure':
        case 'ctest_coverage':
        case 'ctest_memcheck':
        case 'ctest_submit':
        case 'ctest_test':
        case 'ctest_update':
        case 'ctest_upload':
            declareAfterKeywords(['RETURN_VALUE', 'CAPTURE_CMAKE_ERROR', 'NUMBER_ERRORS', 'NUMBER_WARNINGS', 'BUILD_ID', 'DEFECT_COUNT']);
            break;
    }
}

function addStringVariableOccurrences(cmd: FlatCommand, declare: (index: number) => void): void {
    const args = cmd.argument_list();
    const subcommand = args[0]?.getText().toUpperCase();
    switch (subcommand) {
        case 'FIND':
        case 'REPLACE':
            declare(3);
            break;
        case 'REGEX':
            declare(args[1]?.getText().toUpperCase() === 'REPLACE' ? 4 : 3);
            break;
        case 'APPEND':
        case 'PREPEND':
        case 'CONCAT':
            declare(1);
            break;
        case 'JOIN':
        case 'TOLOWER':
        case 'TOUPPER':
        case 'LENGTH':
        case 'STRIP':
        case 'GENEX_STRIP':
        case 'HEX':
        case 'CONFIGURE':
        case 'MAKE_C_IDENTIFIER':
            declare(2);
            break;
        case 'SUBSTRING':
        case 'COMPARE':
            declare(4);
            break;
        case 'REPEAT':
            declare(3);
            break;
        case 'TIMESTAMP':
        case 'UUID':
        case 'JSON':
            declare(1);
            break;
        case 'ASCII':
        case 'RANDOM':
            declare(args.length - 1);
            break;
        default:
            // Hash subcommands (MD5, SHA1, SHA256, ...) place the output first.
            if (subcommand && /^(MD5|SHA1|SHA224|SHA256|SHA384|SHA512|SHA3_224|SHA3_256|SHA3_384|SHA3_512)$/.test(subcommand)) {
                declare(1);
            }
            break;
    }
    const errorVariableIndex = args.findIndex(arg => arg.getText().toUpperCase() === 'ERROR_VARIABLE');
    if (errorVariableIndex !== -1) {
        declare(errorVariableIndex + 1);
    }
}

function addFileVariableOccurrences(cmd: FlatCommand, declare: (index: number) => void): void {
    const args = cmd.argument_list();
    const subcommand = args[0]?.getText().toUpperCase();
    if (['READ', 'STRINGS', 'TIMESTAMP', 'SIZE', 'READ_SYMLINK', 'REAL_PATH'].includes(subcommand ?? '')) {
        declare(2);
    } else if (subcommand === 'RELATIVE_PATH') {
        declare(1);
    } else if (subcommand === 'TO_CMAKE_PATH' || subcommand === 'TO_NATIVE_PATH') {
        declare(2);
    } else if (subcommand && /^(MD5|SHA1|SHA224|SHA256|SHA384|SHA512|SHA3_224|SHA3_256|SHA3_384|SHA3_512)$/.test(subcommand)) {
        declare(2);
    }

    const outputKeywords = new Set([
        'RESULT_VARIABLE', 'RESULTS_VARIABLE', 'OUTPUT_VARIABLE', 'ERROR_VARIABLE',
        'STATUS', 'LOG', 'RESOLVED_DEPENDENCIES_VAR', 'UNRESOLVED_DEPENDENCIES_VAR',
    ]);
    for (let index = 0; index < args.length - 1; index++) {
        if (outputKeywords.has(args[index].getText().toUpperCase())) {
            declare(index + 1);
        }
    }
}

function addCMakePathVariableOccurrences(
    cmd: FlatCommand,
    declare: (index: number) => void,
    reference: (index: number) => void,
): void {
    const args = cmd.argument_list();
    const subcommand = args[0]?.getText().toUpperCase();
    const outputVariableIndex = args.findIndex(arg => arg.getText().toUpperCase() === 'OUTPUT_VARIABLE');
    if (['SET', 'APPEND', 'APPEND_STRING', 'REMOVE_FILENAME', 'REPLACE_FILENAME', 'REMOVE_EXTENSION', 'REPLACE_EXTENSION', 'NORMAL_PATH', 'RELATIVE_PATH', 'ABSOLUTE_PATH'].includes(subcommand ?? '')) {
        if (outputVariableIndex === -1) {
            declare(1);
        } else {
            reference(1);
            declare(outputVariableIndex + 1);
        }
        return;
    }
    if (['GET', 'HAS_ROOT_NAME', 'HAS_ROOT_DIRECTORY', 'HAS_ROOT_PATH', 'HAS_FILENAME', 'HAS_EXTENSION', 'HAS_STEM', 'HAS_RELATIVE_PART', 'HAS_PARENT_PATH', 'IS_ABSOLUTE', 'IS_RELATIVE', 'IS_PREFIX', 'HASH', 'NATIVE_PATH'].includes(subcommand ?? '')) {
        reference(1);
        declare(args.length - 1);
    } else if (subcommand === 'COMPARE') {
        declare(args.length - 1);
    } else if (subcommand === 'CONVERT') {
        declare(args[args.length - 1]?.getText().toUpperCase() === 'NORMALIZE' ? args.length - 2 : args.length - 1);
    }
}

const COMPLETELY_CLASSIFIED_VARIABLE_COMMANDS = new Set([
    'set', 'unset', 'option', 'foreach', 'math', 'list', 'string', 'file', 'cmake_path',
    'if', 'elseif', 'while', 'function', 'macro', 'block', 'return', 'include',
    'find_file', 'find_library', 'find_path', 'find_program',
    'aux_source_directory', 'build_command', 'build_name', 'get_cmake_property',
    'get_directory_property', 'get_filename_component', 'get_property',
    'get_source_file_property', 'get_target_property', 'get_test_property',
    'separate_arguments', 'site_name', 'execute_process', 'try_compile', 'try_run',
    'cmake_host_system_information', 'cmake_language', 'cmake_policy',
    'mark_as_advanced', 'variable_watch',
]);

function commandSignatureMayUseBareVariableNames(commandName: string): boolean {
    const definition = (builtinCmds as Record<string, { sig?: string[] }>)[commandName];
    return definition?.sig?.some(signature => /<(?:[^>]*(?:var(?:iable)?|result|prefix)[^>]*)>/i.test(signature)) ?? false;
}

function markPotentiallyUnclassifiedVariableNames(
    cache: FileSymbolCache,
    cmd: FlatCommand,
    _scopeId: string,
    order: number,
    symbolIndex: SymbolIndex,
): void {
    const commandName = cmd.commandName.toLowerCase();
    const args = cmd.argument_list();
    if ((commandName === 'set' || commandName === 'unset') && args[0]?.getText().includes('${')) {
        cache.markRenameUnsafe('variable');
        cache.markRenameUnsafe('cache-variable');
    }
    if (commandName === 'unset' && cache.conditionalOrders.has(order)) {
        const unsetOccurrence = cache.getOccurrencesAtOrder(order).find(occurrence => occurrence.writeKind === 'unset');
        if (unsetOccurrence) {
            cache.markRenameUnsafe(unsetOccurrence.namespace, unsetOccurrence.canonicalName);
        }
    }

    const mayUseBareVariableNames = !symbolIndex.hasCoreBuiltinCommand(commandName)
        || (!COMPLETELY_CLASSIFIED_VARIABLE_COMMANDS.has(commandName)
            && commandSignatureMayUseBareVariableNames(commandName));
    if (!mayUseBareVariableNames) {
        return;
    }

    const classifiedOccurrences = cache.getOccurrencesAtOrder(order).filter(occurrence =>
        occurrence.namespace === 'variable'
        || occurrence.namespace === 'cache-variable'
        || occurrence.namespace === 'environment-variable'
    );
    for (const arg of args) {
        const token = arg.start;
        const literal = token ? getLiteralName(token) : null;
        if (!token || !literal || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(literal.name)) {
            continue;
        }
        const tokenPosition = tokenStartPosition(token);
        if (classifiedOccurrences.some(occurrence => occurrence.name === literal.name
            && occurrence.range.start.line === tokenPosition.line
            && occurrence.range.start.character === tokenPosition.character + literal.startOffset)) {
            continue;
        }
        cache.markRenameUnsafe('variable', literal.name);
        cache.markRenameUnsafe('cache-variable', literal.name);
    }
}

function addConditionVariableReferences(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number): void {
    const commandName = cmd.commandName.toLowerCase();
    if (commandName !== 'if' && commandName !== 'elseif' && commandName !== 'while') {
        return;
    }

    const args = cmd.argument_list();
    for (let index = 0; index < args.length; index++) {
        const text = args[index].getText();
        const upper = text.toUpperCase();
        if (!text || text.startsWith('"') || text.startsWith('[') || text.includes('${') || CONDITION_NON_VARIABLE_KEYWORDS.has(upper) || /^[-+]?\d+(?:\.\d+)?$/.test(text)) {
            continue;
        }

        const previous = index > 0 ? args[index - 1].getText().toUpperCase() : '';
        if (CONDITION_LITERAL_OPERATORS.has(previous)) {
            continue;
        }

        addVariableArgumentOccurrence(cache, cmd, index, scopeId, order, 'reference', true);
    }
}

function addTargetOccurrences(cache: FileSymbolCache, cmd: FlatCommand, scopeId: string, order: number, _uri: string): void {
    const args = cmd.argument_list();
    const commandName = cmd.commandName.toLowerCase();
    const isTargetDeclarationCommand = commandName === 'add_executable'
        || commandName === 'add_library'
        || commandName === 'add_custom_target';

    for (const [argIndex, arg] of args.entries()) {
        if (isTargetDeclarationCommand && argIndex === 0) {
            continue;
        }

        const token = arg.start;
        if (!token) {
            continue;
        }

        for (const occurrence of getTargetOccurrencesInArgument(cmd, argIndex)) {
            addOccurrence(
                cache,
                token,
                occurrence.text,
                'target',
                'reference',
                scopeId,
                order,
                occurrence.startOffset,
                occurrence.endOffset,
            );
        }
    }

}

// The first argument to foreach() is always the loop variable, regardless of the loop form
// (foreach(VAR ...), foreach(VAR RANGE n), foreach(VAR IN LISTS/ITEMS ...)).
function extractForeachVariable(cmd: FlatCommand, cache: FileSymbolCache, uri: string, scopeId: string, order: number): void {
    extractVariableDeclarationAtIndex(cmd, 0, cache, uri, scopeId, order);
}
