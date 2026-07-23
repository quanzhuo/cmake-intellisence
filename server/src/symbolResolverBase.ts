import * as fs from "fs";
import { TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { throwIfCancelled } from "./cancellation";
import { getArgumentSpanAtPosition, ResolvedCursorTarget, resolveCursorTarget } from "./argumentSemantics";
import { FlatCommand } from "./flatCommands";
import { Logger } from "./logging";
import { SymbolIndex } from "./symbolIndex";
import { populateIndexTopDown } from "./symbolIndexManager";

export abstract class SymbolResolverBase {
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
        protected ensureFileIndexed?: (uri: string, entryFile: string) => Promise<boolean>,
    ) {
        this.entryFile = this.curFile;
    }

    protected async determineContextAndRoot() {
        throwIfCancelled(this.shouldCancel);
        const entryCMakeLists = Utils.joinPath(URI.parse(this.workspaceFolder), "CMakeLists.txt");
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            await this.populateFromEntry(entryCMakeLists);
            if (this.symbolIndex.getReachableFiles(entryCMakeLists.toString()).includes(this.curFile.toString())) {
                this.entryFile = entryCMakeLists;
                return;
            }
        }

        const indexedEntry = this.symbolIndex.findEntryFile(this.curFile.toString());
        this.entryFile = indexedEntry ? URI.parse(indexedEntry) : this.curFile;
        await this.populateFromEntry(this.entryFile);
    }

    private async populateFromEntry(entryFile: URI): Promise<void> {
        await populateIndexTopDown({
            rootUri: entryFile.toString(),
            visited: new Set(),
            symbolIndex: this.symbolIndex,
            loadFlatCommands: this.getFlatCommands,
            ensureFileIndexed: this.ensureFileIndexed,
            shouldCancel: this.shouldCancel,
            onDependencyError: async (uri, error): Promise<'continue'> => {
                this.logger.error(`Failed to index dependency ${uri}`, error as Error);
                return 'continue';
            },
        });
    }

    protected getResolvedCursorTarget(_document: TextDocument, position: Position): ResolvedCursorTarget | null {
        const resolved = resolveCursorTarget(this.command, '', position);
        if (resolved.text.length === 0) {
            return null;
        }
        return resolved;
    }

    protected getArgumentIndexAtPosition(command: FlatCommand, pos: Position): number | null {
        return getArgumentSpanAtPosition(command, pos)?.argumentIndex ?? null;
    }

}
