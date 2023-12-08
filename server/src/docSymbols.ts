import { ParserRuleContext, Token } from "antlr4";
import { DocumentSymbol, SymbolKind } from "vscode-languageserver-protocol";
import { ArgumentContext, EndFunctionCmdContext, EndMacroCmdContext, FileContext, FunctionCmdContext, MacroCmdContext, MacroOrFuncDefContext, SetCmdContext } from "./generated/CMakeParser";
import CMakeListener from "./generated/CMakeParserListener";

export class SymbolListener extends CMakeListener {
    private _symbols: DocumentSymbol[] = [];
    private _inFunction: boolean = false;
    private _symbolsInFunction: DocumentSymbol;

    private makeSymbol(token: Token, kind: SymbolKind): DocumentSymbol {
        return {
            name: token.text,
            kind: kind,
            range: {
                start: {
                    line: token.line - 1,
                    character: token.column
                },
                end: {
                    line: token.line - 1,
                    character: token.column + token.text.length
                }
            },
            selectionRange: {
                start: {
                    line: token.line - 1,
                    character: token.column
                },
                end: {
                    line: token.line - 1,
                    character: token.column + token.text.length
                }
            }
        };
    }

    private inGlobalScope(ctx: ParserRuleContext): boolean {
        let inGlobal = true;
        while (true) {
            if (!ctx.parentCtx) {
                break;
            }
            if (ctx.parentCtx instanceof MacroOrFuncDefContext) {
                inGlobal = false;
                break;
            }
            ctx = ctx.parentCtx;
        }
        return inGlobal;
    }

    enterSetCmd = (ctx: SetCmdContext): void => {
        const argCtx: ArgumentContext = ctx.argument(0);
        if (argCtx) {
            if (this._inFunction) {
                this._symbolsInFunction.children.push(this.makeSymbol(argCtx.start, SymbolKind.Variable));
            } else {
                this._symbols.push(this.makeSymbol(argCtx.start, SymbolKind.Variable));
            }
        }
    };

    enterOptionCmd = (ctx: any): void => {
        this.enterSetCmd(ctx);
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.enterFuncOrMacroCmd(ctx);
    };

    enterEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.enterEndFuncOrMacroCmd(ctx);
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.enterFuncOrMacroCmd(ctx);
    };

    enterEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        this.enterEndFuncOrMacroCmd(ctx);
    };

    getSymbols(): DocumentSymbol[] {
        return this._symbols;
    }

    private enterFuncOrMacroCmd(ctx: FunctionCmdContext | MacroCmdContext) {
        this._inFunction = true;
        const argCtx = ctx.argument(0);
        if (argCtx) {
            this._symbolsInFunction = this.makeSymbol(argCtx.start, SymbolKind.Function);
            this._symbolsInFunction.children = [];
        }
    }

    private enterEndFuncOrMacroCmd(ctx: EndFunctionCmdContext | EndMacroCmdContext) {
        this._inFunction = false;
        this._symbols.push(this._symbolsInFunction);
    }
}