import { Token } from "antlr4";
import { InitializeParams, SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import { URI } from "vscode-uri";
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from "./cmakeInfo";
import { AddSubDirectoryCmdContext, ArgumentContext, ElseIfCmdContext, ForeachCmdContext, FunctionCmdContext, IfCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext, WhileCmdContext } from "./generated/CMakeParser";
import CMakeListener from "./generated/CMakeParserListener";

let tokenTypes = [
    'type',
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
    'operator'
];

let tokenModifiers = [
    'definition',
    'readonly',
    'deprecated',
    'documentation'
];

enum TokenModifiers {
    definition = 2 ** 0,
    readonly = 2 ** 1,
    deprecated = 2 ** 2,
    documentation = 2 ** 3
};

enum TokenTypes {
    type = 'type',
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

export class SemanticListener extends CMakeListener {
    // private _data: number[] = [];
    private _builder: SemanticTokensBuilder;
    private _uri: URI;
    private cmakeInfo: CMakeInfo;

    private _operator: string[] = [
        'EXISTS', 'COMMAND', 'DEFINED',
        'EQUAL', 'LESS', 'LESS_EQUAL', 'GREATER', 'GREATER_EAUAL', 'STREQUAL',
        'STRLESS', 'STRLESS_EQUAL', 'STRGREATER', 'STRGREATER_EQUAL',
        'VERSION_EQUAL', 'VERSION_LESS', 'VERSION_LESS_EQUAL', 'VERSION_GREATER',
        'VERSION_GREATER_EQUAL', 'PATH_EQUAL', 'MATCHES',
        'AND', 'NOT', 'OR'
    ];

    constructor(uri: URI, cmakeInfo: CMakeInfo) {
        super();
        this._uri = uri;
        this.cmakeInfo = cmakeInfo;
        this._builder = getTokenBuilder(uri.toString());
    }

    private isOperator(token: string): boolean {
        return this._operator.includes(token);
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

    private getCmdKeyWords(sigs: string[]): string[] {
        let result: string[] = [];
        sigs.forEach(sig => {
            const keys = sig.match(/\b[A-Z_]+\b/g);
            if (keys !== null) {
                keys.forEach(key => {
                    result.push(key);
                });
            }
        });

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

    private tokenInFunction(context: FunctionCmdContext | MacroCmdContext): void {
        const argCount = context.argument_list().length;
        if (argCount > 1) {
            context.argument_list().slice(1).forEach(argCtx => {
                if (argCtx.getChildCount() === 1) {
                    const argToken: Token = argCtx.start;
                    this._builder.push(argToken.line - 1, argToken.column, argToken.text.length,
                        tokenTypes.indexOf(TokenTypes.parameter), this.getModifiers([]));
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

    enterForeachCmd = (ctx: ForeachCmdContext): void => {

    };


    enterWhileCmd = (ctx: WhileCmdContext): void => {
        this.tokenInConditional(ctx);
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.tokenInFunction(ctx);
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.tokenInFunction(ctx);
    };

    enterSetCmd = (ctx: SetCmdContext): void => {
        const argCount = ctx.argument_list().length;
        if (argCount > 0) {
            const varCtx = ctx.argument(0);
            const varToken: Token = varCtx.start;
            this._builder.push(varToken.line - 1, varToken.column, varToken.text.length,
                tokenTypes.indexOf(TokenTypes.variable),
                this.getModifiers([TokenModifiers.definition]));
        }
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {

    };

    enterIncludeCmd = (ctx: IncludeCmdContext): void => {

    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {

    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
        const cmdName: Token = ctx.ID().symbol;
        const cmdNameLower: string = cmdName.text.toLowerCase();
        if (cmdNameLower in builtinCmds) {
            const sigs: string[] = builtinCmds[cmdNameLower]['sig'];
            const keywords = this.getCmdKeyWords(sigs);
            ctx.argument_list().forEach(argCtx => {
                if (argCtx.getChildCount() === 1) {
                    const argToken: Token = argCtx.start;
                    if (keywords.includes(argToken.text)) {
                        this._builder.push(
                            argToken.line - 1,
                            argToken.column,
                            argToken.text.length,
                            tokenTypes.indexOf(TokenTypes.property),
                            this.getModifiers([])
                        );
                    }
                }
            });
        } else {
            this._builder.push(
                cmdName.line - 1,
                cmdName.column,
                cmdName.text.length,
                tokenTypes.indexOf(TokenTypes.function),
                this.getModifiers([])
            );
        }
    };

    public getSemanticTokens(): SemanticTokens {
        return this._builder.build();
    }
}