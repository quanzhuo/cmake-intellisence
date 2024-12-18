import { ParseTreeWalker, Token } from "antlr4";
import * as fs from 'fs';
import * as path from "path";
import { DefinitionParams, Location, LocationLink, TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { CMakeInfo } from "./cmakeInfo";
import { AddSubDirectoryCmdContext, ArgumentContext, FileContext, FunctionCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";
import * as cmsp from "./generated/CMakeSimpleParser";
import { getWordAtPosition, logger } from "./server";
import { FileScope, Scope, Symbol, SymbolKind } from "./symbolTable";
import { getFileContent, getFileContext, getIncludeFileUri } from "./utils";
import { builtinCmds } from "./completion";

export enum DestinationType {
    Command,
    Variable,
}

export class DefinitionResolver {
    // the directory which current cmake file is in
    private baseDir: URI;

    constructor(
        private fileContexts: Map<string, FileContext>,
        private documents: TextDocuments<TextDocument>,
        private cmakeInfo: CMakeInfo,
        private workspaceFolder: string,
        private curFile: URI,
        private command: cmsp.CommandContext,
    ) {
        const dir = path.dirname(curFile.fsPath);
        this.baseDir = URI.file(dir);
    }

    private findDestinationType(command: cmsp.CommandContext, pos: Position): DestinationType {
        const commandToken: Token = command.ID().symbol;
        if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
            return DestinationType.Command;
        }
        return DestinationType.Variable;
    }

    public resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const word = getWordAtPosition(this.documents.get(params.textDocument.uri), params.position);
        if (word.text.length === 0) {
            return Promise.resolve(null);
        }

        let entryFile = this.curFile;
        const entryCMakeLists = Utils.joinPath(URI.parse(this.workspaceFolder), 'CMakeLists.txt');
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            entryFile = entryCMakeLists;
            this.baseDir = URI.parse(this.workspaceFolder);
        }

        const destType = this.findDestinationType(this.command, params.position);
        let listener: CMakeParserListener;
        if (destType === DestinationType.Command) {
            const commandName = this.command.ID().getText();
            if (commandName in builtinCmds) {
                return Promise.resolve(null);
            }
            const symbolToFind = new Symbol(commandName, SymbolKind.Function, this.curFile, word.line, word.col);
            listener = new FunctionDefinationListener(symbolToFind, new FileScope(null), entryFile, this.baseDir, this.cmakeInfo, this.documents, this.fileContexts);
        } else {
            const symbolToFind = new Symbol(word.text, SymbolKind.Variable, this.curFile, word.line, word.col);
            listener = new VariableDefinationListener(symbolToFind, new FileScope(null), entryFile, this.baseDir, this.cmakeInfo, this.documents, this.fileContexts);
        }

        try {
            let tree: FileContext;
            if (!this.fileContexts.has(entryFile.toString())) {
                tree = getFileContext(getFileContent(this.documents, entryFile));
                this.fileContexts.set(entryFile.toString(), tree);
            } else {
                tree = this.fileContexts.get(entryFile.toString());
            }
            ParseTreeWalker.DEFAULT.walk(listener, tree);
        } catch (e) {
            if (e instanceof EarlyExitException) {
                return e.symbols;
                // } else if (e instanceof TypeError) {
                //     logger.error('TypeError', e.message);
            } else {
                throw e;
            }
        }
        return (listener as FunctionDefinationListener | VariableDefinationListener).symbols;
    }
}

class EarlyExitException extends Error {
    private _foundSymbols: Symbol[];
    constructor(message: string, foundSymbols: Symbol[] = []) {
        super(message);
        this.name = 'EarlyExitException';
        this._foundSymbols = foundSymbols;
    }

    get symbols(): Promise<Location | Location[] | LocationLink[] | null> {
        return new Promise((resolve, reject) => {
            if (this._foundSymbols.length === 0) {
                resolve(null);
            } else {
                resolve(this._foundSymbols.map(sym => sym.getLocation()));
            }
        });
    }
}

class BaseDefinationListener extends CMakeParserListener {
    protected symbolToFind: Symbol;
    protected currentScope: Scope;
    protected curFile: URI;
    protected curDir: URI;
    protected cmakeInfo: CMakeInfo;
    protected documents: TextDocuments<TextDocument>;
    protected fileContexts: Map<string, FileContext>;
    protected foundSymbols: Symbol[] = [];

    constructor(symbol: Symbol, scope: Scope, file: URI, curDir: URI, cmakeInfo: CMakeInfo, documents: TextDocuments<TextDocument>, fileContexts: Map<string, FileContext>) {
        super();
        this.symbolToFind = symbol;
        this.currentScope = scope;
        this.curFile = file;
        this.curDir = curDir;
        this.cmakeInfo = cmakeInfo;
        this.documents = documents;
        this.fileContexts = fileContexts;
    }

