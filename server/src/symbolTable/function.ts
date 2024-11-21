import { ParseTree, ParseTreeWalker, Token } from 'antlr4';
import { URI } from "vscode-uri";
import { AddSubDirectoryCmdContext, ArgumentContext, EndFunctionCmdContext, EndMacroCmdContext, FunctionCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext } from "../generated/CMakeParser";
import CMakeListener from "../generated/CMakeParserListener";
import { getFileContext, getIncludeFileUri, getSubCMakeListsUri } from "../utils";
import { DefinationListener, incToBaseDir, refToDef } from "./goToDefination";
import { FileScope, FunctionScope, MacroScope, Scope } from "./scope";
import { Sym, Type } from "./symbol";

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

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        const funcToken: Token = ctx.argument(0)?.start;
        if (funcToken === undefined) {
            return;
        }

        // token.line start from 1
        if (funcToken.line - 1 === this.funcMacroSym.getLine() &&
            funcToken.column === this.funcMacroSym.getColumn()) {
            // we now enter the desired function
            this.inBody = true;
        }
    };

    exitEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.inBody = false;
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        // this.enterFunctionCmd(ctx);
        const funcToken: Token = ctx.argument(0)?.start;
        if (funcToken === undefined) {
            return;
        }

        // token.line start from 1
        if (funcToken.line - 1 === this.funcMacroSym.getLine() &&
            funcToken.column === this.funcMacroSym.getColumn()) {
            // we now enter the desired function
            this.inBody = true;
        }
    };

    exitEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        // this.exitEndFunctionCmd(ctx);
        this.inBody = false;
    };

    // FIXME: set command may be used in function/macro body
    enterSetCmd = (ctx: SetCmdContext): void => {
        if (!this.inBody) {
            return;
        }

        // create a variable symbol
        const varToken: Token = ctx.argument(0)?.start;
        if (varToken === undefined) {
            return;
        }

        const varSymbol: Sym = new Sym(varToken.text, Type.Variable,
            this.funcMacroSym.getUri(), varToken.line - 1, varToken.column);

        if (this.funcMacroSym.getType() === Type.Function) {
            // define variable in function, add variable to function scope
            this.currentScope.define(varSymbol);
        } else {
            // define variable in macro, add to parent scope
            this.currentScope.getEnclosingScope().define(varSymbol);
        }
    };

    // FIXME:
    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.enterSetCmd(ctx as unknown as SetCmdContext);
    };

    enterIncludeCmd = (ctx: IncludeCmdContext): void => {
        if (!this.inBody) {
            return;
        }

        const nameToken = ctx.argument(0)?.start;
        if (nameToken === undefined) {
            return;
        }

        // 获取包含该函数定义的文件的基路径
        const baseDir: URI = incToBaseDir.get(this.funcMacroSym.getUri().toString());
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
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        this.parseTreeProperty.set(ctx, false);
        if (!this.inBody) {
            return;
        }

        const dirToken: Token = ctx.argument(0)?.start;
        if (dirToken === undefined) {
            return;
        }

        const baseDir: URI = incToBaseDir.get(this.funcMacroSym.getUri().toString());
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
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };

    exitAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        if (!this.inBody) {
            return;
        }

        if (this.parseTreeProperty.get(ctx)) {
            this.currentScope = this.currentScope.getEnclosingScope();
        }
    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
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
    };

    enterArgument = (ctx: ArgumentContext): void => {
        if (!this.inBody) {
            return;
        }

        if (ctx.parentCtx instanceof FunctionCmdContext ||
            ctx.parentCtx instanceof MacroCmdContext) {
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
    };
}