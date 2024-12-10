import { CommonTokenStream, Token } from "antlr4";
import * as fs from 'fs';
import { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionParams, Connection, InitializeParams, InsertTextFormat, Position, TextDocuments } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { CMakeInfo } from "./cmakeInfo";
import CMakeSimpleLexer from "./generated/CMakeSimpleLexer";
import * as cmsp from "./generated/CMakeSimpleParser";
import { builtinCmds, getWordAtPosition } from "./server";
import { getCmdKeyWords } from "./utils";
import path = require("path");

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

    /**
     * if type is CMakeCompletionType.Argument, this field is the current command context
     */
    context?: cmsp.CommandContext,

    /**
     * if type is CMakeCompletionType.Argument, this field is the active command name
     */
    command?: string,

    /**
     * if type is CMakeCompletionType.Argument, this field is the current argument index
     */
    index?: number,
}

export interface ProjectInfo {
    /**
     * Project name
     */
    projectName?: string,

    /**
     * Languages used in the project
     */
    languages?: Set<string>,

    executables?: Set<string>,
    libraries?: Set<string>,

    /**
     * User defined functions
     */
    functions?: Set<string>,

    /**
     * User defined macros
     */
    macros?: Set<string>,
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

/**
 * Retrieves the current command context based on the given position.
 * Utilizes binary search to determine if the position falls within the range of any command.
 * 
 * @param contexts - An array of command contexts to search within.
 * @param position - The position to check against the command contexts.
 * @returns The command context if the position is within any command's range, otherwise null.
 */
export function findCommandAtPosition(contexts: cmsp.CommandContext[], position: Position): cmsp.CommandContext | null {
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

export default class Completion {
    private completionParams: CompletionParams;

    constructor(
        private initParams: InitializeParams,
        private connection: Connection,
        private documents: TextDocuments<TextDocument>,
        private cmakeInfo: CMakeInfo,
        private simpleFileContexts: Map<string, cmsp.FileContext>,
        private projectInfo: ProjectInfo = {},
    ) { }

    private isCursorWithinParentheses(position: Position, lParenLine: number, lParenColumn: number, rParenLine: number, rParenColumn: number): boolean {
        if (position.line < lParenLine || position.line > rParenLine) {
            return false;
        }
        if (position.line === lParenLine && position.character <= lParenColumn) {
            return false;
        }
        if (position.line === rParenLine && position.character > rParenColumn) {
            return false;
        }
        return true;
    }

    private getCompletionInfoAtCursor(tree: cmsp.FileContext, pos: Position): CMakeCompletionInfo {
        const commands: cmsp.CommandContext[] = tree.command_list();
        const currentCommand = findCommandAtPosition(commands, pos);
        if (currentCommand === null) {
            return { type: CMakeCompletionType.Command };
        }

        const lParen = currentCommand.LParen();
        const rParen = currentCommand.RParen();
        if (lParen === null || rParen === null) {
            return { type: CMakeCompletionType.Command };
        }
        // line is 1-based, column is 0-based in antlr4
        const lParenLine = lParen.symbol.line - 1;
        const rParenLine = rParen.symbol.line - 1;
        const lParenColumn = lParen.symbol.column;
        const rParenColumn = rParen.symbol.column;

        // Check if the cursor is within the parentheses
        if (this.isCursorWithinParentheses(pos, lParenLine, lParenColumn, rParenLine, rParenColumn)) {
            // Get the current argument index
            const args = currentCommand.argument_list();
            let index = 0;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                const argStart = arg.start;

                // Check if the cursor is within the current argument
                if (pos.line === argStart.line - 1 && pos.character >= argStart.column && pos.character <= argStart.column + argStart.text.length) {
                    index = i;
                    break;
                }
                // Check if the cursor is before the current argument
                else if (pos.line < argStart.line - 1 || (pos.line === argStart.line - 1 && pos.character < argStart.column)) {
                    index = i;
                    break;
                }
                // If the cursor is after the current argument
                else {
                    index = i + 1;
                }
            }
            // console.log(`index: ${index}`);
            return { type: CMakeCompletionType.Argument, context: currentCommand, command: currentCommand.ID().symbol.text, index: index };
        } else {
            return { type: CMakeCompletionType.Command };
        }

    }

    private getCommandSuggestions(word: string): Promise<CompletionItem[]> {
        return new Promise((resolve, rejects) => {
            const allCommands = [
                ...this.cmakeInfo.commands,
                ...(this.projectInfo.functions ?? []),
                ...(this.projectInfo.macros ?? []),
            ];
            const similarCmds = allCommands.filter(cmd => { return cmd.includes(word.toLowerCase()); });
            const suggestedCommands: CompletionItem[] = similarCmds.map((commandName, index, array) => {
                let item: CompletionItem = {
                    label: `${commandName}`,
                    kind: CompletionItemKind.Function,
                    insertText: `${commandName}($0)`,
                    insertTextFormat: InsertTextFormat.Snippet,
                };

                if (commandName in builtinCmds) {
                    item.documentation = builtinCmds[commandName]['doc'];
                    if ("deprecated" in builtinCmds[commandName]) {
                        item.tags = [CompletionItemTag.Deprecated];
                    }
                }
                return item;
            });

            if (similarCmds.includes('block')) {
                suggestedCommands.push({
                    label: 'block ... endblock',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'block(${1:name})\n\t${0}\nendblock()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

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

    private async getSuggestions(word: string, kind: CompletionItemKind, dataSource: string[]): Promise<CompletionItem[]> {
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

    private getModuleSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const similar = this.cmakeInfo.modules.filter(candidate => {
            return candidate.includes(word);
        });

        const proposals: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value.startsWith('Find') ? value.substring(4) : value,
                kind: CompletionItemKind.Module,
            };
        });

        return proposals;
    }

    private async getFileSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
        const uri: URI = URI.parse(this.completionParams.textDocument.uri);
        const fsPath: string = uri.fsPath;

        // Get the directory part and the filter part from the word
        const lastSlashIndex = word.lastIndexOf('/');
        const dir = path.join(path.dirname(fsPath), word.substring(0, lastSlashIndex + 1));
        const filter = word.substring(lastSlashIndex + 1);

        // Read the directory contents
        const files = await new Promise<string[]>((resolve, reject) => {
            fs.readdir(dir, (err: NodeJS.ErrnoException | null, files: string[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(files);
                }
            });
        });

        // Filter the files based on the filter part
        const filteredFiles = files.filter(file => file.includes(filter));

        // Create completion items
        const suggestions: CompletionItem[] = await Promise.all(filteredFiles.map(async (file) => {
            const filePath = path.join(dir, file);
            const stat = await fs.promises.stat(filePath);
            return {
                label: file,
                kind: stat.isDirectory() ? CompletionItemKind.Folder : CompletionItemKind.File,
            };
        }));

        return suggestions;
    }

    private getVariableSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        let similar = this.cmakeInfo.variables.filter(candidate => {
            return candidate.includes(word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Variable,
            };
        });

        return suggestions;
    }

    private getTargetsSuggestion(info: CMakeCompletionInfo): CompletionItem[] | undefined {
        const targets = [...this.projectInfo.executables ?? [], ...this.projectInfo.libraries ?? []];
        if (targets.length > 0) {
            return targets.map((target) => {
                return {
                    label: target,
                    kind: CompletionItemKind.Variable,
                };
            });
        }
    }

    private getPropertySuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        let similar = this.cmakeInfo.properties.filter(candidate => {
            return candidate.includes(word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Property,
            };
        });

        return suggestions;
    }

    private async getArgumentSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
        if (!(info.command in builtinCmds)) {
            return null;
        }

        switch (info.command) {
            case 'find_package': {
                if (info.index === 0) {
                    return this.getModuleSuggestions(info, word);
                }
                break;
            }
            case 'cmake_policy': {
                if (info.index === 1) {
                    const firstArg = info.context.argument(0).ID().getText();
                    if (firstArg === 'GET' || firstArg === 'SET') {
                        return this.getPolicySuggestions(info, word);
                    }
                }
                break;
            }
            case 'target_compile_definitions':
            case 'target_compile_features':
            case 'target_compile_options':
            case 'target_include_directories':
            case 'target_link_directories':
            case 'target_link_options':
            case 'target_precompile_headers':
            case 'target_sources': {
                if (info.index === 0) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                }
                break;
            }
            case 'target_link_libraries': {
                if (info.index === 0) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                } else {
                    const items = [
                        ...this.projectInfo.executables ?? [],
                        ...this.projectInfo.libraries ?? [],
                        'PRIVATE', 'PUBLIC', 'INTERFACE',
                        'LINK_INTERFACE_LIBRARIES',
                        'LINK_PRIVATE',
                        'LINK_PUBLIC',
                    ];
                    if (items.length > 0) {
                        return items.map((lib) => {
                            return {
                                label: lib,
                                kind: CompletionItemKind.Variable,
                            };
                        });
                    }
                }
                break;
            }
            case 'get_property':
            case 'set_property':
            case 'define_property': {
                if (info.index > 1) {
                    const preArg = info.context.argument(info.index - 1).getText();
                    if (preArg === 'PROPERTY') {
                        return this.getPropertySuggestions(info, word);
                    }
                }
                break;
            }
            case 'get_target_property': {
                if (info.index === 1) {
                    const targets = this.getTargetsSuggestion(info);
                    if (targets) {
                        return targets;
                    }
                } else if (info.index === 2) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            case 'get_cmake_property':
            case 'get_test_property': {

                if (info.index === 1) {
                    return this.getPropertySuggestions(info, word);
                }
                break;
            }
            default:
                break;
        }

