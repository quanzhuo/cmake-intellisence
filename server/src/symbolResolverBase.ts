import * as fs from "fs";
import * as path from "path";
import { TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { CMakeInfo } from "./cmakeInfo";
import { builtinCmds } from "./completion";
import { FlatCommand } from "./flatCommands";
import { Logger } from "./logging";
import { getWordAtPosition } from "./server";
import { SymbolIndex } from "./symbolIndex";

export enum DestinationType {
    Command,
    Variable,
}

export abstract class SymbolResolverBase {
    protected baseDir: URI;
    protected entryFile: URI;

    constructor(
        protected documents: TextDocuments<TextDocument>,
        protected symbolIndex: SymbolIndex,
        protected getFlatCommands: (uri: string) => FlatCommand[],
        protected cmakeInfo: CMakeInfo,
        protected workspaceFolder: string,
        protected curFile: URI,
        protected command: FlatCommand,
        protected logger: Logger,
    ) {
        const dir = path.dirname(curFile.fsPath);
        this.baseDir = URI.file(dir);
        this.entryFile = this.curFile;
    }

    protected determineContextAndRoot() {
        const entryCMakeLists = Utils.joinPath(URI.parse(this.workspaceFolder), "CMakeLists.txt");
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            this.entryFile = entryCMakeLists;
            this.baseDir = URI.parse(this.workspaceFolder);
        }

        // Ensure the symbol index is fully populated starting from the root file
        this.populateIndexTopDown(this.entryFile.toString(), new Set());
    }

    protected getTargetWord(document: TextDocument, position: Position): string | null {
        const word = getWordAtPosition(document, position);
        if (word.text.length === 0) {
            return null;
        }
        return word.text;
    }

    protected isQueryingCommand(command: FlatCommand, word: string, pos: Position): boolean {
        // Did we click on the command name?
        const commandToken = command.ID().symbol;
        if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
            return true;
        }
        // Did we click on the first argument of a function/macro definition?
        const cmdName = commandToken.text.toLowerCase();
        if (cmdName === "function" || cmdName === "macro") {
            const args = command.argument_list();
            if (args.length > 0 && args[0].start?.text === word) {
                const token = args[0].start;
                if ((pos.line + 1 === token.line) && (pos.character >= token.column) && (pos.character <= token.column + token.text.length)) {
                    return true;
                }
            }
        }
        return false;
    }

    protected isBuiltinCommand(commandName: string): boolean {
        return commandName in builtinCmds;
    }

    private populateIndexTopDown(uri: string, visited: Set<string>) {
        if (visited.has(uri)) { return; }
        visited.add(uri);

        this.getFlatCommands(uri); // Causes symbolIndex to cache this file
        const cache = this.symbolIndex.getCache(uri);
        if (!cache) { return; }

        for (const dep of cache.dependencies) {
            this.populateIndexTopDown(dep.uri, visited);
        }
    }
}
