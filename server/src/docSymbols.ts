import { Token } from "antlr4";
import { DocumentSymbol, Position, Range, SymbolKind } from "vscode-languageserver-protocol";
import { EndFunctionCmdContext, EndMacroCmdContext, FunctionCmdContext, MacroCmdContext, OptionCmdContext, SetCmdContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";

export class SymbolListener extends CMakeParserListener {
    private symbols: DocumentSymbol[] = [];
    private scopeStack: DocumentSymbol[] = [];

    private createDocumentSymbol(token: Token, kind: SymbolKind): DocumentSymbol {
        const position = Position.create(token.line - 1, token.column);
        const endPosition = Position.create(token.line - 1, token.column + token.text.length);
        const range: Range = Range.create(position, endPosition);

        return {
            name: token.text,
            kind: kind,
            range: range,
            selectionRange: range,
            children: []
        };
    }

    private pushSymbol(symbol: DocumentSymbol): void {
        if (this.scopeStack.length > 0) {
            const parent = this.scopeStack[this.scopeStack.length - 1];
            parent.children.push(symbol);
        } else {
            this.symbols.push(symbol);
        }
        this.scopeStack.push(symbol);
    }

    private popSymbol(): void {
        if (this.scopeStack.length > 0) {
            this.scopeStack.pop();
        }
    }

    private handleFunctionOrMacro(ctx: FunctionCmdContext | MacroCmdContext, kind: SymbolKind): void {
        const args = ctx.argument_list();
        if (!args || args.length === 0) {
            return;
        }
        const nameToken = args[0].start;
        const symbol = this.createDocumentSymbol(nameToken, kind);
        this.pushSymbol(symbol);
    }

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.handleFunctionOrMacro(ctx, SymbolKind.Function);
    };

    exitEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.popSymbol();
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.handleFunctionOrMacro(ctx, SymbolKind.Function);
    };

    exitEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        this.popSymbol();
    };

    private handleVariable(ctx: SetCmdContext | OptionCmdContext): void {
        const args = ctx.argument_list();
        if (!args || args.length === 0) {
            return;
        }
        const varNameToken = args[0].start;
        const varSymbol = this.createDocumentSymbol(varNameToken, SymbolKind.Variable);
        if (this.scopeStack.length > 0) {
            const currentScope = this.scopeStack[this.scopeStack.length - 1];
            currentScope.children.push(varSymbol);
        } else {
            this.symbols.push(varSymbol);
        }
    }

    enterSetCmd = (ctx: SetCmdContext): void => {
        this.handleVariable(ctx);
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.handleVariable(ctx);
    };

    getSymbols(): DocumentSymbol[] {
        return this.symbols;
    }
}