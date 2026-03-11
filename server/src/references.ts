import { Location, ReferenceParams } from "vscode-languageserver";
import { DestinationType, SymbolResolverBase } from "./symbolResolverBase";

export { DestinationType };

export class ReferenceResolver extends SymbolResolverBase {
    private isVariableDeclaration(cmd: import("./flatCommands").FlatCommand, argIndex: number): boolean {
        const commandName = cmd.ID().symbol.text.toLowerCase();
        switch (commandName) {
            case 'set':
            case 'unset':
            case 'option':
            case 'foreach':
                return argIndex === 0;
            case 'function':
            case 'macro':
                return argIndex > 0;
            case 'math':
                return argIndex === 0;
            default:
                return false;
        }
    }

    public async resolve(params: ReferenceParams): Promise<Location[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) { return null; }

        const targetWord = this.getTargetWord(document, params.position);
        if (!targetWord) { return null; }

        this.determineContextAndRoot();

        const isCommand = this.isQueryingCommand(this.command, targetWord, params.position);
        const searchName = isCommand ? targetWord.toLowerCase() : targetWord;
        const includeDeclaration = params.context.includeDeclaration;

        if (isCommand) {
            if (this.isBuiltinCommand(searchName)) { return null; }
        }

        const results: Location[] = [];

        const candidateFiles = this.symbolIndex.getReachableFiles(this.entryFile.toString());
        if (!candidateFiles.includes(this.curFile.toString())) {
            candidateFiles.push(this.curFile.toString());
        }

        for (const uri of candidateFiles) {
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
                    if (cmdName === "function" || cmdName === "macro") {
                        const args = cmd.argument_list();
                        if (args.length > 0) {
                            const argToken = args[0].start;
                            if (includeDeclaration && argToken && argToken.text.toLowerCase() === searchName) {
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
                    for (const [argIndex, arg] of args.entries()) {
                        const token = arg.start;
                        if (!token) { continue; }

                        if (!includeDeclaration && this.isVariableDeclaration(cmd, argIndex)) {
                            continue;
                        }

                        // Naively match variable in arguments
                        const text = token.text;
                        let offset = 0;
                        while (true) {
                            const idx = text.indexOf(searchName, offset);
                            if (idx === -1) { break; }

                            // Check surroundings to ensure standalone matching
                            const precedingChar = idx > 0 ? text[idx - 1] : "";
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
}

