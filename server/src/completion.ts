import { CharStreams, CommonTokenStream, Token } from "antlr4";
import { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionParams, Connection, InitializeParams, InsertTextFormat, Position, TextDocuments } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CMakeInfo } from "./cmakeInfo";
import CMakeSimpleLexer from "./generated/CMakeSimpleLexer";
import CMakeSimpleParser, * as cmsp from "./generated/CMakeSimpleParser";
import { builtinCmds, getWordAtPosition } from "./server";
import ExtensionSettings from "./settings";

enum CMakeCompletionType {
    Command,
    Module,
    Policy,
    Variable,
    Property,
    Argument,
}

interface CMakeCompletionInfo {
    type: CMakeCompletionType,

    // if type is CMakeCompletionType.Argument, this field is the active command name
    command?: string,
}

/**
 * Determines if a given position is within a list of comments.
 *
 * This function performs a binary search on the sorted list of comments to check if the specified position
 * falls within any of the comment ranges.
 *
 * @param pos - The position to check, represented by a `Position` object with `line` and `character` properties.
 * @param comments - An array of `Token` objects representing the comments, each with `line` and `column` properties.
 * @returns `true` if the position is within a comment, `false` otherwise.
 */
export function inComments(pos: Position, comments: Token[]): boolean {
    let left = 0;
    let right = comments.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const comment = comments[mid];

        if (comment.line === pos.line + 1) {
            if (comment.column <= pos.character) {
                return true;
            } else {
                right = mid - 1;
            }
        } else if (comment.line < pos.line + 1) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return false;
}

export default class Completion {
    constructor(
        private initParams: InitializeParams,
        private connection: Connection,
        private documents: TextDocuments<TextDocument>,
        private extSettings: ExtensionSettings,
        private cmakeInfo: CMakeInfo,
    ) { }

    /**
 * Retrieves the current command context based on the given position.
 * Utilizes binary search to determine if the position falls within the range of any command.
 * 
 * @param contexts - An array of command contexts to search within.
 * @param position - The position to check against the command contexts.
 * @returns The command context if the position is within any command's range, otherwise null.
 */
    private findActiveCommand(contexts: cmsp.CommandContext[], position: Position): cmsp.CommandContext | null {
        if (contexts.length === 0) {
            return null;
        }

        let left = 0, right = contexts.length - 1;
        let mid = 0;
        while (left <= right) {
            mid = Math.floor((left + right) / 2);
            // line is 1-based, column is 0-based in antlr4
            const start = contexts[mid].start.line - 1;
            const stop = contexts[mid].stop.line - 1;
            if (position.line >= start && position.line <= stop) {
                return contexts[mid];
            } else if (position.line < start) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }
        return null;
    }

    private getCompletionInfoAtCursor(tree: cmsp.FileContext, position: Position): CMakeCompletionInfo {
        const commands: cmsp.CommandContext[] = tree.command_list();
        const currentCommand = this.findActiveCommand(commands, position);
        if (currentCommand === null) {
            return { type: CMakeCompletionType.Command };
        } else {
            const lParen = currentCommand.LParen();
            if (lParen === null) {
                return { type: CMakeCompletionType.Command };
            }
            // line is 1-based, column is 0-based in antlr4
            const lParenLine = currentCommand.LParen().symbol.line - 1;
            const rParenLine = currentCommand.RParen().symbol.line - 1;
            const lParenColumn = currentCommand.LParen().symbol.column;
            const rParenColumn = currentCommand.RParen().symbol.column;
            if (position.line >= lParenLine && position.line <= rParenLine) {
                // if the cursor is within the range of the command's arguments
                if (position.character > lParenColumn && position.character <= rParenColumn) {
                    return { type: CMakeCompletionType.Argument, command: currentCommand.ID().symbol.text };
                } else {
                    return { type: CMakeCompletionType.Command };
                }
            }
        }
        return { type: CMakeCompletionType.Command };
    }

