import { ParserRuleContext, Token } from "antlr4";
import * as fs from 'fs';
import * as path from "path";
import { DefinitionParams, Location, LocationLink, TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { CMakeInfo } from "./cmakeInfo";
import { builtinCmds } from "./completion";
import { FlatCommand } from "./flatCommands";
import { AddSubDirectoryCmdContext, ArgumentContext, FileContext, FunctionCmdContext, IncludeCmdContext, MacroCmdContext, OptionCmdContext, OtherCmdContext, SetCmdContext } from "./generated/CMakeParser";
import CMakeParserVisitor from "./generated/CMakeParserVisitor";
import { Logger } from "./logging";
import { getWordAtPosition } from "./server";
import { FileScope, Scope, Symbol, SymbolKind } from "./symbolTable";
import { getFileContent, getFileContext, getIncludeFileUri } from "./utils";

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
        private command: FlatCommand,
        private logger: Logger,
    ) {
        const dir = path.dirname(curFile.fsPath);
        this.baseDir = URI.file(dir);
    }

    private findDestinationType(command: FlatCommand, pos: Position): DestinationType {
        const commandToken: Token = command.ID().symbol;
        if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
            return DestinationType.Command;
        }
        return DestinationType.Variable;
    }

    public resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return Promise.resolve(null);
        }
        const word = getWordAtPosition(document, params.position);
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
        let visitor: BaseDefinitionVisitor;
        if (destType === DestinationType.Command) {
            const commandName = this.command.ID().getText();
            if (commandName in builtinCmds) {
                return Promise.resolve(null);
            }
            const symbolToFind = new Symbol(commandName, SymbolKind.Function, this.curFile, word.line, word.col);
            visitor = new FunctionDefinitionVisitor(symbolToFind, new FileScope(null), entryFile, this.baseDir, this.cmakeInfo, this.documents, this.fileContexts);
        } else {
            const symbolToFind = new Symbol(word.text, SymbolKind.Variable, this.curFile, word.line, word.col);
            visitor = new VariableDefinitionVisitor(symbolToFind, new FileScope(null), entryFile, this.baseDir, this.cmakeInfo, this.documents, this.fileContexts);
        }

        let tree: FileContext | undefined;
        if (!this.fileContexts.has(entryFile.toString())) {
            tree = getFileContext(getFileContent(this.documents, entryFile));
            this.fileContexts.set(entryFile.toString(), tree);
        } else {
            tree = this.fileContexts.get(entryFile.toString());
        }
        if (!tree) {
            return Promise.resolve(null);
        }

        const result = visitor.visit(tree) as Symbol[] | null;
        if (result && result.length > 0) {
            return Promise.resolve(result.map(sym => sym.getLocation()));
        }
        // If visitor completed without finding the symbol, check accumulated foundSymbols
        if (visitor.foundSymbols.length > 0) {
            return Promise.resolve(visitor.foundSymbols.map(sym => sym.getLocation()));
        }
        return Promise.resolve(null);
    }
}

/**
 * Base Visitor for go-to-definition.
 *
 * Uses Visitor instead of Listener to support natural early termination:
 * visit methods return Symbol[] when found (stop immediately) or null (continue).
 * The overridden visitChildren iterates children one by one and stops as soon as
 * a non-null result is returned, avoiding the exception-based control flow
 * that was previously used with the Listener pattern.
 */
class BaseDefinitionVisitor extends CMakeParserVisitor<Symbol[] | null> {
    protected symbolToFind: Symbol;
    protected currentScope: Scope;
    protected curFile: URI;
    protected curDir: URI;
    protected cmakeInfo: CMakeInfo;
    protected documents: TextDocuments<TextDocument>;
    protected fileContexts: Map<string, FileContext>;
    foundSymbols: Symbol[] = [];

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

    /**
     * Override visitChildren for early termination.
     * Iterates children one by one; returns immediately when a child returns non-null.
     */
    override visitChildren(ctx: ParserRuleContext): Symbol[] | null {
        if (!ctx.children) { return null; }
        for (const child of ctx.children) {
            const result = this.visit(child);
            if (result !== null) { return result; }
        }
        return null;
    }

    protected registerFunction(ctx: FunctionCmdContext): void {
        const funcNameToken: Token = ctx.argument(0)?.start;
        if (funcNameToken !== undefined) {
            const funcSymbol: Symbol = new Symbol(funcNameToken.text, SymbolKind.Function, this.curFile, funcNameToken.line - 1, funcNameToken.column);
            this.currentScope.define(funcSymbol);
        }
    }

    protected registerMacro(ctx: MacroCmdContext): void {
        const macroNameToken: Token = ctx.argument(0)?.start;
        if (macroNameToken !== undefined) {
            const macroSymbol: Symbol = new Symbol(macroNameToken.text, SymbolKind.Macro, this.curFile, macroNameToken.line - 1, macroNameToken.column);
            this.currentScope.define(macroSymbol);
        }
    }

