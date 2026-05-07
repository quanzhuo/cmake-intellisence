import * as fs from "fs";
import * as path from "path";
import { TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { throwIfCancelled } from "./cancellation";
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

    protected getDestinationType(command: FlatCommand, word: string, pos: Position): DestinationType {
        if (this.isQueryingCommand(command, word, pos)) {
            return DestinationType.Command;
        }

        if (this.isQueryingTarget(command, pos)) {
            return DestinationType.Target;
        }

        return DestinationType.Variable;
    }

    protected getArgumentIndexAtPosition(command: FlatCommand, pos: Position): number | null {
        const args = command.argument_list();
        const targetLine = pos.line + 1;

        for (const [index, arg] of args.entries()) {
            const token = arg.start;
            if (!token || token.line !== targetLine) {
                continue;
            }

            const startColumn = token.column;
            const endColumn = startColumn + arg.getText().length;
            if (pos.character >= startColumn && pos.character <= endColumn) {
                return index;
            }
        }

        return null;
    }

    protected isQueryingTarget(command: FlatCommand, pos: Position): boolean {
        const argIndex = this.getArgumentIndexAtPosition(command, pos);
        if (argIndex === null) {
            return false;
        }

        return this.isTargetArgumentIndex(command, argIndex);
    }

    protected isTargetArgumentIndex(command: FlatCommand, argIndex: number): boolean {
        const args = command.argument_list();
        const argText = args[argIndex]?.getText();
        const commandName = command.ID().symbol.text.toLowerCase();

        switch (commandName) {
            case 'add_executable':
            case 'add_library':
                return argIndex === 0;
            case 'target_compile_definitions':
            case 'target_compile_features':
            case 'target_compile_options':
            case 'target_include_directories':
            case 'target_link_directories':
            case 'target_link_options':
            case 'target_precompile_headers':
            case 'target_sources':
                return argIndex === 0;
            case 'target_link_libraries': {
                if (argIndex === 0) {
                    return true;
                }

                const keywords = new Set([
                    'PRIVATE',
                    'PUBLIC',
                    'INTERFACE',
                    'LINK_INTERFACE_LIBRARIES',
                    'LINK_PRIVATE',
                    'LINK_PUBLIC',
                ]);
                return !!argText && !keywords.has(argText);
            }
            case 'get_target_property':
                return argIndex === 1;
            case 'if':
            case 'elseif':
            case 'while':
                return argIndex > 0 && args[argIndex - 1]?.getText().toUpperCase() === 'TARGET';
            default:
                return false;
        }
    }

    protected isBuiltinCommand(commandName: string): boolean {
        return this.symbolIndex.hasBuiltinCommand(commandName);
    }
}
