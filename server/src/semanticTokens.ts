import { Token } from "antlr4";
import { InitializeParams, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import { URI } from "vscode-uri";
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from "./cmakeInfo";
import { AddSubDirectoryCmdContext, ArgumentContext, ElseIfCmdContext, ForeachCmdContext, FunctionCmdContext, IfCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext, WhileCmdContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";

let tokenTypes = [
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

let tokenModifiers = [
    'declaration',
    'definition',
    'readonly',
    'deprecated',
    'documentation',
];

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
    tokenTypes = tokenTypes.filter(value => {
        return initParams.capabilities.textDocument?.semanticTokens?.tokenTypes.includes(value);
    });
    return tokenTypes;
}

export function getTokenModifiers(initParams: InitializeParams): string[] {
    tokenModifiers = tokenModifiers.filter(value => {
        return initParams.capabilities.textDocument?.semanticTokens?.tokenModifiers.includes(value);
    });
    return tokenModifiers;
}

export class SemanticTokenListener extends CMakeParserListener {
    // private _data: number[] = [];
    private _builder: SemanticTokensBuilder;
    private _uri: URI;
    private cmakeInfo: CMakeInfo;

    private _operator: Set<string> = new Set([
        'EXISTS', 'COMMAND', 'DEFINED',
        'EQUAL', 'LESS', 'LESS_EQUAL', 'GREATER', 'GREATER_EAUAL', 'STREQUAL',
        'STRLESS', 'STRLESS_EQUAL', 'STRGREATER', 'STRGREATER_EQUAL',
        'VERSION_EQUAL', 'VERSION_LESS', 'VERSION_LESS_EQUAL', 'VERSION_GREATER',
        'VERSION_GREATER_EQUAL', 'PATH_EQUAL', 'MATCHES',
        'AND', 'NOT', 'OR'
    ]);

    constructor(uri: URI, cmakeInfo: CMakeInfo) {
        super();
        this._uri = uri;
        this.cmakeInfo = cmakeInfo;
        this._builder = getTokenBuilder(uri.toString());
    }

    private isOperator(token: string): boolean {
        return this._operator.has(token);
    }

    private isVariable(token: string): boolean {
        return this.cmakeInfo.variables.includes(token);
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

    private getTokenBuilder(uri: string): SemanticTokensBuilder {
        let result = tokenBuilders.get(uri);
        if (result !== undefined) {
            return result;
        }

        result = new SemanticTokensBuilder();
        tokenBuilders.set(uri, result);
        return result;
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
            const sigs: string[] = builtinCmds[cmdNameLower]['sig'];
            const keywords = builtinCmds[cmdNameLower]['keyword'] ?? [];
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
            this._builder.push(
                commandToken.line - 1,
                commandToken.column,
                commandToken.text.length,
                tokenTypes.indexOf(TokenTypes.function),
                this.getModifiers([])
            );
        }
    };

    public getSemanticTokens(): SemanticTokens {
        return this._builder.build();
    }
}