    private getCommandSuggestions(word: string): Thenable<CompletionItem[]> {
        return new Promise((resolve, rejects) => {
            const similarCmds = this.cmakeInfo.commands.filter(cmd => {
                return cmd.includes(word.toLowerCase());
            });
            const suggestedCommands: CompletionItem[] = similarCmds.map((value, index, array) => {
                let item: CompletionItem = {
                    label: `${value}`,
                    kind: CompletionItemKind.Function,
                    insertText: `${value}($0)`,
                    insertTextFormat: InsertTextFormat.Snippet,
                };

                if (value in builtinCmds && "deprecated" in builtinCmds[value]) {
                    item.tags = [CompletionItemTag.Deprecated];
                }
                return item;
            });

            if (similarCmds.includes('if')) {
                suggestedCommands.push({
                    label: 'if ... endif',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'if(${1:condition})\n\t${0}\nendif()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarCmds.includes('foreach')) {
                suggestedCommands.push({
                    label: 'foreach ... endforeach',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'foreach(${1:item} ${2:items})\n\t${0}\nendforeach()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarCmds.includes('while')) {
                suggestedCommands.push({
                    label: 'while ... endwhile',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'while(${1:condition})\n\t${0}\nendwhile()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarCmds.includes('function')) {
                suggestedCommands.push({
                    label: 'function ... endfunction',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'function(${1:name} ${2:args})\n\t${0}\nendfunction()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarCmds.includes('macro')) {
                suggestedCommands.push({
                    label: 'macro ... endmacro',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'macro(${1:name} ${2:args})\n\t${0}\nendmacro()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            resolve(suggestedCommands);
        });
    }

    private getSuggestions(word: string, kind: CompletionItemKind, dataSource: string[]): Thenable<CompletionItem[]> {
        return new Promise((resolve, rejects) => {
            const similar = dataSource.filter(candidate => {
                return candidate.includes(word);
            });

            const proposals: CompletionItem[] = similar.map((value, index, array) => {
                return {
                    label: value,
                    kind: kind
                };
            });

            resolve(proposals);
        });
    }

    private getArgumentSuggestions(command: string): Promise<CompletionItem[] | null> {
        return new Promise((resolve, rejects) => {
            if (!(command in builtinCmds)) {
                return resolve(null);
            }
            const sigs: string[] = builtinCmds[command]['sig'];
            const args: string[] = sigs.flatMap(sig => {
                const matches = sig.match(/[A-Z][A-Z_]*[A-Z]/g);
                return matches ? matches : [];
            });
            resolve(Array.from(new Set(args)).map((arg, index, array) => {
                return {
                    label: arg,
                    kind: CompletionItemKind.Variable
                };
            }));
        });
    }

    public async onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        const document = this.documents.get(params.textDocument.uri);
        const inputStream = CharStreams.fromString(document.getText());
        const lexer = new CMakeSimpleLexer(inputStream);
        const tokenStream = new CommonTokenStream(lexer);
        const parser = new CMakeSimpleParser(tokenStream);
        const tree = parser.file();
        const comments = tokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));

        // if the cursor is in comments, return null
        if (inComments(params.position, comments)) {
            return null;
        }
        const info = this.getCompletionInfoAtCursor(tree, params.position);

        const word = getWordAtPosition(document, params.position).text;
        if (info.type === CMakeCompletionType.Command) {
            return this.getCommandSuggestions(word);
        } else if (info.type === CMakeCompletionType.Argument) {
            const command = info.command.toLowerCase();
            return this.getArgumentSuggestions(command);
        }

        const results = await Promise.all([
            this.getCommandSuggestions(word),
            this.getSuggestions(word, CompletionItemKind.Module, this.cmakeInfo.modules),
            this.getSuggestions(word, CompletionItemKind.Constant, this.cmakeInfo.policies),
            this.getSuggestions(word, CompletionItemKind.Variable, this.cmakeInfo.variables),
            this.getSuggestions(word, CompletionItemKind.Property, this.cmakeInfo.properties)
        ]);
        return results.flat();
    }
}
