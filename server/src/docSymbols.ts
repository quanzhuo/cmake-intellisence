import CMakeListener from "./parser/CMakeListener";
import { DocumentSymbol, SymbolKind } from "vscode-languageserver-protocol";

export class SymbolListener extends CMakeListener {
    private _symbols: DocumentSymbol[] = [];
    private _inFunction: boolean = false;
    private _symbolsInFunction: DocumentSymbol;

    private makeSymbol(token: any, kind: SymbolKind): DocumentSymbol {
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

    enterSetCmd(ctx: any): void {
        const argumentCtx = ctx.argument(0);
        if (argumentCtx !== null) {
            if (this._inFunction) {
                this._symbolsInFunction.children.push(this.makeSymbol(argumentCtx.start, SymbolKind.Variable));
            } else {
                this._symbols.push(this.makeSymbol(argumentCtx.start, SymbolKind.Variable));
            }
        }
    }

    enterOptionCmd(ctx: any): void {
        this.enterSetCmd(ctx);
    }

    enterFunctionCmd(ctx: any): void {
        this._inFunction = true;
        const argumentCtx = ctx.argument(0);
        if (argumentCtx !== null) {
            this._symbolsInFunction = this.makeSymbol(argumentCtx.start, SymbolKind.Function);
            this._symbolsInFunction.children = [];
        }
    }

    enterEndFunctionCmd(ctx: any): void {
        this._inFunction = false;
        this._symbols.push(this._symbolsInFunction);
    }

    enterMacroCmd(ctx: any): void {
        this.enterFunctionCmd(ctx);
    }

    enterEndMacroCmd(ctx: any): void {
        this.enterEndFunctionCmd(ctx);
    }

    getSymbols(): DocumentSymbol[] {
        return this._symbols;
    }
}