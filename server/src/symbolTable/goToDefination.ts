import { ParseTree, ParseTreeWalker, Token } from 'antlr4';
import { Location } from "vscode-languageserver-types";
import { URI, Utils } from "vscode-uri";
import { AddSubDirectoryCmdContext, ArgumentContext, EndFunctionCmdContext, EndMacroCmdContext, FileContext, FunctionCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext } from '../generated/CMakeParser';
import CMakeListener from "../generated/CMakeParserListener";
import { getFileContext, getIncludeFileUri, getSubCMakeListsUri } from "../utils";
import { FuncMacroListener } from "./function";
import { FileScope, Scope } from "./scope";
import { Sym, Type } from "./symbol";
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import ExtensionSettings from '../settings';
import { CMakeInfo } from '../cmakeInfo';

export const topScope: FileScope = new FileScope(null);
export const incToBaseDir: Map<string, URI> = new Map<string, URI>();

/**
 * key: <uri>_<line>_<column>_<word>
 * value: Location
 *
 * NOTE: line and column are numbers start from zero
 */
export const refToDef: Map<string, Location> = new Map();

export const parsedFiles: Set<string> = new Set; // record all the parsed files

export class DefinationListener extends CMakeListener {
    private documents: TextDocuments<TextDocument>;
    private cmakeInfo: CMakeInfo;
    private currentScope: Scope;
    private inBody = false;
    private curFile: URI;     // current file uri
    private baseDir: URI;     // directory used by include/add_subdirectory commands

    private parseTreeProperty = new Map<ParseTree, boolean>();

    constructor(documents: TextDocuments<TextDocument>, cmakeInfo: CMakeInfo, baseDir: URI, curFile: URI, scope: Scope) {
        super();
        this.documents = documents;
        this.cmakeInfo = cmakeInfo;
        this.curFile = curFile;
        this.currentScope = scope;
        this.baseDir = baseDir;
        // Utils.dirname(URI.parse(uri)).fsPath
    }

    enterFile = (ctx: FileContext): void => {
        parsedFiles.add(this.curFile.toString());
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.inBody = true;

        // create a function symbol
        const funcToken: Token = ctx.argument(0)?.start;
        if (funcToken !== undefined) {
            const funcSymbol: Sym = new Sym(funcToken.text, Type.Function,
                this.curFile, funcToken.line - 1, funcToken.column);

            // add to current scope
            this.currentScope.define(funcSymbol);
        }
    };

    exitEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.inBody = false;
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.inBody = true;

        // create a macro symbol
        const macroToken: Token = ctx.argument(0)?.start;
        if (macroToken !== undefined) {
            const macroSymbol: Sym = new Sym(macroToken.text, Type.Macro,
                this.curFile, macroToken.line - 1, macroToken.column);

            // add macro to this scope
            this.currentScope.define(macroSymbol);
        }
    };

    exitEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        this.inBody = false;
    };

    enterSetCmd = (ctx: SetCmdContext): void => {
        if (this.inBody) {
            return;
        }

        // create a variable symbol
        const varToken: Token = ctx.argument(0)?.start;
        if (varToken !== undefined) {
            const varSymbol: Sym = new Sym(varToken.text, Type.Variable,
                this.curFile, varToken.line - 1, varToken.column);

            // add variable to current scope
            this.currentScope.define(varSymbol);
        }
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.enterSetCmd(ctx as unknown as SetCmdContext);
    };

    enterIncludeCmd = (ctx: IncludeCmdContext): void => {
        if (this.inBody) {
            return;
        }

        const nameToken = ctx.argument(0)?.start;
        if (nameToken === undefined) {
            return;
        }

        const incUri: URI = getIncludeFileUri(this.cmakeInfo, this.baseDir, nameToken.text);
        if (!incUri) {
            return;
        }

        incToBaseDir.set(incUri.toString(), this.baseDir);

        // add included module to refDef
        const refPos: string = this.curFile + '_' + (nameToken.line - 1) + '_' +
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

        const tree = getFileContext(this.documents, incUri);
        const definationListener = new DefinationListener(this.documents, this.cmakeInfo, this.baseDir, incUri, this.currentScope);
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        this.parseTreeProperty.set(ctx, false);

        if (this.inBody) {
            return;
        }

        const dirToken: Token = ctx.argument(0)?.start;
        if (dirToken === undefined) {
            return;
        }
        const subCMakeListsUri: URI = getSubCMakeListsUri(this.baseDir, dirToken.text);
        if (!subCMakeListsUri) {
            return;
        }

        incToBaseDir.set(subCMakeListsUri.toString(), this.baseDir);

        this.parseTreeProperty.set(ctx, true);

        // add subdir CMakeLists.txt to refDef
        const refPos: string = this.curFile + '_' + (dirToken.line - 1) + '_' +
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

        const tree = getFileContext(this.documents, subCMakeListsUri);
        const subDirScope: Scope = new FileScope(this.currentScope);
        // FIXME: 此处是否应该切换作用域?
        this.currentScope = subDirScope;
        const subBaseDir: URI = Utils.joinPath(this.baseDir, dirToken.text);
        const definationListener = new DefinationListener(this.documents, this.cmakeInfo, subBaseDir, subCMakeListsUri, subDirScope);
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };

    exitAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        if (this.inBody) {
            return;
        }

        if (this.parseTreeProperty.get(ctx)) {
            this.currentScope = this.currentScope.getEnclosingScope();
        }
    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
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
        const refPos: string = this.curFile + '_' + (cmdToken.line - 1) + '_' +
            cmdToken.column + '_' + cmdToken.text;

        // add to refToDef
        refToDef.set(refPos, symbol.getLocation());

        // parse the function body, only parse the function once
        if (!symbol.funcMacroParsed) {
            const tree = getFileContext(this.documents, symbol.getUri());
            const functionListener = new FuncMacroListener(this.documents, this.cmakeInfo, this.currentScope, symbol);
            ParseTreeWalker.DEFAULT.walk(functionListener, tree);
            symbol.funcMacroParsed = true;
        }
    };

    enterArgument = (ctx: ArgumentContext): void => {
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
            const refPos: string = this.curFile + '_' + (argToken.line - 1) + '_' +
                (argToken.column + match.index + 2) + '_' + varRef;
            refToDef.set(refPos, symbol.getLocation());
        }

        // TODO: UnquotedArgument
    };
}
