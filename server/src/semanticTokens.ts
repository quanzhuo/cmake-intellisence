import { Token } from "antlr4";
import { InitializeParams, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import * as builtinCmds from './builtin-cmds.json';
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
    tokenTypes = defaultTokenTypes.filter(value => {
        return initParams.capabilities.textDocument?.semanticTokens?.tokenTypes.includes(value);
    });
    return tokenTypes;
}

export function getTokenModifiers(initParams: InitializeParams): string[] {
    tokenModifiers = defaultTokenModifiers.filter(value => {
        return initParams.capabilities.textDocument?.semanticTokens?.tokenModifiers.includes(value);
    });
    return tokenModifiers;
}

export class SemanticTokenListener extends CMakeParserListener {
    // private _data: number[] = [];
    private _builder: SemanticTokensBuilder;
    private _uri: string;
    private symbolIndex: SymbolIndex;
    private entryUri: string;
    private _visibleFiles: string[] | null = null;

    private _operator: Set<string> = new Set([
        'EXISTS', 'COMMAND', 'DEFINED',
        'EQUAL', 'LESS', 'LESS_EQUAL', 'GREATER', 'GREATER_EQUAL', 'STREQUAL',
        'STRLESS', 'STRLESS_EQUAL', 'STRGREATER', 'STRGREATER_EQUAL',
        'VERSION_EQUAL', 'VERSION_LESS', 'VERSION_LESS_EQUAL', 'VERSION_GREATER',
        'VERSION_GREATER_EQUAL', 'PATH_EQUAL', 'MATCHES',
        'AND', 'NOT', 'OR'
    ]);

    constructor(uri: string, symbolIndex: SymbolIndex, entryUri: string) {
        super();
        this._uri = uri;
        this.symbolIndex = symbolIndex;
        this.entryUri = entryUri;
        this._builder = getTokenBuilder(uri);
    }

    private isOperator(token: string): boolean {
        return this._operator.has(token);
    }

    private isVariable(token: string): boolean {
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
        return false;
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

    private tokenInConditional(context: IfCmdContext | ElseIfCmdContext | WhileCmdContext): void {
        context.argument_list().forEach((argCtx: ArgumentContext) => {
            if (argCtx.getChildCount() === 1) {
                return;
            }
            const argToken: Token = argCtx.start;
            if (this.isOperator(argToken.text)) {
                // this._builder.push(argToken.line - 1, argToken.column,
                //     argToken.text.length, tokenTypes.indexOf(TokenTypes.keyword),
                //     this.getModifiers([]));
            } else if (this.isVariable(argToken.text)) {
                this._builder.push(argToken.line - 1, argToken.column, argToken.text.length,
                    tokenTypes.indexOf(TokenTypes.variable),
                    this.getModifiers([])
                );
            }
        });
    }

    private tokenInFunctionOrMacro(ctx: FunctionCmdContext | MacroCmdContext, tokenType: string): void {
        const argCount = ctx.argument_list().length;
        if (argCount > 0) {
            const varCtx = ctx.argument(0);
            const varToken: Token = varCtx.start;
            this._builder.push(
                varToken.line - 1,
                varToken.column,
                varToken.text.length,
                tokenTypes.indexOf(tokenType),
                this.getModifiers([TokenModifiers.declaration, TokenModifiers.definition])
            );
            if (argCount > 1) {
                ctx.argument_list().slice(1).forEach(argCtx => {
                    if (argCtx.getChildCount() === 1) {
                        const argToken: Token = argCtx.start;
                        this._builder.push(
                            argToken.line - 1,
                            argToken.column,
                            argToken.text.length,
                            tokenTypes.indexOf(TokenTypes.parameter),
                            this.getModifiers([])
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
            this._builder.push(varToken.line - 1, varToken.column, varToken.text.length,
                tokenTypes.indexOf(TokenTypes.variable),
                this.getModifiers([TokenModifiers.declaration, TokenModifiers.definition]));
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
                        this._builder.push(
                            targetToken.line - 1,
                            targetToken.column,
                            targetToken.text.length,
                            tokenTypes.indexOf(TokenTypes.string),
                            this.getModifiers([TokenModifiers.declaration, TokenModifiers.definition])
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
                    this._builder.push(
                        argToken.line - 1,
                        argToken.column,
                        argToken.text.length,
                        tokenTypes.indexOf(TokenTypes.type),
                        this.getModifiers([])
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

            this._builder.push(
                commandToken.line - 1,
                commandToken.column,
                commandToken.text.length,
                tokenTypes.indexOf(tokenType),
                this.getModifiers([])
            );
        }
    };

    public getSemanticTokens(): SemanticTokens {
        return this._builder.build();
    }
}