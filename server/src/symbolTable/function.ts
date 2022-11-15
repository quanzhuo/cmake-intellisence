import Token from "../parser/antlr4/Token";
import CMakeListener from "../parser/CMakeListener";
import CMakeParser from "../parser/CMakeParser";
import { DefinationListener, incToBaseDir, refToDef } from "./goToDefination";
import { FileScope, FunctionScope, MacroScope, Scope } from "./scope";
import { Sym, Type } from "./symbol";
import { getFileContext, getIncludeFileUri, getSubCMakeListsUri } from "../utils";
import antlr4 from "../parser/antlr4";
import ParseTree from "../parser/antlr4/tree/ParseTree";
import { URI } from "vscode-uri";

export class FuncMacroListener extends CMakeListener {
    private currentScope: Scope;
    private funcMacroSym: Sym;
    private inBody: boolean = false;

    private parseTreeProperty = new Map<ParseTree, boolean>();

    constructor(parent: Scope, symbol: Sym) {
        super();

        if (symbol.getType() === Type.Function) {
            this.currentScope = new FunctionScope(parent);
        } else {
            this.currentScope = new MacroScope(parent);
        }

        this.funcMacroSym = symbol;
    }

    enterFunctionCmd(ctx: any): void {
        const funcToken: Token = ctx.argument(0).start;
        // token.line start from 1
        if (funcToken.line - 1 === this.funcMacroSym.getLine() &&
            funcToken.column === this.funcMacroSym.getColumn()) {
            // we now enter the desired function
            this.inBody = true;
        }
    }

    exitEndFunctionCmd(ctx: any): void {
        this.inBody = false;
    }

    enterMacroCmd(ctx: any): void {
        this.enterFunctionCmd(ctx);
    }

    exitEndMacroCmd(ctx: any): void {
        this.exitEndFunctionCmd(ctx);
    }

    enterSetCmd(ctx: any): void {
        if (!this.inBody) {
            return;
        }

        // create a variable symbol
        const varToken: Token = ctx.argument(0).start;
        const varSymbol: Sym = new Sym(varToken.text, Type.Variable,
            this.funcMacroSym.getUri(), varToken.line - 1, varToken.column);

        if (this.funcMacroSym.getType() === Type.Function) {
            // define variable in function, add variable to function scope
            this.currentScope.define(varSymbol);
        } else {
            // define variable in macro, add to parent scope
            this.currentScope.getEnclosingScope().define(varSymbol);
        }
    }

    enterOptionCmd(ctx: any): void {
        this.enterSetCmd(ctx);
    }

    enterIncludeCmd(ctx: any): void {
        if (!this.inBody) {
            return;
        }

        const nameToken = ctx.argument(0).start;

        // 获取包含该函数定义的文件的基路径
        const baseDir: URI = incToBaseDir.get(this.funcMacroSym.getUri().fsPath);
        const incUri: URI = getIncludeFileUri(baseDir, nameToken.text);
        if (!incUri) {
            return;
        }

        // add included module to refDef
        const refPos: string = this.funcMacroSym.getUri() + '_' + (nameToken.line - 1) + '_' +
            nameToken.column + '_' + nameToken.text;
        refToDef.set(refPos, {
            uri: incUri.toString(),
            range: {
                start: {
                    line: 0,
                    character: 0
                },
                end: {
                    line: Number.MAX_VALUE,
                    character: Number.MAX_VALUE
                }
            }
        });

        const tree = getFileContext(incUri);
        const definationListener = new DefinationListener(baseDir, incUri, this.currentScope);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    }

    enterAddSubDirCmd(ctx: any): void {
        this.parseTreeProperty.set(ctx, false);
        if (!this.inBody) {
            return;
        }

        const dirToken: Token = ctx.argument(0).start;
        const baseDir: URI = incToBaseDir.get(this.funcMacroSym.getUri().fsPath);
        const subCMakeListsUri: URI = getSubCMakeListsUri(baseDir, dirToken.text);
        if (!subCMakeListsUri) {
            return;
        }

        this.parseTreeProperty.set(ctx, true);

        // add subdir CMakeLists.txt to refDef
        const refPos: string = this.funcMacroSym.getUri() + '_' + (dirToken.line - 1) + '_' +
            dirToken.column + '_' + dirToken.text;
        refToDef.set(refPos, {
            uri: subCMakeListsUri.toString(),
            range: {
                start: {
                    line: 0,
                    character: 0
                },
                end: {
                    line: Number.MAX_VALUE,
                    character: Number.MAX_VALUE
                }
            }
        });

        const tree = getFileContext(subCMakeListsUri);
        const subDirScope: Scope = new FileScope(this.currentScope);
        this.currentScope = subDirScope;
        const definationListener = new DefinationListener(baseDir, subCMakeListsUri, subDirScope);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    }

    exitAddSubDirCmd(ctx: any): void {
        if (!this.inBody) {
            return;
        }

        if (this.parseTreeProperty.get(ctx)) {
            this.currentScope = this.currentScope.getEnclosingScope();
        }
    }

    enterOtherCmd(ctx: any): void {
        if (!this.inBody) {
            return;
        }

        // command reference, resolve the defination
        const cmdToken: Token = ctx.ID().symbol;
        const symbol: Sym = this.currentScope.resolve(cmdToken.text, Type.Function);
        if (symbol === null) {
            return;
        }

        // token.line start from 1, so -1 first
        const refPos: string = this.funcMacroSym.getUri() + '_' + (cmdToken.line - 1) + '_' +
            cmdToken.column + '_' + cmdToken.text;

        // add to refToDef
        refToDef.set(refPos, symbol.getLocation());
    }

    enterArgument(ctx: any): void {
        if (!this.inBody) {
            return;
        }

        if (ctx.parentCtx instanceof CMakeParser.FunctionCmdContext ||
            ctx.parentCtx instanceof CMakeParser.MacroCmdContext) {
            if (ctx.getChildCount() !== 1) {
                return;
            }

            const token = ctx.start;
            // skip function/macro name
            // FIXME: if argument's name is same as function name
            if (token.text === this.funcMacroSym.getName()) {
                return;
            }

            // add function/macro argument to current scope
            const varSymbol: Sym = new Sym(token.text, Type.Variable,
                this.funcMacroSym.getUri(), token.line - 1, token.column);
            this.currentScope.define(varSymbol);

            // just return after parse function/macro formal parameter
            return;
        }


        // find all variable reference, resolve the defination, add to refToDef
        const argToken: Token = ctx.start;
        const regexp: RegExp = /\${(.*?)}/g;
        const matches = argToken.text.matchAll(regexp);
        for (let match of matches) {
            const varRef: string = match[1];
            const symbol: Sym = this.currentScope.resolve(varRef, Type.Variable);
            if (symbol === null) {
                continue;
            }

            // token.line start from 1, so - 1 first
            const refPos: string = this.funcMacroSym.getUri() + '_' + (argToken.line - 1) + '_' +
                (argToken.column + match.index + 2) + '_' + varRef;
            refToDef.set(refPos, symbol.getLocation());
        }
    }
}