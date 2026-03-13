import { Token } from "antlr4";
import { InitializeParams, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import * as builtinCmds from './builtin-cmds.json';
import { CONDITION_BINARY_KEYWORDS, CONDITION_UNARY_KEYWORDS, getConditionExpectation } from "./completion";
import { AddSubDirectoryCmdContext, ArgumentContext, ElseIfCmdContext, ForeachCmdContext, FunctionCmdContext, IfCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext, WhileCmdContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";
import { SymbolIndex, SymbolKind } from "./symbolIndex";

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
    declaration = 2 ** 0,
    definition = 2 ** 1,
    readonly = 2 ** 2,
    deprecated = 2 ** 3,
    documentation = 2 ** 4,
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

export const tokenBuilders: Map<string, SemanticTokensBuilder> = new Map();

export function getTokenBuilder(uri: string): SemanticTokensBuilder {
    let builder = tokenBuilders.get(uri);
    if (builder !== undefined) {
        return builder;
    }
    builder = new SemanticTokensBuilder();
    tokenBuilders.set(uri, builder);
    return builder;
}

export function getTokenTypes(initParams: InitializeParams): string[] {
    const supportedTokenTypes = initParams.capabilities.textDocument?.semanticTokens?.tokenTypes;
    if (!supportedTokenTypes || supportedTokenTypes.length === 0) {
        tokenTypes = [...defaultTokenTypes];
        return tokenTypes;
    }

    tokenTypes = defaultTokenTypes.filter(value => supportedTokenTypes.includes(value));
    return tokenTypes;
}

export function getTokenModifiers(initParams: InitializeParams): string[] {
    const supportedTokenModifiers = initParams.capabilities.textDocument?.semanticTokens?.tokenModifiers;
    if (!supportedTokenModifiers || supportedTokenModifiers.length === 0) {
        tokenModifiers = [...defaultTokenModifiers];
        return tokenModifiers;
    }

    tokenModifiers = defaultTokenModifiers.filter(value => supportedTokenModifiers.includes(value));
    return tokenModifiers;
}

export class SemanticTokenListener extends CMakeParserListener {
    // private _data: number[] = [];
    private _builder: SemanticTokensBuilder;
    private _uri: string;
    private symbolIndex: SymbolIndex;
    private entryUri: string;
    private _visibleFiles: string[] | null = null;
    private emittedTokens: Set<string> = new Set();

    constructor(uri: string, symbolIndex: SymbolIndex, entryUri: string) {
        super();
        this._uri = uri;
        this.symbolIndex = symbolIndex;
        this.entryUri = entryUri;
        this._builder = getTokenBuilder(uri);
    }

    private normalizeVariableName(token: string): string {
        const match = token.match(/^\$\{(.+)\}$/);
        return match ? match[1] : token;
    }

    private isVariable(token: string): boolean {
        token = this.normalizeVariableName(token);

        if (this._visibleFiles === null) {
            this._visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryUri, this._uri);
        }

        // Fast path: if the variable is defined in the current file
        const currentCache = this.symbolIndex.getCache(this._uri);
        if (currentCache && currentCache.variables.has(token)) {
            return true;
        }

        // Global path: check visible files
        for (const uri of this._visibleFiles) {
            const cache = this.symbolIndex.getCache(uri);
            if (cache && cache.variables.has(token)) {
                return true;
            }
        }

        // Fallback: check built-in system cache variables (and properties if needed)
        const systemCache = this.symbolIndex.getSystemCache();
        if (systemCache && systemCache.variables.has(token)) {
            return true;
        }

        return false;
    }

    private tokenVariableReferences(argCtx: ArgumentContext): void {
        const text = argCtx.getText();
        const variablePattern = /\$\{([^}]+)\}/g;
        let match: RegExpExecArray | null;

        while ((match = variablePattern.exec(text)) !== null) {
            const variableName = match[1];
            if (!this.isVariable(variableName)) {
                continue;
            }

            this.pushToken(
                argCtx.start.line - 1,
                argCtx.start.column + match.index + 2,
                variableName.length,
                TokenTypes.variable,
                []
            );
        }
    }

    private splitTopLevelGenexSegments(text: string, separator: ':' | ','): string[] {
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

    private pushTextToken(argCtx: ArgumentContext, text: string, fromOffset: number, tokenType: string): void {
        const textOffset = argCtx.getText().indexOf(text, fromOffset);
        if (textOffset === -1) {
            return;
        }

        this.pushToken(
            argCtx.start.line - 1,
            argCtx.start.column + textOffset,
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

        const textOffset = argCtx.getText().indexOf(trimmed, fromOffset);
        if (textOffset === -1) {
            return fromOffset + segment.length + 1;
        }

        this.pushToken(
            argCtx.start.line - 1,
            argCtx.start.column + textOffset,
            trimmed.length,
            tokenType,
            []
        );
        return textOffset + trimmed.length + 1;
    }

    private tokenGeneratorExpressionArguments(argCtx: ArgumentContext, root: string, args: string[], argsOffset: number): void {
        let searchOffset = argsOffset;
        const targetArtifactRoots = new Set([
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

        if (targetArtifactRoots.has(root) && args.length > 0) {
            this.pushTrimmedSegmentToken(argCtx, args[0], searchOffset, TokenTypes.string);
        }
    }

    private tokenGeneratorExpression(argCtx: ArgumentContext, content: string, baseOffset: number): void {
        const colonSegments = this.splitTopLevelGenexSegments(content, ':');
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
        const args = this.splitTopLevelGenexSegments(argumentText, ',');
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
        let result = 0;
        for (let modifier of modifiers) {
            result |= modifier;
        }

        return result;
    }

    public buildEdits() {
        return this._builder.buildEdits();
    }

    private pushToken(line: number, column: number, length: number, tokenType: string, modifiers: TokenModifiers[]): void {
        const tokenTypeIndex = tokenTypes.indexOf(tokenType);
        if (tokenTypeIndex === -1) {
            return;
        }

        const modifiersValue = this.getModifiers(modifiers);
        const key = `${line}:${column}:${length}:${tokenTypeIndex}:${modifiersValue}`;
        if (this.emittedTokens.has(key)) {
            return;
        }

        this.emittedTokens.add(key);
        this._builder.push(line, column, length, tokenTypeIndex, modifiersValue);
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
            } else if (this.isVariable(text)) {
                this.pushToken(argToken.line - 1, argToken.column, argToken.text.length, TokenTypes.variable, []);
            }
        });
    }

    private tokenInFunctionOrMacro(ctx: FunctionCmdContext | MacroCmdContext, tokenType: string): void {
        const argCount = ctx.argument_list().length;
        if (argCount > 0) {
            const varCtx = ctx.argument(0);
            const varToken: Token = varCtx.start;
            this.pushToken(
                varToken.line - 1,
                varToken.column,
                varToken.text.length,
                tokenType,
                [TokenModifiers.declaration, TokenModifiers.definition]
            );
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
    }

    enterIfCmd = (ctx: IfCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterElseIfCmd = (ctx: ElseIfCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterForeachCmd = (ctx: ForeachCmdContext): void => {

    };

    enterWhileCmd = (ctx: WhileCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterArgument = (ctx: ArgumentContext): void => {
        this.tokenVariableReferences(ctx);
        this.tokenGeneratorExpressions(ctx);
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.tokenInFunctionOrMacro(ctx, TokenTypes.function);
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.tokenInFunctionOrMacro(ctx, TokenTypes.macro);
    };

    enterSetCmd = (ctx: SetCmdContext): void => {
        const argCount = ctx.argument_list().length;
        if (argCount > 0) {
            const varCtx = ctx.argument(0);
            const varToken: Token = varCtx.start;
            this.pushToken(varToken.line - 1, varToken.column, varToken.text.length,
                TokenTypes.variable,
                [TokenModifiers.declaration, TokenModifiers.definition]);
        }
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.enterSetCmd(ctx as unknown as SetCmdContext);
    };

    enterIncludeCmd = (ctx: IncludeCmdContext): void => {

    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {

    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
        const commandToken: Token = ctx.ID().symbol;
        const cmdNameLower: string = commandToken.text.toLowerCase();

        switch (cmdNameLower) {
            case 'add_executable':
            case 'add_library':
            case 'target_compile_definitions':
            case 'target_compile_features':
            case 'target_compile_options':
            case 'target_include_directories':
            case 'target_link_directories':
            case 'target_link_libraries':
            case 'target_link_options':
            case 'target_precompile_headers':
            case 'target_sources':
            case 'find_package':
            case 'project':
                {
                    const args: ArgumentContext[] = ctx.argument_list();
                    if (args.length > 0) {
                        const targetToken: Token = args[0].start;
                        this.pushToken(
                            targetToken.line - 1,
                            targetToken.column,
                            targetToken.text.length,
                            TokenTypes.string,
                            [TokenModifiers.declaration, TokenModifiers.definition]
                        );
                    }
                }
                break;
            default:
                break;
        }

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
        } else {
            // Differentiate functions vs macros via SymbolIndex
            let isMacro = false;
            for (const cache of this.symbolIndex.getAllCaches()) {
                const commandSymbols = cache.commands.get(cmdNameLower);
                if (commandSymbols && commandSymbols.some(s => s.kind === SymbolKind.Macro)) {
                    isMacro = true;
                    break;
                }
            }
            const tokenType = isMacro ? TokenTypes.macro : TokenTypes.function;

            this.pushToken(
                commandToken.line - 1,
                commandToken.column,
                commandToken.text.length,
                tokenType,
                []
            );
        }
    };

    public getSemanticTokens(): SemanticTokens {
        return this._builder.build();
    }
}