        if (word.startsWith('./') || word.startsWith('../')) {
            return this.getFileSuggestions(info, word);
        }

        const sigs: string[] = builtinCmds[info.command]['sig'];
        const args: string[] = getCmdKeyWords(sigs);
        const argsCompletions = args.map((arg) => {
            return {
                label: arg,
                kind: CompletionItemKind.Keyword,
            };
        });
        return [...this.getVariableSuggestions(info, word), ...argsCompletions];
    }

    private getPolicySuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        let similar = this.cmakeInfo.policies.filter(candidate => {
            return candidate.includes(word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Constant,
            };
        });

        return suggestions;
    }

    public async onCompletion(params: CompletionParams, simpleFileContext: cmsp.FileContext, simpleTokenStream: CommonTokenStream): Promise<CompletionItem[] | CompletionList | null> {
        this.completionParams = params;
        const comments = simpleTokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));

        // if the cursor is in comments, return null
        if (inComments(params.position, comments)) {
            return null;
        }

        const info = this.getCompletionInfoAtCursor(simpleFileContext, params.position);
        const word = getWordAtPosition(this.documents.get(params.textDocument.uri), params.position).text;
        if (info.type === CMakeCompletionType.Command) {
            return this.getCommandSuggestions(word);
        } else if (info.type === CMakeCompletionType.Argument) {
            return this.getArgumentSuggestions(info, word);
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
