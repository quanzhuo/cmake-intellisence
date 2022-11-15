import { Location } from "vscode-languageserver-types";
import antlr4 from '../parser/antlr4/index.js';
import Token from "../parser/antlr4/Token";
import ParseTree from "../parser/antlr4/tree/ParseTree.js";
import CMakeListener from "../parser/CMakeListener";
import { getFileContext, getIncludeFileUri, getSubCMakeListsUri } from "../utils";
import { FuncMacroListener } from "./function";
import { FileScope, FunctionScope, Scope } from "./scope";
import { Sym, Type } from "./symbol";

export const topScope: FileScope = new FileScope(null);

/**
 * key: <uri>_<line>_<column>_<word>
 * value: Location
 *
 * NOTE: line and column are numbers start from zero
 */
export const refToDef: Map<string, Location> = new Map();

export class DefinationListener extends CMakeListener {
    private currentScope: Scope;
    private inBody = false;
    private uri: string;

    private parseTreeProperty = new Map<ParseTree, boolean>();

    constructor(uri: string, scope: Scope) {
        super();
        this.uri = uri;
        this.currentScope = scope;
    }

    enterFunctionCmd(ctx: any): void {
        this.inBody = true;

        // create a function symbol
        const funcToken: Token = ctx.argument(0).start;
        const funcSymbol: Sym = new Sym(funcToken.text, Type.Function,
            this.uri, funcToken.line - 1, funcToken.column);

        // add to current scope
        this.currentScope.define(funcSymbol);
    }

    exitEndFunctionCmd(ctx: any): void {
        this.inBody = false;
    }

    enterMacroCmd(ctx: any): void {
        this.inBody = true;

        // create a macro symbol
        const macroToken: Token = ctx.argument(0).start;
        const macroSymbol: Sym = new Sym(macroToken.text, Type.Macro,
            this.uri, macroToken.line - 1, macroToken.column);

        // add macro to this scope
        this.currentScope.define(macroSymbol);
    }

    exitEndMacroCmd(ctx: any): void {
        this.inBody = false;
    }

    enterSetCmd(ctx: any): void {
        if (this.inBody) {
            return;
        }
    
        // create a variable symbol
        const varToken: Token = ctx.argument(0).start;
        const varSymbol: Sym = new Sym(varToken.text, Type.Variable,
            this.uri, varToken.line - 1, varToken.column);
        
        // add variable to current scope
        this.currentScope.define(varSymbol);
    }

    enterOptionCmd(ctx: any): void {
        this.enterSetCmd(ctx);
    }

    enterIncludeCmd(ctx: any): void {
        if (this.inBody) {
            return;
        }

        const nameToken = ctx.argument(0).start;
        const fileUri: string = getIncludeFileUri(this.uri, nameToken.text);
        if (!fileUri) {
            return;
        }

        // add included module to refDef
        const refPos: string = this.uri + '_' + (nameToken.line - 1) + '_' +
            nameToken.column + '_' + nameToken.text;
        refToDef.set(refPos, {
            uri: fileUri,
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

        const tree = getFileContext(fileUri);
        const definationListener = new DefinationListener(fileUri, this.currentScope);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    }

    enterAddSubDirCmd(ctx: any): void {
        this.parseTreeProperty.set(ctx, false);

        if (this.inBody) {
            return;
        }

        const dirToken: Token = ctx.argument(0).start;
        const fileUri: string = getSubCMakeListsUri(this.uri, dirToken.text);
        if (!fileUri) {
            return;
        }

        this.parseTreeProperty.set(ctx, true);

        // add subdir CMakeLists.txt to refDef
        const refPos: string = this.uri + '_' + (dirToken.line - 1) + '_' +
            dirToken.column + '_' + dirToken.text;
        refToDef.set(refPos, {
            uri: fileUri,
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

        const tree = getFileContext(fileUri);
        const subDirScope: Scope = new FileScope(this.currentScope);
        this.currentScope = subDirScope;
        const definationListener = new DefinationListener(fileUri, subDirScope);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    }

    exitAddSubDirCmd(ctx: any): void {
        if (this.inBody) {
            return;
        }

        if (this.parseTreeProperty.get(ctx)) {
            this.currentScope = this.currentScope.getEnclosingScope();
        }
    }

    enterOtherCmd(ctx: any): void {
        if (this.inBody) {
            return;
        }

        // command reference, resolve the defination
        const cmdToken: Token = ctx.ID().symbol;
        const symbol: Sym = this.currentScope.resolve(cmdToken.text, Type.Function);
        if (symbol === null) {
            return;
        }

        // token.line start from 1, so  - 1 first
        const refPos: string = this.uri + '_' + (cmdToken.line - 1) + '_' +
            cmdToken.column + '_' + cmdToken.text;
        
        // add to refToDef
        refToDef.set(refPos, symbol.getLocation());

        // parse the function body
        const tree = getFileContext(symbol.getUri());
        const functionListener = new FuncMacroListener(this.currentScope, symbol);
        antlr4.tree.ParseTreeWalker.DEFAULT.walk(functionListener, tree);
    }

    enterArgument(ctx: any): void {
        // If we are in function/macro body, just return
        // parse function/macro content just delay to reference
        if (this.inBody) {
            return;
        }

        const count: number = ctx.getChildCount();
        if (count !== 1) {
            return;
        }

        if (ctx.BracketArgument() !== null) {
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
            const refPos: string = this.uri + '_' + (argToken.line - 1) + '_' +
                (argToken.column + match.index + 2) + '_' + varRef;
            refToDef.set(refPos, symbol.getLocation());
        }

        // TODO: UnquotedArgument
    }
}
