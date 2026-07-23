import { Token } from 'antlr4';
import {
    InitializeParams,
    Range,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensDelta,
} from 'vscode-languageserver';
import * as builtinCmds from './builtin-cmds.json';
import { ArgumentSemanticKind, getArgumentSemanticKinds } from './argumentSemantics';
import { isBracketArgumentText } from './argumentText';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import CMakeLexer from './generated/CMakeLexer';
import { GENERATOR_EXPRESSION_TARGET_ROOTS } from './generatorExpressions';
import { rangeForTokenOffsets } from './sourcePosition';
import { SymbolBindingResolver } from './symbolBinding';
import {
    FileSymbolCache,
    SymbolIndex,
    SymbolKind,
    SymbolOccurrence,
} from './symbolIndex';

const defaultTokenTypes = [
    'class',
    'enum',
    'parameter',
    'variable',
    'property',
    'function',
    'macro',
    'keyword',
];

const defaultTokenModifiers = [
    'declaration',
    'definition',
    'modification',
];

let tokenTypes = [...defaultTokenTypes];
let tokenModifiers = [...defaultTokenModifiers];

enum TokenModifier {
    declaration = 'declaration',
    definition = 'definition',
    modification = 'modification',
}

enum TokenType {
    target = 'class',
    enum = 'enum',
    parameter = 'parameter',
    variable = 'variable',
    property = 'property',
    function = 'function',
    macro = 'macro',
    keyword = 'keyword',
}

enum TokenPriority {
    contextualKeyword = 100,
    contextualSymbol = 200,
    resolvedSymbol = 300,
}

const tokenTypeRank = new Map<string, number>([
    [TokenType.function, 80],
    [TokenType.macro, 70],
    [TokenType.parameter, 60],
    [TokenType.variable, 50],
    [TokenType.target, 40],
    [TokenType.property, 30],
    [TokenType.enum, 20],
    [TokenType.keyword, 10],
]);

type BuiltinCommandDefinition = {
    keyword?: string[];
};

const builtinCommandsByCanonicalName = new Map<string, BuiltinCommandDefinition>(
    Object.entries(builtinCmds as Record<string, BuiltinCommandDefinition>)
        .map(([name, definition]) => [name.toLowerCase(), definition]),
);

const textMateContextualCommands = new Set([
    'if',
    'elseif',
    'while',
    'foreach',
    'set',
    'unset',
    'function',
    'macro',
]);

const textMateBooleanLiterals = new Set([
    'ON',
    'YES',
    'TRUE',
    'Y',
    'OFF',
    'NO',
    'FALSE',
    'N',
    'IGNORE',
    'NOTFOUND',
]);

const firstArgumentKeywordOnlyCommands = new Set([
    'cmake_language',
    'cmake_path',
    'cmake_policy',
    'file',
    'list',
    'math',
    'message',
    'string',
]);

const generatorExpressionEnumRoots = new Set([
    'CONFIG',
    'PLATFORM_ID',
    'COMPILE_FEATURES',
    'COMPILE_LANGUAGE',
    'LINK_LANGUAGE',
    'C_COMPILER_ID',
    'CXX_COMPILER_ID',
    'CUDA_COMPILER_ID',
    'OBJC_COMPILER_ID',
    'OBJCXX_COMPILER_ID',
    'Fortran_COMPILER_ID',
    'HIP_COMPILER_ID',
    'ISPC_COMPILER_ID',
    'COMPILE_LANG_AND_ID',
    'LINK_LANG_AND_ID',
]);

const generatorExpressionOperationRoots = new Set([
    'LIST',
    'PATH',
    'STRING',
]);

interface TextSegment {
    text: string;
    startOffset: number;
    endOffset: number;
}

interface SemanticTokenCandidate {
    line: number;
    character: number;
    length: number;
    tokenType: string;
    modifiers: Set<string>;
    priority: TokenPriority;
}

interface ResolvedCommandKind {
    kind: SymbolKind.Function | SymbolKind.Macro;
    userDefined: boolean;
}

export interface SemanticTokenDescriptor {
    line: number;
    character: number;
    length: number;
    tokenType: string;
    modifiers: readonly string[];
}