    get symbols(): Promise<Location | Location[] | LocationLink[] | null> {
        return new Promise((resolve, reject) => {
            if (this.foundSymbols.length === 0) {
                resolve(null);
            } else {
                resolve(this.foundSymbols.map(sym => sym.getLocation()));
            }
        });
    }

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        const funcNameToken: Token = ctx.argument(0)?.start;
        if (funcNameToken !== undefined) {
            const funcSymbol: Symbol = new Symbol(funcNameToken.text, SymbolKind.Function, this.curFile, funcNameToken.line - 1, funcNameToken.column);
            this.currentScope.define(funcSymbol);
        }
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        const macroNameToken: Token = ctx.argument(0)?.start;
        if (macroNameToken !== undefined) {
            const macroSymbol: Symbol = new Symbol(macroNameToken.text, SymbolKind.Macro, this.curFile, macroNameToken.line - 1, macroNameToken.column);
            this.currentScope.define(macroSymbol);
        }
    };

    enterIncludeCmd = (ctx: IncludeCmdContext): void => {
        const nameToken = ctx.argument(0)?.start;
        if (nameToken === undefined) {
            return;
        }

        const incUri: URI = getIncludeFileUri(this.cmakeInfo, this.curDir, nameToken.text);
        if (!incUri) {
            return;
        }

        let tree: FileContext;
        if (!this.fileContexts.has(incUri.toString())) {
            tree = getFileContext(getFileContent(this.documents, incUri));
            this.fileContexts.set(incUri.toString(), tree);
        } else {
            tree = this.fileContexts.get(incUri.toString());
        }

        const definationListener = new FunctionDefinationListener(this.symbolToFind, this.currentScope, incUri, this.curDir, this.cmakeInfo, this.documents, this.fileContexts);
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        const dirToken = ctx.argument(0)?.start;
        if (dirToken === undefined) {
            return;
        }

        const subDir = dirToken.text;
        const subCMakeListsUri: URI = Utils.joinPath(this.curDir, subDir, 'CMakeLists.txt');
        if (!fs.existsSync(subCMakeListsUri.fsPath)) {
            logger.error('enterAddSubdirectoryCmd:', subCMakeListsUri.fsPath, 'not exist');
            return;
        }

        let tree: FileContext;
        if (!this.fileContexts.has(subCMakeListsUri.toString())) {
            tree = getFileContext(getFileContent(this.documents, subCMakeListsUri));
            this.fileContexts.set(subCMakeListsUri.toString(), tree);
        } else {
            tree = this.fileContexts.get(subCMakeListsUri.toString());
        }

        const subDirScope: Scope = new FileScope(this.currentScope);
        const subBaseDir = Utils.joinPath(this.curDir, subDir);
        const definationListener = new FunctionDefinationListener(this.symbolToFind, subDirScope, subCMakeListsUri, subBaseDir, this.cmakeInfo, this.documents, this.fileContexts);
        ParseTreeWalker.DEFAULT.walk(definationListener, tree);
    };
}

class FunctionDefinationListener extends BaseDefinationListener {
    enterOtherCmd = (ctx: OtherCmdContext): void => {
        const commandToken = ctx.ID().symbol;
        if (commandToken.line === this.symbolToFind.getLine() + 1 &&
            commandToken.column === this.symbolToFind.getColumn() &&
            commandToken.text === this.symbolToFind.getName()) {
            const sym = this.currentScope.resolve(this.symbolToFind.getName(), SymbolKind.Function);
            if (sym !== null) {
                this.foundSymbols.push(sym);
            }
            throw new EarlyExitException('found', this.foundSymbols);
        }
    };
}

class VariableDefinationListener extends BaseDefinationListener {
    enterSetCmd = (ctx: SetCmdContext): void => {
        const varToken: Token = ctx.argument(0)?.start;
        if (varToken !== undefined) {
            const varSymbol: Symbol = new Symbol(varToken.text, SymbolKind.Variable, this.curFile, varToken.line - 1, varToken.column);
            this.currentScope.define(varSymbol);
        }
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.enterSetCmd(ctx as unknown as SetCmdContext);
    };

    enterArgument = (ctx: ArgumentContext): void => {
        if (ctx.getChildCount() !== 1) {
            return;
        }

        // skip the arguments in include() and add_subdirectory()
        if (ctx.parentCtx instanceof IncludeCmdContext || ctx.parentCtx instanceof AddSubDirectoryCmdContext) {
            return;
        }

        const argToken: Token = ctx.start;
        if (argToken.line === this.symbolToFind.getLine() + 1 &&
            argToken.column === this.symbolToFind.getColumn() &&
            argToken.text === this.symbolToFind.getName()) {
            const sym = this.currentScope.resolve(this.symbolToFind.getName(), SymbolKind.Variable);
            if (sym !== null) {
                this.foundSymbols.push(sym);
            }
            throw new EarlyExitException('found', this.foundSymbols);
        }
    };
}