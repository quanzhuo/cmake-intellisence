import * as fs from "fs";
import * as path from "path";
import { TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { throwIfCancelled } from "./cancellation";
import { getArgumentSpanAtPosition, getDefinitionSubject, isCommandPosition, isTargetArgumentIndex as isTargetArgumentIndexFromSemantics, ResolvedCursorTarget, resolveCursorTarget } from "./argumentSemantics";
import { FlatCommand } from "./flatCommands";
import { Logger } from "./logging";
import { getWordAtPosition } from "./server";
import { SymbolIndex } from "./symbolIndex";
import { populateIndexTopDown } from "./symbolIndexManager";

export enum DestinationType {
    Command,
    Variable,
    Target,
}

export abstract class SymbolResolverBase {
    protected baseDir: URI;
    protected entryFile: URI;

    constructor(
        protected documents: TextDocuments<TextDocument>,
        protected symbolIndex: SymbolIndex,
        protected getFlatCommands: (uri: string) => Promise<FlatCommand[]>,
        protected workspaceFolder: string,
        protected curFile: URI,
        protected command: FlatCommand,
        protected logger: Logger,
        protected shouldCancel?: () => boolean,
    ) {
        const dir = path.dirname(curFile.fsPath);
        this.baseDir = URI.file(dir);
        this.entryFile = this.curFile;
    }

    protected async determineContextAndRoot() {
        throwIfCancelled(this.shouldCancel);
        const entryCMakeLists = Utils.joinPath(URI.parse(this.workspaceFolder), "CMakeLists.txt");
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            this.entryFile = entryCMakeLists;
            this.baseDir = URI.parse(this.workspaceFolder);
        }

        // Ensure the symbol index is fully populated starting from the root file
        await populateIndexTopDown({
            rootUri: this.entryFile.toString(),
            visited: new Set(),
            symbolIndex: this.symbolIndex,
            loadFlatCommands: this.getFlatCommands,
            shouldCancel: this.shouldCancel,
            onDependencyError: async (uri, error): Promise<'continue'> => {
                this.logger.error(`Failed to index dependency ${uri}`, error as Error);
                return 'continue';
            },
        });
    }

    protected getTargetWord(document: TextDocument, position: Position): string | null {
        const resolved = this.getResolvedCursorTarget(document, position);
        return resolved?.text ?? null;
    }

    protected getResolvedCursorTarget(document: TextDocument, position: Position): ResolvedCursorTarget | null {
        const word = getWordAtPosition(document, position);
        if (word.text.length === 0) {
            return null;
        }
        return resolveCursorTarget(this.command, word.text, position);
    }

    protected isQueryingCommand(command: FlatCommand, word: string, pos: Position): boolean {
        return isCommandPosition(command, word, pos);
    }

    protected getDestinationType(command: FlatCommand, word: string, pos: Position): DestinationType {
        switch (getDefinitionSubject(command, word, pos)) {
            case 'command':
                return DestinationType.Command;
            case 'target':
                return DestinationType.Target;
            default:
                return DestinationType.Variable;
        }
    }

    protected getArgumentIndexAtPosition(command: FlatCommand, pos: Position): number | null {
        return getArgumentSpanAtPosition(command, pos)?.argumentIndex ?? null;
    }

    protected isQueryingTarget(command: FlatCommand, pos: Position): boolean {
        const argIndex = this.getArgumentIndexAtPosition(command, pos);
        if (argIndex === null) {
            return false;
        }

        return this.isTargetArgumentIndex(command, argIndex);
    }

    protected isTargetArgumentIndex(command: FlatCommand, argIndex: number): boolean {
        return isTargetArgumentIndexFromSemantics(command, argIndex);
    }

    protected isBuiltinCommand(commandName: string): boolean {
        return this.symbolIndex.hasBuiltinCommand(commandName);
    }
}