export interface SemanticHighlightInput {
    uri: string;
    entryUri: string;
    symbolIndex: SymbolIndex;
    commands: readonly FlatCommand[];
}

export function getTokenTypes(initParams: InitializeParams): string[] {
    const supportedTokenTypes = initParams.capabilities.textDocument?.semanticTokens?.tokenTypes;
    tokenTypes = supportedTokenTypes
        ? defaultTokenTypes.filter(value => supportedTokenTypes.includes(value))
        : [...defaultTokenTypes];
    return tokenTypes;
}

export function getTokenModifiers(initParams: InitializeParams): string[] {
    const supportedTokenModifiers = initParams.capabilities.textDocument?.semanticTokens?.tokenModifiers;
    tokenModifiers = supportedTokenModifiers
        ? defaultTokenModifiers.filter(value => supportedTokenModifiers.includes(value))
        : [...defaultTokenModifiers];
    return tokenModifiers;
}

export function encodeTokenModifiers(modifiers: readonly string[]): number {
    let result = 0;
    for (const modifier of modifiers) {
        const modifierIndex = tokenModifiers.indexOf(modifier);
        if (modifierIndex !== -1) {
            result |= 2 ** modifierIndex;
        }
    }
    return result;
}

function rangeKey(range: Range): string {
    return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function rangesOverlap(left: SemanticTokenCandidate, right: SemanticTokenCandidate): boolean {
    return left.line === right.line
        && left.character < right.character + right.length
        && right.character < left.character + left.length;
}

function splitTopLevelSegments(text: string, separator: ','): TextSegment[] {
    const segments: TextSegment[] = [];
    let startOffset = 0;
    let depth = 0;
    for (let offset = 0; offset < text.length; offset++) {
        if (text[offset] === '$' && text[offset + 1] === '<') {
            depth++;
            offset++;
        } else if (text[offset] === '>' && depth > 0) {
            depth--;
        } else if (text[offset] === separator && depth === 0) {
            segments.push({
                text: text.slice(startOffset, offset),
                startOffset,
                endOffset: offset,
            });
            startOffset = offset + 1;
        }
    }
    segments.push({
        text: text.slice(startOffset),
        startOffset,
        endOffset: text.length,
    });
    return segments;
}

function findTopLevelColon(text: string): number {
    let depth = 0;
    for (let offset = 0; offset < text.length; offset++) {
        if (text[offset] === '$' && text[offset + 1] === '<') {
            depth++;
            offset++;
        } else if (text[offset] === '>' && depth > 0) {
            depth--;
        } else if (text[offset] === ':' && depth === 0) {
            return offset;
        }
    }
    return -1;
}

function trimSegment(segment: TextSegment, baseOffset: number): TextSegment | undefined {
    const leadingWhitespace = segment.text.length - segment.text.trimStart().length;
    const trailingWhitespace = segment.text.length - segment.text.trimEnd().length;
    const startOffset = baseOffset + segment.startOffset + leadingWhitespace;
    const endOffset = baseOffset + segment.endOffset - trailingWhitespace;
    if (endOffset <= startOffset) {
        return undefined;
    }
    return {
        text: segment.text.slice(leadingWhitespace, segment.text.length - trailingWhitespace),
        startOffset,
        endOffset,
    };
}

function getArgumentLeafTokens(argument: ArgumentContext): Token[] {
    const nestedArguments = argument.argument_list();
    if (nestedArguments.length === 0) {
        return argument.start ? [argument.start] : [];
    }
    return nestedArguments.flatMap(getArgumentLeafTokens);
}

function literalTokenOffsets(token: Token): { startOffset: number; endOffset: number } | undefined {
    if (token.type === CMakeLexer.BracketArgument || isBracketArgumentText(token.text) || !token.text) {
        return undefined;
    }
    if (token.type === CMakeLexer.QuotedArgument) {
        return token.text.length >= 2
            ? { startOffset: 1, endOffset: token.text.length - 1 }
            : undefined;
    }
    return { startOffset: 0, endOffset: token.text.length };
}

class SemanticTokenCollector {
    private readonly candidates = new Map<string, SemanticTokenCandidate>();
    private readonly bindingResolver: SymbolBindingResolver;
    private readonly parameterSymbolIds = new Set<string>();
    private readonly parameterNames = new Set<string>();
    private readonly resolvableCommandNames: Set<string>;
    private readonly resolvedUserCommandRanges = new Set<string>();

    constructor(private readonly input: SemanticHighlightInput) {
        this.bindingResolver = new SymbolBindingResolver(input.symbolIndex, input.entryUri, input.uri);
        this.resolvableCommandNames = new Set(
            Array.from(input.symbolIndex.getAllUserCommandSymbols(), name => name.toLowerCase()),
        );
        for (const command of input.symbolIndex.getAllBuiltinCommands()) {
            if (!input.symbolIndex.hasCoreBuiltinCommand(command)) {
                this.resolvableCommandNames.add(command.toLowerCase());
            }
        }
    }

    collect(): SemanticTokenDescriptor[] {
        this.collectParameterSymbolIds();
        this.addIndexedSymbols();
        for (const command of this.input.commands) {
            this.addContextualBuiltinKeywords(command);
            this.addContextualProperties(command);
            this.addGeneratorExpressionOperands(command);
        }
        return this.finalize();
    }

    private addRange(
        range: Range,
        tokenType: TokenType,
        modifiers: readonly TokenModifier[],
        priority: TokenPriority,
    ): void {
        if (!tokenTypes.includes(tokenType)
            || range.start.line !== range.end.line
            || range.end.character <= range.start.character) {
            return;
        }

        const key = rangeKey(range);
        const candidate: SemanticTokenCandidate = {
            line: range.start.line,
            character: range.start.character,
            length: range.end.character - range.start.character,
            tokenType,
            modifiers: new Set(modifiers),
            priority,
        };
        const existing = this.candidates.get(key);
        if (!existing) {
            this.candidates.set(key, candidate);
            return;
        }
        if (existing.tokenType === candidate.tokenType) {
            for (const modifier of candidate.modifiers) {
                existing.modifiers.add(modifier);
            }
            existing.priority = Math.max(existing.priority, candidate.priority);
            return;
        }

        const existingRank = tokenTypeRank.get(existing.tokenType) ?? 0;
        const candidateRank = tokenTypeRank.get(candidate.tokenType) ?? 0;
        if (candidate.priority > existing.priority
            || (candidate.priority === existing.priority && candidateRank > existingRank)) {
            this.candidates.set(key, candidate);
        }
    }

    private addTokenOffsets(
        token: Token,
        startOffset: number,
        endOffset: number,
        tokenType: TokenType,
        priority: TokenPriority,
    ): void {
        if (startOffset < 0 || endOffset > token.text.length || endOffset <= startOffset) {
            return;
        }
        this.addRange(
            rangeForTokenOffsets(token, startOffset, endOffset),
            tokenType,
            [],
            priority,
        );
    }

    private addPlainSegment(
        token: Token,
        segment: TextSegment | undefined,
        tokenType: TokenType,
        priority: TokenPriority,
        pattern?: RegExp,
    ): void {
        if (!segment
            || segment.text.includes('$<')
            || segment.text.includes('${')
            || segment.text.includes('\n')
            || segment.text.includes('\r')
            || (pattern && !pattern.test(segment.text))) {
            return;
        }
        this.addTokenOffsets(token, segment.startOffset, segment.endOffset, tokenType, priority);
    }

    private collectParameterSymbolIds(): void {
        const cache = this.input.symbolIndex.getCache(this.input.uri);
        if (!cache) {
            return;
        }

        const parameterRanges = new Set<string>();
        for (const command of this.input.commands) {
            const commandName = command.commandName.toLowerCase();
            if (commandName !== 'function' && commandName !== 'macro') {
                continue;
            }
            for (const argument of command.argument_list().slice(1)) {
                const token = argument.start;
                const offsets = token ? literalTokenOffsets(token) : undefined;
                if (token && offsets && argument.getText() === token.text) {
                    parameterRanges.add(rangeKey(rangeForTokenOffsets(token, offsets.startOffset, offsets.endOffset)));
                }
            }
        }

        for (const occurrence of cache.occurrences) {
            if (occurrence.namespace === 'variable'
                && occurrence.role === 'declaration'
                && occurrence.symbolId
                && parameterRanges.has(rangeKey(occurrence.range))) {
                this.parameterSymbolIds.add(occurrence.symbolId);
                this.parameterNames.add(occurrence.canonicalName);
            }
        }
    }

    private symbolKindForDeclaration(declaration: SymbolOccurrence): SymbolKind.Function | SymbolKind.Macro | undefined {
        const cache = this.input.symbolIndex.getCache(declaration.uri);
        const symbols = cache?.commands.get(declaration.canonicalName) ?? [];
        const symbol = symbols.find(candidate =>
            candidate.id === declaration.symbolId
            || (candidate.line === declaration.range.start.line
                && candidate.column === declaration.range.start.character),
        );
        return symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Macro
            ? symbol.kind
            : undefined;
    }

    private commandKind(
        cache: FileSymbolCache,
        occurrence: SymbolOccurrence,
    ): ResolvedCommandKind | undefined {
        const localSymbol = cache.commands.get(occurrence.canonicalName)?.find(symbol =>
            symbol.id === occurrence.symbolId
            || (symbol.line === occurrence.range.start.line
                && symbol.column === occurrence.range.start.character),
        );
        if (localSymbol?.kind === SymbolKind.Function || localSymbol?.kind === SymbolKind.Macro) {
            return {
                kind: localSymbol.kind,
                userDefined: !this.input.symbolIndex.isBuiltinModuleUri(occurrence.uri),
            };
        }
        if (!this.resolvableCommandNames.has(occurrence.canonicalName)) {
            return undefined;
        }

        const declarations = this.bindingResolver.resolveDefinitions(occurrence, false).declarations;
        const kinds = new Set(
            declarations
                .map(declaration => this.symbolKindForDeclaration(declaration))
                .filter((kind): kind is SymbolKind.Function | SymbolKind.Macro => kind !== undefined),
        );
        if (kinds.size !== 1) {
            return undefined;
        }
        return {
            kind: kinds.values().next().value,
            userDefined: declarations.some(declaration =>
                !this.input.symbolIndex.isBuiltinModuleUri(declaration.uri)),
        };
    }

    private variableTokenType(occurrence: SymbolOccurrence): TokenType {
        if (occurrence.symbolId && this.parameterSymbolIds.has(occurrence.symbolId)) {
            return TokenType.parameter;
        }
        if (!this.parameterNames.has(occurrence.canonicalName)) {
            return TokenType.variable;
        }
        const binding = this.bindingResolver.resolveDefinitions(occurrence, false);
        return binding.symbolIds.length > 0
            && binding.symbolIds.every(symbolId => this.parameterSymbolIds.has(symbolId))
            ? TokenType.parameter
            : TokenType.variable;
    }

    private modifiersForOccurrence(
        occurrence: SymbolOccurrence,
        isDefinition: boolean,
    ): TokenModifier[] {
        if (occurrence.role === 'declaration') {
            return isDefinition
                ? [TokenModifier.declaration, TokenModifier.definition]
                : [TokenModifier.declaration];
        }
        return occurrence.role === 'write' ? [TokenModifier.modification] : [];
    }

    private addIndexedSymbols(): void {
        const cache = this.input.symbolIndex.getCache(this.input.uri);
        if (!cache) {
            return;
        }

        for (const occurrence of cache.occurrences) {
            switch (occurrence.namespace) {
                case 'variable':
                case 'cache-variable':
                case 'environment-variable':
                    if (occurrence.name.includes('$<')) {
                        break;
                    }
                    this.addRange(
                        occurrence.range,
                        this.variableTokenType(occurrence),
                        this.modifiersForOccurrence(occurrence, false),
                        TokenPriority.resolvedSymbol,
                    );
                    break;
                case 'target':
                    this.addRange(
                        occurrence.range,
                        TokenType.target,
                        this.modifiersForOccurrence(occurrence, true),
                        TokenPriority.resolvedSymbol,
                    );
                    break;
                case 'command': {
                    const resolved = this.commandKind(cache, occurrence);
                    if (resolved !== undefined) {
                        if (resolved.userDefined) {
                            this.resolvedUserCommandRanges.add(rangeKey(occurrence.range));
                        }
                        this.addRange(
                            occurrence.range,
                            resolved.kind === SymbolKind.Macro ? TokenType.macro : TokenType.function,
                            this.modifiersForOccurrence(occurrence, true),
                            TokenPriority.resolvedSymbol,
                        );
                    }
                    break;
                }
            }
        }
    }

    private addContextualBuiltinKeywords(command: FlatCommand): void {
        const commandName = command.commandName.toLowerCase();
        if (textMateContextualCommands.has(commandName) || this.isResolvedUserCommand(command)) {
            return;
        }
        const definition = builtinCommandsByCanonicalName.get(commandName);
        if (!definition?.keyword?.length) {
            return;
        }

        const keywords = new Set(definition.keyword);
        for (const [argumentIndex, argument] of command.argument_list().entries()) {
            const token = argument.start;
            if (!token
                || argument.getText() !== token.text
                || token.type === CMakeLexer.QuotedArgument
                || token.type === CMakeLexer.BracketArgument
                || isBracketArgumentText(token.text)
                || textMateBooleanLiterals.has(token.text.toUpperCase())
                || !keywords.has(token.text)) {
                continue;
            }
            if (firstArgumentKeywordOnlyCommands.has(commandName) && argumentIndex !== 0) {
                continue;
            }
            this.addTokenOffsets(
                token,
                0,
                token.text.length,
                TokenType.keyword,
                TokenPriority.contextualKeyword,
            );
        }
    }

    private addContextualProperties(command: FlatCommand): void {
        if (this.isResolvedUserCommand(command)) {
            return;
        }
        for (const [argumentIndex, argument] of command.argument_list().entries()) {
            if (!getArgumentSemanticKinds(command, argumentIndex).has(ArgumentSemanticKind.Property)) {
                continue;
            }
            const token = argument.start;
            const offsets = token ? literalTokenOffsets(token) : undefined;
            if (!token
                || !offsets
                || argument.getText() !== token.text
                || token.text.includes('${')
                || token.text.includes('$<')) {
                continue;
            }
            this.addTokenOffsets(
                token,
                offsets.startOffset,
                offsets.endOffset,
                TokenType.property,
                TokenPriority.contextualSymbol,
            );
        }
    }

    private addGeneratorExpressionOperands(command: FlatCommand): void {
        const seenTokenIndexes = new Set<number>();
        for (const argument of command.argument_list()) {
            if (argument.start
                && (argument.start.type === CMakeLexer.BracketArgument
                    || isBracketArgumentText(argument.getText()))) {
                continue;
            }
            for (const token of getArgumentLeafTokens(argument)) {
                if (seenTokenIndexes.has(token.tokenIndex)
                    || token.type === CMakeLexer.BracketArgument
                    || isBracketArgumentText(token.text)) {
                    continue;
                }
                seenTokenIndexes.add(token.tokenIndex);
                this.scanGeneratorExpressions(token);
            }
        }
    }

    private isResolvedUserCommand(command: FlatCommand): boolean {
        const token = command.ID().symbol;
        return this.resolvedUserCommandRanges.has(
            rangeKey(rangeForTokenOffsets(token, 0, token.text.length)),
        );
    }

    private scanGeneratorExpressions(token: Token): void {
        const stack: number[] = [];
        for (let offset = 0; offset < token.text.length; offset++) {
            if (token.text[offset] === '$' && token.text[offset + 1] === '<') {
                stack.push(offset);
                offset++;
            } else if (token.text[offset] === '>' && stack.length > 0) {
                const startOffset = stack.pop()!;
                this.addGeneratorExpression(token, startOffset + 2, offset);
            }
        }
    }

    private addGeneratorExpression(token: Token, contentStart: number, contentEnd: number): void {
        const content = token.text.slice(contentStart, contentEnd);
        const colonOffset = findTopLevelColon(content);
        if (colonOffset === -1) {
            return;
        }
        const root = content.slice(0, colonOffset).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) {
            return;
        }

        const argumentText = content.slice(colonOffset + 1);
        const argumentBaseOffset = contentStart + colonOffset + 1;
        const arguments_ = splitTopLevelSegments(argumentText, ',')
            .map(segment => trimSegment(segment, argumentBaseOffset));

        if (generatorExpressionOperationRoots.has(root)) {
            this.addPlainSegment(
                token,
                arguments_[0],
                TokenType.keyword,
                TokenPriority.contextualKeyword,
                /^[A-Z][A-Z0-9_]*$/,
            );
            return;
        }
        if (generatorExpressionEnumRoots.has(root)) {
            for (const argument of arguments_) {
                this.addPlainSegment(
                    token,
                    argument,
                    TokenType.enum,
                    TokenPriority.contextualSymbol,
                    /^[A-Za-z0-9_.+-]+$/,
                );
            }
            return;
        }
        if (root === 'TARGET_PROPERTY') {
            if (arguments_.length === 1) {
                this.addPlainSegment(token, arguments_[0], TokenType.property, TokenPriority.contextualSymbol);
            } else {
                this.addPlainSegment(token, arguments_[0], TokenType.target, TokenPriority.contextualSymbol);
                this.addPlainSegment(token, arguments_[1], TokenType.property, TokenPriority.contextualSymbol);
            }
            return;
        }
        if (root === 'TARGET_GENEX_EVAL') {
            this.addPlainSegment(token, arguments_[0], TokenType.target, TokenPriority.contextualSymbol);
            return;
        }
        if (GENERATOR_EXPRESSION_TARGET_ROOTS.has(root)) {
            this.addPlainSegment(token, arguments_[0], TokenType.target, TokenPriority.contextualSymbol);
        }
    }

    private finalize(): SemanticTokenDescriptor[] {
        const orderedByPriority = Array.from(this.candidates.values()).sort((left, right) =>
            right.priority - left.priority
            || (tokenTypeRank.get(right.tokenType) ?? 0) - (tokenTypeRank.get(left.tokenType) ?? 0)
            || left.length - right.length
            || left.line - right.line
            || left.character - right.character,
        );
        const accepted: SemanticTokenCandidate[] = [];
        for (const candidate of orderedByPriority) {
            if (!accepted.some(existing => rangesOverlap(existing, candidate))) {
                accepted.push(candidate);
            }
        }
        return accepted
            .sort((left, right) =>
                left.line - right.line
                || left.character - right.character
                || left.length - right.length,
            )
            .map(candidate => ({
                line: candidate.line,
                character: candidate.character,
                length: candidate.length,
                tokenType: candidate.tokenType,
                modifiers: Array.from(candidate.modifiers).sort(),
            }));
    }
}

