import { SemanticTokens, SemanticTokensBuilder } from "vscode-languageserver";
import { URI } from "vscode-uri";
import Token from "./parser/antlr4/Token";
import CMakeListener from "./parser/CMakeListener";
import { initParams, logger } from "./server";
import * as builtinCmds from './builtin-cmds.json';
import { cmakeInfo } from "./cmakeInfo";

export let tokenTypes = [
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

export let tokenModifiers = [
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

export function getTokenTypes(): string[] {
    tokenTypes = tokenTypes.filter((value, index, arr) => {
        return initParams.capabilities.textDocument.semanticTokens.tokenTypes.includes(value);
    });
    return tokenTypes;
}

export function getTokenModifiers(): string[] {
    tokenModifiers = tokenModifiers.filter((value, index, arr) => {
        return initParams.capabilities.textDocument.semanticTokens.tokenModifiers.includes(value);
    });
    return tokenModifiers;
}

export class SemanticListener extends CMakeListener {
    // private _data: number[] = [];
    private _builder: SemanticTokensBuilder;
    private _uri: URI;

    private _operator: string[] = [
        'EXISTS', 'COMMAND', 'DEFINED',
        'EQUAL', 'LESS', 'LESS_EQUAL', 'GREATER', 'GREATER_EAUAL', 'STREQUAL',
        'STRLESS', 'STRLESS_EQUAL', 'STRGREATER', 'STRGREATER_EQUAL',
        'VERSION_EQUAL', 'VERSION_LESS', 'VERSION_LESS_EQUAL', 'VERSION_GREATER',
        'VERSION_GREATER_EQUAL', 'PATH_EQUAL', 'MATCHES',
        'AND', 'NOT', 'OR'
    ];

    constructor(uri: URI) {
        super();
        this._uri = uri;
        this._builder = getTokenBuilder(uri.toString());
    }

    private isOperator(token: string): boolean {
        return this._operator.includes(token);
    }

    private isVariable(token: string): boolean {
        return cmakeInfo.variables.includes(token);
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

    // private getTokenBuilder(uri: string): SemanticTokensBuilder {
    //     let result = tokenBuilders.get(uri);
    //     if (result !== undefined) {
    //         return result;
    //     }

    //     result = new SemanticTokensBuilder();
    //     tokenBuilders.set(uri, result);
    //     return result;
    // }

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

    enterIfCmd(ctx: any): void {
        ctx.argument().forEach(argCtx => {
            if (argCtx.getChildCount() === 1) {
                const argToken: Token = argCtx.start;
                if (this.isOperator(argToken.text)) {
                    // this._builder.push(argToken.line - 1, argToken.column,
                    //     argToken.text.length, tokenTypes.indexOf(TokenTypes.keyword),
                    //     this.getModifiers([]));
                } else if (this.isVariable(argToken.text)) {
                    this._builder.push(argToken.line - 1, argToken.column,
                        argToken.text.length, tokenTypes.indexOf(TokenTypes.variable),
                        this.getModifiers([]));
                }
            }
        });
    }

    enterElseIfCmd(ctx: any): void {
        this.enterIfCmd(ctx);
    }

    enterForeachCmd(ctx: any): void {

    }


    enterWhileCmd(ctx: any): void {
        this.enterIfCmd(ctx);
    }

    enterFunctionCmd(ctx: any): void {
        const argCount = ctx.argument().length;
        if (argCount > 1) {
            ctx.argument().slice(1).forEach(argCtx => {
                if (argCtx.getChildCount() === 1) {
                    const argToken: Token = argCtx.start;
                    this._builder.push(argToken.line - 1, argToken.column, argToken.text.length,
                        tokenTypes.indexOf(TokenTypes.parameter), this.getModifiers([]));
               }
            });
        }
    }

    enterMacroCmd(ctx: any): void {
        this.enterFunctionCmd(ctx);
    }

    enterSetCmd(ctx: any): void {
        const argCount = ctx.argument().length;
        if (argCount > 0) {
            const varCtx = ctx.argument(0);
            const varToken: Token = varCtx.start;
            this._builder.push(varToken.line - 1, varToken.column, varToken.text.length,
                tokenTypes.indexOf(TokenTypes.variable),
                this.getModifiers([TokenModifiers.definition]));
        }
    }

    enterOptionCmd(ctx: any): void {

    }

    enterIncludeCmd(ctx: any): void {

    }

    enterAddSubDirCmd(ctx: any): void {

    }

    enterOtherCmd(ctx: any): void {
        const cmdName: Token = ctx.ID().symbol;
        const cmdNameLower: string = cmdName.text.toLowerCase();
        if (cmdNameLower in builtinCmds) {
            if ('deprecated' in builtinCmds[cmdNameLower]) {
                this._builder.push(cmdName.line - 1, cmdName.column,
                    cmdName.text.length, tokenTypes.indexOf(TokenTypes.function),
                    this.getModifiers([TokenModifiers.deprecated]));
            }

            const sigs: string[] = builtinCmds[cmdNameLower]['sig'];
            const keywords = this.getCmdKeyWords(sigs);
            if (ctx.argument().length > 0) {
                ctx.argument().forEach(argCtx => {
                    if (argCtx.getChildCount() === 1) {
                        const argToken: Token = argCtx.start;
                        logger.debug("cmd:", cmdName.text, "keywords:", keywords);
                        if (keywords.includes(argToken.text)) {
                            this._builder.push(argToken.line - 1, argToken.column,
                                argToken.text.length, tokenTypes.indexOf(TokenTypes.property),
                                this.getModifiers([]));    
                        }
                   }
                });
            }
        } else {
            this._builder.push(cmdName.line - 1, cmdName.column,
                cmdName.text.length, tokenTypes.indexOf(TokenTypes.function),
                this.getModifiers([]));
        }
    }

    public getSemanticTokens(): SemanticTokens {
        return this._builder.build();
    }
}