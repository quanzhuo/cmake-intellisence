import * as fs from 'fs';
import * as path from "path";
import { Location, ReferenceParams, TextDocuments } from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { URI, Utils } from "vscode-uri";
import { CMakeInfo } from "./cmakeInfo";
import { builtinCmds } from "./completion";
import { FlatCommand } from "./flatCommands";
import { Logger } from "./logging";
import { getWordAtPosition } from "./server";
import { SymbolIndex } from "./symbolIndex";
import { getFileContent } from "./utils";

export enum DestinationType {
    Command,
    Variable,
}

export class ReferenceResolver {
    private baseDir: URI;

    constructor(
        private documents: TextDocuments<TextDocument>,
        private symbolIndex: SymbolIndex,
        private getFlatCommands: (uri: string) => FlatCommand[],
        private cmakeInfo: CMakeInfo,
        private workspaceFolder: string,
        private curFile: URI,
        private command: FlatCommand,
        private logger: Logger,
    ) {
        const dir = path.dirname(curFile.fsPath);
        this.baseDir = URI.file(dir);
    }

    private isQueryingCommand(command: FlatCommand, word: string, pos: Position): boolean {
        // Did we click on the command name?
        const commandToken = command.ID().symbol;
        if ((pos.line + 1 === commandToken.line) && (pos.character <= commandToken.column + commandToken.text.length)) {
            return true;
        }
        // Did we click on the first argument of a function/macro definition?
        const cmdName = commandToken.text.toLowerCase();
        if (cmdName === 'function' || cmdName === 'macro') {
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

    public async resolve(params: ReferenceParams): Promise<Location[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) { return null; }
        const word = getWordAtPosition(document, params.position);
        if (word.text.length === 0) { return null; }

        let entryFile = this.curFile;
        const entryCMakeLists = Utils.joinPath(URI.parse(this.workspaceFolder), 'CMakeLists.txt');
        if (fs.existsSync(entryCMakeLists.fsPath)) {
            entryFile = entryCMakeLists;
            this.baseDir = URI.parse(this.workspaceFolder);
        }

        const isCommand = this.isQueryingCommand(this.command, word.text, params.position);
        const searchName = isCommand ? word.text.toLowerCase() : word.text;

        if (isCommand) {
            if (searchName in builtinCmds) { return null; }
        }

        // Ensure the symbol index is fully populated starting from the root file
        this.populateIndexTopDown(entryFile.toString(), new Set());

        const results: Location[] = [];

        // Find all parsed files
        const allFiles = this.symbolIndex.getAllCaches().map(c => c.uri);

        for (const uri of allFiles) {
            const commands = this.getFlatCommands(uri);
            
            for (const cmd of commands) {
                if (isCommand) {
                    const token = cmd.ID().symbol;
                    if (token.text.toLowerCase() === searchName) {
                        results.push({
                            uri,
                            range: {
                                start: { line: token.line - 1, character: token.column },
                                end: { line: token.line - 1, character: token.column + token.text.length }
                            }
                        });
                    }
                    const cmdName = token.text.toLowerCase();
                    if (cmdName === 'function' || cmdName === 'macro') {
                        const args = cmd.argument_list();
                        if (args.length > 0) {
                            const argToken = args[0].start;
                            if (argToken && argToken.text.toLowerCase() === searchName) {
                                results.push({
                                    uri,
                                    range: {
                                        start: { line: argToken.line - 1, character: argToken.column },
                                        end: { line: argToken.line - 1, character: argToken.column + argToken.text.length }
                                    }
                                });
                            }
                        }
                    }
                } else {
                    const args = cmd.argument_list();
                    for (const arg of args) {
                        const token = arg.start;
                        if (!token) {continue;}
                        
                        // Naivel variable matching in arguments
                        const text = token.text;
                        let offset = 0;
                        while(true) {
                            const idx = text.indexOf(searchName, offset);
                            if (idx === -1) {break;}
                            
                            // To be accurate, we only consider it a match if it's enclosed like ${VAR}, $ENV{VAR}, or if it's an exact match in unquoted
                            // For simplicity, we match the exact string, and avoid matching substrings of larger words.
                            const precedingChar = idx > 0 ? text[idx-1] : "";
                            const succeedingChar = idx + searchName.length < text.length ? text[idx + searchName.length] : "";
                            const isStandalone = !/[a-zA-Z0-9_]/.test(precedingChar) && !/[a-zA-Z0-9_]/.test(succeedingChar);
                            
                            if (isStandalone) {
                                results.push({
                                    uri,
                                    range: {
                                        start: { line: token.line - 1, character: token.column + idx },
                                        end: { line: token.line - 1, character: token.column + idx + searchName.length }
                                    }
                                });
                            }
                            offset = idx + searchName.length;
                        }
                    }
                }
            }
        }

        return results.length > 0 ? results : null;
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