export function collectSemanticTokens(input: SemanticHighlightInput): SemanticTokenDescriptor[] {
    return new SemanticTokenCollector(input).collect();
}

function appendTokens(builder: SemanticTokensBuilder, tokens: readonly SemanticTokenDescriptor[]): void {
    for (const token of tokens) {
        const tokenTypeIndex = tokenTypes.indexOf(token.tokenType);
        if (tokenTypeIndex !== -1) {
            builder.push(
                token.line,
                token.character,
                token.length,
                tokenTypeIndex,
                encodeTokenModifiers(token.modifiers),
            );
        }
    }
}

export class SemanticTokensService {
    private readonly builders = new Map<string, SemanticTokensBuilder>();
    private readonly analyses = new Map<string, {
        key: string;
        tokens: SemanticTokenDescriptor[];
    }>();

    analyze(uri: string, key: string, input: SemanticHighlightInput): readonly SemanticTokenDescriptor[] {
        const cached = this.analyses.get(uri);
        if (cached?.key === key) {
            return cached.tokens;
        }
        const tokens = collectSemanticTokens(input);
        this.analyses.set(uri, { key, tokens });
        return tokens;
    }

    buildFull(uri: string, tokens: readonly SemanticTokenDescriptor[]): SemanticTokens {
        const builder = new SemanticTokensBuilder();
        appendTokens(builder, tokens);
        const result = builder.build();
        this.builders.set(uri, builder);
        return result;
    }

    buildDelta(
        uri: string,
        previousResultId: string,
        tokens: readonly SemanticTokenDescriptor[],
    ): SemanticTokens | SemanticTokensDelta {
        const builder = this.builders.get(uri);
        if (!builder) {
            return this.buildFull(uri, tokens);
        }
        builder.previousResult(previousResultId);
        appendTokens(builder, tokens);
        return builder.buildEdits();
    }

    delete(uri: string): void {
        this.builders.delete(uri);
        this.analyses.delete(uri);
    }

    clear(): void {
        this.builders.clear();
        this.analyses.clear();
    }
}
