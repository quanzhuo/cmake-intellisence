import { Token } from "antlr4";
import { InitializeParams, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import * as builtinCmds from './builtin-cmds.json';
import { CONDITION_BINARY_KEYWORDS, CONDITION_UNARY_KEYWORDS, getConditionExpectation } from "./completion";
import { GENERATOR_EXPRESSION_TARGET_ROOTS, splitTopLevelGeneratorExpressionSegments } from './generatorExpressions';
import { ArgumentContext, ElseIfCmdContext, FunctionCmdContext, IfCmdContext, MacroCmdContext, OtherCmdContext, WhileCmdContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";
import { positionAtTextOffset, tokenStartPosition } from './sourcePosition';
import { SymbolBindingResolver } from "./symbolBinding";
import { FileSymbolCache, SymbolIndex, SymbolKind, SymbolOccurrence } from "./symbolIndex";

const defaultTokenTypes = [
    'namespace',
    'type',
    'class',
    'enum',
    'parameter',
    'variable',
    'property',
    'function',
    'macro',
    'keyword',
    'modifier',
    'comment',
    'string',
    'number',
    'regexp',
    'operator',
];

const defaultTokenModifiers = [
    'declaration',
    'definition',
    'readonly',
    'deprecated',
    'documentation',
];

let tokenTypes = [...defaultTokenTypes];
let tokenModifiers = [...defaultTokenModifiers];

enum TokenModifiers {
    declaration = 'declaration',
    definition = 'definition',
    readonly = 'readonly',
    deprecated = 'deprecated',
    documentation = 'documentation',
};

enum TokenTypes {
    namespace = 'namespace',
    type = 'type',
    class = 'class',
    enum = 'enum',
    parameter = 'parameter',
    variable = 'variable',
    property = 'property',
    function = 'function',
    macro = 'macro',
    keyword = 'keyword',
    modifier = 'modifier',
    comment = 'comment',
    string = 'string',
    number = 'number',
    regexp = 'regexp',
    operator = 'operator'
}

const tokenBuilders: Map<string, SemanticTokensBuilder> = new Map();

export function createTokenBuilder(uri: string): SemanticTokensBuilder {
    const builder = new SemanticTokensBuilder();
    tokenBuilders.set(uri, builder);
    return builder;
}

export function getTokenBuilder(uri: string): SemanticTokensBuilder {
    let builder = tokenBuilders.get(uri);
    if (builder !== undefined) {
        return builder;
    }
    builder = new SemanticTokensBuilder();
    tokenBuilders.set(uri, builder);
    return builder;
}

export function deleteTokenBuilder(uri: string): void {
    tokenBuilders.delete(uri);
}

export function getTokenTypes(initParams: InitializeParams): string[] {
    const supportedTokenTypes = initParams.capabilities.textDocument?.semanticTokens?.tokenTypes;
    if (!supportedTokenTypes) {
        tokenTypes = [...defaultTokenTypes];
        return tokenTypes;
    }

    tokenTypes = defaultTokenTypes.filter(value => supportedTokenTypes.includes(value));
    return tokenTypes;
}

export function getTokenModifiers(initParams: InitializeParams): string[] {
    const supportedTokenModifiers = initParams.capabilities.textDocument?.semanticTokens?.tokenModifiers;
    if (!supportedTokenModifiers) {
        tokenModifiers = [...defaultTokenModifiers];
        return tokenModifiers;
    }

    tokenModifiers = defaultTokenModifiers.filter(value => supportedTokenModifiers.includes(value));
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

export class SemanticTokenListener extends CMakeParserListener {
    private _builder: SemanticTokensBuilder;
    private _uri: string;
    private symbolIndex: SymbolIndex;
    private readonly bindingResolver: SymbolBindingResolver;
    private readonly pendingTokens = new Map<string, {
        line: number;
        column: number;
        length: number;
        tokenTypeIndex: number;
        modifiersValue: number;
    }>();
    private builderPopulated = false;

    constructor(
        uri: string,
        symbolIndex: SymbolIndex,
        entryUri: string,
        builder: SemanticTokensBuilder = new SemanticTokensBuilder(),
    ) {
        super();
        this._uri = uri;
        this.symbolIndex = symbolIndex;
        this._builder = builder;
        this.bindingResolver = new SymbolBindingResolver(symbolIndex, entryUri, uri);
    }

    private pushTextToken(argCtx: ArgumentContext, text: string, fromOffset: number, tokenType: string): void {
        const argumentText = argCtx.getText();
        const textOffset = argumentText.indexOf(text, fromOffset);
        if (textOffset === -1) {
            return;
        }

        const position = positionAtTextOffset(tokenStartPosition(argCtx.start), argumentText, textOffset);

        this.pushToken(
            position.line,
            position.character,
            text.length,
            tokenType,
            []
        );
    }

    private pushTrimmedSegmentToken(argCtx: ArgumentContext, segment: string, fromOffset: number, tokenType: string): number {
        const trimmed = segment.trim();
        if (trimmed.length === 0) {
            return fromOffset + segment.length + 1;
        }

        const argumentText = argCtx.getText();
        const textOffset = argumentText.indexOf(trimmed, fromOffset);
        if (textOffset === -1) {
            return fromOffset + segment.length + 1;
        }

        const position = positionAtTextOffset(tokenStartPosition(argCtx.start), argumentText, textOffset);

        this.pushToken(
            position.line,
            position.character,
            trimmed.length,
            tokenType,
            []
        );
        return textOffset + trimmed.length + 1;
    }

    private tokenGeneratorExpressionArguments(argCtx: ArgumentContext, root: string, args: string[], argsOffset: number): void {
        let searchOffset = argsOffset;
        if (root === 'STRING' || root === 'LIST' || root === 'PATH') {
            for (const arg of args) {
                const trimmed = arg.trim();
                if (/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?$/.test(trimmed)) {
                    searchOffset = this.pushTrimmedSegmentToken(argCtx, arg, searchOffset, TokenTypes.keyword);
                } else {
                    searchOffset += arg.length + 1;
                }
            }
            return;
        }

        if (root === 'CONFIG' || root === 'COMPILE_LANGUAGE' || root === 'LINK_LANGUAGE' || root === 'C_COMPILER_ID' || root === 'CXX_COMPILER_ID') {
            for (const arg of args) {
                searchOffset = this.pushTrimmedSegmentToken(argCtx, arg, searchOffset, TokenTypes.enum);
            }
            return;
        }

        if (root === 'TARGET_PROPERTY') {
            if (args.length === 1) {
                this.pushTrimmedSegmentToken(argCtx, args[0], searchOffset, TokenTypes.property);
                return;
            }

            searchOffset = this.pushTrimmedSegmentToken(argCtx, args[0], searchOffset, TokenTypes.string);
            this.pushTrimmedSegmentToken(argCtx, args[1], searchOffset, TokenTypes.property);
            return;
        }

        if (GENERATOR_EXPRESSION_TARGET_ROOTS.has(root) && args.length > 0) {
            this.pushTrimmedSegmentToken(argCtx, args[0], searchOffset, TokenTypes.string);
        }
    }

    private tokenGeneratorExpression(argCtx: ArgumentContext, content: string, baseOffset: number): void {
        const colonSegments = splitTopLevelGeneratorExpressionSegments(content, ':');
        if (colonSegments.length === 0) {
            return;
        }

        const root = colonSegments[0].trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(root)) {
            return;
        }

        this.pushTextToken(argCtx, root, baseOffset, TokenTypes.function);

        if (colonSegments.length === 1) {
            return;
        }

        const argumentText = colonSegments.slice(1).join(':');
        const args = splitTopLevelGeneratorExpressionSegments(argumentText, ',');
        this.tokenGeneratorExpressionArguments(argCtx, root, args, baseOffset + root.length + 1);
    }

    private tokenGeneratorExpressions(argCtx: ArgumentContext): void {
        const text = argCtx.getText();
        const stack: number[] = [];

        for (let index = 0; index < text.length; index++) {
            if (text[index] === '$' && text[index + 1] === '<') {
                stack.push(index);
                index++;
                continue;
            }

            if (text[index] === '>' && stack.length > 0) {
                const start = stack.pop()!;
                const content = text.slice(start + 2, index);
                this.tokenGeneratorExpression(argCtx, content, start + 2);
            }
        }
    }

    private getModifiers(modifiers: TokenModifiers[]): number {
        return encodeTokenModifiers(modifiers);
    }

    private pushToken(line: number, column: number, length: number, tokenType: string, modifiers: TokenModifiers[]): void {
        const tokenTypeIndex = tokenTypes.indexOf(tokenType);
        if (tokenTypeIndex === -1) {
            return;
        }

        const modifiersValue = this.getModifiers(modifiers);
        const key = `${line}:${column}:${length}`;
        if (this.pendingTokens.has(key)) {
            return;
        }

        this.pendingTokens.set(key, { line, column, length, tokenTypeIndex, modifiersValue });
    }

    private getCommandKind(cache: FileSymbolCache, occurrence: SymbolOccurrence): SymbolKind.Function | SymbolKind.Macro | undefined {
        const localSymbol = cache.commands.get(occurrence.canonicalName)?.find(symbol =>
            symbol.line === occurrence.range.start.line
            && symbol.column === occurrence.range.start.character
            && (symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Macro)
        );
        if (localSymbol?.kind === SymbolKind.Function || localSymbol?.kind === SymbolKind.Macro) {
            return localSymbol.kind;
        }

        for (const declaration of this.bindingResolver.resolveDefinitions(occurrence, false).declarations) {
            const declarationCache = this.symbolIndex.getCache(declaration.uri);
            const symbol = declarationCache?.commands.get(declaration.canonicalName)?.find(candidate =>
                candidate.line === declaration.range.start.line
                && candidate.column === declaration.range.start.character
            );
            if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Macro) {
                return symbol.kind;
            }
        }
        return undefined;
    }

    private addIndexedSymbolTokens(): void {
        const cache = this.symbolIndex.getCache(this._uri);
        if (!cache) {
            return;
        }

        for (const occurrence of cache.occurrences) {
            const { start, end } = occurrence.range;
            if (start.line !== end.line || end.character <= start.character) {
                continue;
            }
            const modifiers = occurrence.role === 'declaration'
                ? [TokenModifiers.declaration, TokenModifiers.definition]
                : [];
            switch (occurrence.namespace) {
                case 'variable':
                case 'cache-variable':
                case 'environment-variable':
                    this.pushToken(start.line, start.character, end.character - start.character, TokenTypes.variable, modifiers);
                    break;
                case 'target':
                    this.pushToken(start.line, start.character, end.character - start.character, TokenTypes.string, modifiers);
                    break;
                case 'command': {
                    const kind = this.getCommandKind(cache, occurrence);
                    if (kind !== undefined) {
                        this.pushToken(
                            start.line,
                            start.character,
                            end.character - start.character,
                            kind === SymbolKind.Macro ? TokenTypes.macro : TokenTypes.function,
                            modifiers,
                        );
                    }
                    break;
                }
            }
        }
    }

    private populateBuilder(): void {
        if (this.builderPopulated) {
            return;
        }
        this.addIndexedSymbolTokens();
        const orderedTokens = Array.from(this.pendingTokens.values()).sort((left, right) =>
            left.line - right.line
            || left.column - right.column
            || left.length - right.length
        );
        for (const token of orderedTokens) {
            this._builder.push(
                token.line,
                token.column,
                token.length,
                token.tokenTypeIndex,
                token.modifiersValue,
            );
        }
        this.builderPopulated = true;
    }

    public buildEdits() {
        this.populateBuilder();
        return this._builder.buildEdits();
    }

    private tokenInConditional(context: IfCmdContext | ElseIfCmdContext | WhileCmdContext): void {
        const args = context.argument_list().map(arg => arg.getText());
        context.argument_list().forEach((argCtx: ArgumentContext, index: number) => {
            const argToken: Token = argCtx.start;
            const text = argToken.text;
            const normalized = text.toUpperCase();
            const expectation = getConditionExpectation(args, index);

            if ((expectation === 'operand' && normalized === 'NOT') || (expectation === 'operator' && (normalized === 'AND' || normalized === 'OR'))) {
                this.pushToken(argToken.line - 1, argToken.column, argToken.text.length, TokenTypes.operator, []);
            } else if (expectation === 'operator' && CONDITION_BINARY_KEYWORDS.includes(normalized)) {
                this.pushToken(argToken.line - 1, argToken.column, argToken.text.length, TokenTypes.operator, []);
            } else if (expectation === 'operand' && CONDITION_UNARY_KEYWORDS.includes(normalized)) {
                this.pushToken(argToken.line - 1, argToken.column, argToken.text.length, TokenTypes.keyword, []);
            }
        });
    }

    private tokenInFunctionOrMacro(ctx: FunctionCmdContext | MacroCmdContext): void {
        const argCount = ctx.argument_list().length;
        if (argCount > 1) {
            ctx.argument_list().slice(1).forEach(argCtx => {
                if (argCtx.getChildCount() === 1) {
                    const argToken: Token = argCtx.start;
                    this.pushToken(
                        argToken.line - 1,
                        argToken.column,
                        argToken.text.length,
                        TokenTypes.parameter,
                        []
                    );
                }
            });
        }
    }

    enterIfCmd = (ctx: IfCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterElseIfCmd = (ctx: ElseIfCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterWhileCmd = (ctx: WhileCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterArgument = (ctx: ArgumentContext): void => {
        this.tokenGeneratorExpressions(ctx);
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.tokenInFunctionOrMacro(ctx);
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.tokenInFunctionOrMacro(ctx);
    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
        const commandToken: Token = ctx.ID().symbol;
        const cmdNameLower: string = commandToken.text.toLowerCase();

        if (cmdNameLower in builtinCmds) {
            const keywords = (builtinCmds as Record<string, { keyword?: string[] }>)[cmdNameLower].keyword ?? [];
            const args: ArgumentContext[] = ctx.argument_list();
            args.forEach(argCtx => {
                const text = argCtx.getText();
                const argToken: Token = argCtx.start;
                if (keywords.includes(text)) {
                    this.pushToken(
                        argToken.line - 1,
                        argToken.column,
                        argToken.text.length,
                        TokenTypes.type,
                        []
                    );
                }
            });
        }
    };

    public getSemanticTokens(): SemanticTokens {
        this.populateBuilder();
        return this._builder.build();
    }
}