    visitFunctionCmd = (ctx: FunctionCmdContext): Symbol[] | null => {
        this.registerFunction(ctx);
        return null;
    };

    visitMacroCmd = (ctx: MacroCmdContext): Symbol[] | null => {
        this.registerMacro(ctx);
        return null;
    };

    visitIncludeCmd = (ctx: IncludeCmdContext): Symbol[] | null => {
        const nameToken = ctx.argument(0)?.start;
        if (nameToken === undefined) {
            return null;
        }

        const incUri: URI | null = getIncludeFileUri(this.cmakeInfo, this.curDir, nameToken.text);
        if (!incUri) {
            return null;
        }

        let tree: FileContext;
        if (!this.fileContexts.has(incUri.toString())) {
            tree = getFileContext(getFileContent(this.documents, incUri));
            this.fileContexts.set(incUri.toString(), tree);
        } else {
            tree = this.fileContexts.get(incUri.toString())!;
        }

        const definitionVisitor = new FunctionDefinitionVisitor(this.symbolToFind, this.currentScope, incUri, this.curDir, this.cmakeInfo, this.documents, this.fileContexts);
        return definitionVisitor.visit(tree) as Symbol[] | null;
    };

    visitAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): Symbol[] | null => {
        const dirToken = ctx.argument(0)?.start;
        if (dirToken === undefined) {
            return null;
        }

        const subDir = dirToken.text;
        const subCMakeListsUri: URI = Utils.joinPath(this.curDir, subDir, 'CMakeLists.txt');
        if (!fs.existsSync(subCMakeListsUri.fsPath)) {
            return null;
        }

        let tree: FileContext;
        if (!this.fileContexts.has(subCMakeListsUri.toString())) {
            tree = getFileContext(getFileContent(this.documents, subCMakeListsUri));
            this.fileContexts.set(subCMakeListsUri.toString(), tree);
        } else {
            tree = this.fileContexts.get(subCMakeListsUri.toString())!;
        }

        const subDirScope: Scope = new FileScope(this.currentScope);
        const subBaseDir = Utils.joinPath(this.curDir, subDir);
        const definitionVisitor = new FunctionDefinitionVisitor(this.symbolToFind, subDirScope, subCMakeListsUri, subBaseDir, this.cmakeInfo, this.documents, this.fileContexts);
        return definitionVisitor.visit(tree) as Symbol[] | null;
    };
}

class FunctionDefinitionVisitor extends BaseDefinitionVisitor {
    visitOtherCmd = (ctx: OtherCmdContext): Symbol[] | null => {
        const commandToken = ctx.ID().symbol;
        if (commandToken.line === this.symbolToFind.getLine() + 1 &&
            commandToken.column === this.symbolToFind.getColumn() &&
            commandToken.text === this.symbolToFind.getName()) {
            const sym = this.currentScope.resolve(this.symbolToFind.getName(), SymbolKind.Function);
            if (sym !== null) {
                this.foundSymbols.push(sym);
            }
            return this.foundSymbols; // early exit: found usage site
        }
        return null;
    };
}

class VariableDefinitionVisitor extends BaseDefinitionVisitor {
    // Override: need to visit children of functionCmd to reach argument nodes
    visitFunctionCmd = (ctx: FunctionCmdContext): Symbol[] | null => {
        this.registerFunction(ctx);
        return this.visitChildren(ctx);
    };

    visitSetCmd = (ctx: SetCmdContext): Symbol[] | null => {
        const varToken: Token = ctx.argument(0)?.start;
        if (varToken !== undefined) {
            const varSymbol: Symbol = new Symbol(varToken.text, SymbolKind.Variable, this.curFile, varToken.line - 1, varToken.column);
            this.currentScope.define(varSymbol);
        }
        return this.visitChildren(ctx);
    };

    visitOptionCmd = (ctx: OptionCmdContext): Symbol[] | null => {
        return this.visitSetCmd(ctx as unknown as SetCmdContext);
    };

    visitArgument = (ctx: ArgumentContext): Symbol[] | null => {
        if (ctx.getChildCount() !== 1) {
            return null;
        }

        // skip the arguments in include() and add_subdirectory()
        if (ctx.parentCtx instanceof IncludeCmdContext || ctx.parentCtx instanceof AddSubDirectoryCmdContext) {
            return null;
        }

        const argToken: Token = ctx.start;
        if (argToken.line === this.symbolToFind.getLine() + 1 &&
            argToken.column === this.symbolToFind.getColumn() &&
            argToken.text === this.symbolToFind.getName()) {
            const sym = this.currentScope.resolve(this.symbolToFind.getName(), SymbolKind.Variable);
            if (sym !== null) {
                this.foundSymbols.push(sym);
            }
            return this.foundSymbols; // early exit: found usage site
        }
        return null;
    };
}