import { CommonTokenStream, Token } from "antlr4";
import * as fs from 'fs';
import * as path from 'path';
import { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionParams, InsertTextFormat, Position } from "vscode-languageserver";
import { URI } from "vscode-uri";
import * as builtinCmds from './builtin-cmds.json';
import { CMakeInfo } from "./cmakeInfo";
import CMakeSimpleLexer from "./generated/CMakeSimpleLexer";
import * as cmsp from "./generated/CMakeSimpleParser";
import { Logger } from "./logging";

export { builtinCmds };

export enum CMakeCompletionType {
    Command,
    Module,
    Policy,
    Variable,
    Property,
    Argument,
}

export enum CompletionItemType {
    BuiltInCommand,
    BuiltInModule,
    BuiltInPolicy,
    BuiltInProperty,
    BuiltInVariable,

    UserDefinedCommand,
    UserDefinedVariable,
    PkgConfigModules,
}

export interface CMakeCompletionInfo {
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

/**
 * Checks if the cursor position is within the parentheses defined by the given positions.
 *
 * @param position - The current cursor position.
 * @param lParenLine - The line number of the left parenthesis.
 * @param lParenColumn - The column number of the left parenthesis.
 * @param rParenLine - The line number of the right parenthesis.
 * @param rParenColumn - The column number of the right parenthesis.
 * @returns `true` if the cursor is within the parentheses, otherwise `false`.
 */
export function isCursorWithinParentheses(position: Position, lParenLine: number, lParenColumn: number, rParenLine: number, rParenColumn: number): boolean {
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

/**
 * Retrieves completion information at the given cursor position within a CMake file context.
 *
 * @param tree - The CMake file context containing the command list.
 * @param pos - The cursor position for which to retrieve completion information.
 * @returns An object containing the type of completion (command or argument) and additional context if applicable.
 *
 * The function determines if the cursor is within a command's parentheses and identifies the current argument index if so.
 * If the cursor is not within any command's parentheses, it returns a completion type of `Command`.
 */
export function getCompletionInfoAtCursor(tree: cmsp.FileContext, pos: Position): CMakeCompletionInfo {
    const commands: cmsp.CommandContext[] = tree.command_list();
    const currentCommand = findCommandAtPosition(commands, pos);
    if (currentCommand === null) {
        return { type: CMakeCompletionType.Command };
    }

    const lParen = currentCommand.LP();
    const rParen = currentCommand.RP();
    if (lParen === null || rParen === null) {
        return { type: CMakeCompletionType.Command };
    }
    // line is 1-based, column is 0-based in antlr4
    const lParenLine = lParen.symbol.line - 1;
    const rParenLine = rParen.symbol.line - 1;
    const lParenColumn = lParen.symbol.column;
    const rParenColumn = rParen.symbol.column;

    // Check if the cursor is within the parentheses
    if (isCursorWithinParentheses(pos, lParenLine, lParenColumn, rParenLine, rParenColumn)) {
        // Get the current argument index
        const args = currentCommand.argument_list();
        let index = 0;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            const argStart = arg.start;

            // Check if the cursor is within the current argument
            if (pos.line === argStart.line - 1 && pos.character >= argStart.column && pos.character <= argStart.column + argStart.text.length) {
                // Check if the cursor is within ${}
                const argText = argStart.text;
                const dollarIndex = argText.indexOf('${');
                const closingBraceIndex = argText.indexOf('}', dollarIndex);
                if (dollarIndex !== -1 && closingBraceIndex !== -1 && pos.character >= argStart.column + dollarIndex + 2 && pos.character <= argStart.column + closingBraceIndex) {
                    return { type: CMakeCompletionType.Variable };
                }
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
        return { type: CMakeCompletionType.Argument, context: currentCommand, command: currentCommand.ID().symbol.text, index: index };
    } else {
        return { type: CMakeCompletionType.Command };
    }
}

export default class Completion {
    private completionParams: CompletionParams;

    constructor(
        private cmakeInfo: CMakeInfo,
        private simpleFileContexts: Map<string, cmsp.FileContext>,
        private simpleTokenStreams: Map<string, CommonTokenStream>,
        private projectInfo: ProjectInfo = {},
        private word: string,
        private logger: Logger,
    ) { }

    private getCommandSuggestion(commandName: string, type: CompletionItemType): CompletionItem {
        let item: CompletionItem;
        switch (commandName) {
            case 'cmake_minimum_required': {
                item = {
                    label: 'cmake_minimum_required',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_minimum_required(VERSION ${1:3.16})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_host_system_information': {
                item = {
                    label: 'cmake_host_system_information',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_host_system_information(RESULT ${1:variable} QUERY ${2:key})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_pkg_config': {
                item = {
                    label: 'cmake_pkg_config',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_pkg_config(EXTRACT ${1:package})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'execute_process': {
                item = {
                    label: 'execute_process',
                    kind: CompletionItemKind.Function,
                    insertText: 'execute_process(COMMAND ${1:command} ${2:args})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'set_directory_properties': {
                item = {
                    label: 'set_directory_properties',
                    kind: CompletionItemKind.Function,
                    insertText: 'set_directory_properties(PROPERTIES ${1:prop1} ${2:value1})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'get_cmake_property': {
                item = {
                    label: 'get_cmake_property',
                    kind: CompletionItemKind.Function,
                    insertText: 'get_cmake_property(${1:variable} ${2:property})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'add_test': {
                item = {
                    label: 'add_test',
                    kind: CompletionItemKind.Function,
                    insertText: 'add_test(NAME ${1:name} COMMAND ${2:command} ${3:args})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            case 'cmake_file_api': {
                item = {
                    label: 'cmake_file_api',
                    kind: CompletionItemKind.Function,
                    insertText: 'cmake_file_api(QUERY API_VERSION ${1:version})',
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
            }
            default:
                item = {
                    label: commandName,
                    kind: CompletionItemKind.Function,
                    insertText: `${commandName}($0)`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    data: type,
                };
                break;
        }
        if (commandName in builtinCmds) {
            if ("deprecated" in builtinCmds[commandName]) {
                item.tags = [CompletionItemTag.Deprecated];
            }
        }
        return item;
    }

    private getCommandSuggestions(word: string): Promise<CompletionItem[]> {
        return new Promise((resolve, rejects) => {
            const allCommands = [
                ...this.cmakeInfo.commands.map(value => { return { name: value, type: CompletionItemType.BuiltInCommand }; }),
                ...Array.from(this.projectInfo.functions ?? new Set<string>()).map(value => { return { name: value, type: CompletionItemType.UserDefinedCommand }; }),
                ...Array.from(this.projectInfo.macros ?? new Set<string>()).map(value => { return { name: value, type: CompletionItemType.UserDefinedCommand }; }),
            ];
            const similarCmds = allCommands.filter(cmd => { return cmd.name.includes(word.toLowerCase()); });
            const similarNames = similarCmds.map(cmd => cmd.name);
            const suggestedCommands: CompletionItem[] = similarCmds.map((command, index, array) => {
                return this.getCommandSuggestion(command.name, command.type);
            });

            if (similarNames.includes('block')) {
                suggestedCommands.push({
                    label: 'block ... endblock',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'block(${1:name})\n\t${0}\nendblock()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarNames.includes('if')) {
                suggestedCommands.push({
                    label: 'if ... endif',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'if(${1:condition})\n\t${0}\nendif()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarNames.includes('foreach')) {
                suggestedCommands.push({
                    label: 'foreach ... endforeach',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'foreach(${1:item} ${2:items})\n\t${0}\nendforeach()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarNames.includes('while')) {
                suggestedCommands.push({
                    label: 'while ... endwhile',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'while(${1:condition})\n\t${0}\nendwhile()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarNames.includes('function')) {
                suggestedCommands.push({
                    label: 'function ... endfunction',
                    kind: CompletionItemKind.Snippet,
                    insertText: 'function(${1:name} ${2:args})\n\t${0}\nendfunction()',
                    insertTextFormat: InsertTextFormat.Snippet,
                });
            }

            if (similarNames.includes('macro')) {
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

    private getModuleSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        const similar = this.cmakeInfo.modules.filter(candidate => {
            return candidate.includes(word);
        });

        const proposals: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value.startsWith('Find') ? value.substring(4) : value,
                kind: CompletionItemKind.Module,
                data: CompletionItemType.BuiltInModule,
            };
        });

        return proposals;
    }

    private async getFileSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
        const uri: URI = URI.parse(this.completionParams.textDocument.uri);
        const curDir = path.dirname(uri.fsPath);
        // Get the directory part and the filter part from the word
        const lastSlashIndex = word.lastIndexOf('/');
        const dir = path.join(curDir, word.substring(0, lastSlashIndex + 1));
        const filter = word.substring(lastSlashIndex + 1);

        // Read the directory contents
        const files = await new Promise<string[]>((resolve, reject) => {
            fs.readdir(dir, (err: NodeJS.ErrnoException | null, files: string[]) => {
                if (err) {
                    this.logger.error(`Error reading directory ${dir}: ${err.message}`);
                    resolve([]);
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

        let similarEnv = process.env ? Object.keys(process.env).filter(candidate => {
            return candidate.includes(word);
        }) : [];

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Variable,
                data: CompletionItemType.BuiltInVariable,
            };
        });

        const envVariables: CompletionItem[] = similarEnv.map((value, index, array) => {
            return {
                label: `ENV{${value}}`,
                kind: CompletionItemKind.Variable,
            };
        });

        return [...suggestions, ...envVariables];
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
                data: CompletionItemType.BuiltInProperty,
            };
        });

        return suggestions;
    }

    private pkgCheckModulesSuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        if (info.index === 0) {
            return [];
        }

        const keywords = ['REQUIRED', 'QUIET', 'NO_CMAKE_PATH', 'NO_CMAKE_ENVIRONMENT_PATH', 'IMPORTED_TARGET', 'GLOBAL',];
        const pkgConfigModules = this.cmakeInfo.pkgConfigModules.keys();
        const items = [...keywords, ...pkgConfigModules];
        const similar = items.filter(candidate => {
            return candidate.includes(word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Unit,
                data: CompletionItemType.PkgConfigModules,
            };
        });
        return suggestions;
    }

    private async getArgumentSuggestions(info: CMakeCompletionInfo, word: string): Promise<CompletionItem[] | null> {
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
            case 'pkg_check_modules': {
                return this.pkgCheckModulesSuggestions(info, word);
            }
            case 'set': {
                if (info.index === 0) {
                    return this.getVariableSuggestions(info, word);
                }
                break;
            }
            default:
                break;
        }

        if (!(info.command in builtinCmds)) {
            return null;
        }

        const args: string[] = builtinCmds[info.command]['keyword'] ?? [];
        const argsCompletions = args.map((arg) => {
            return {
                label: arg,
                kind: CompletionItemKind.Keyword,
            };
        });
        if (info.command === 'if' || info.command === 'elseif' || info.command === 'while') {
            return [...argsCompletions, ...this.getVariableSuggestions(info, word), ...(await this.getFileSuggestions(info, word) ?? [])];
        }
        return [...argsCompletions, ...(await this.getFileSuggestions(info, word) ?? [])];
    }

    private getPolicySuggestions(info: CMakeCompletionInfo, word: string): CompletionItem[] {
        let similar = this.cmakeInfo.policies.filter(candidate => {
            return candidate.includes(word);
        });

        const suggestions: CompletionItem[] = similar.map((value, index, array) => {
            return {
                label: value,
                kind: CompletionItemKind.Constant,
                data: CompletionItemType.BuiltInPolicy,
            };
        });

        return suggestions;
    }

    public async onCompletion(params: CompletionParams): Promise<CompletionItem[] | CompletionList | null> {
        this.completionParams = params;
        const simpleTokenStream = this.simpleTokenStreams.get(params.textDocument.uri);
        const comments = simpleTokenStream.tokens.filter(token => token.channel === CMakeSimpleLexer.channelNames.indexOf("COMMENTS"));

        // if the cursor is in comments, return null
        if (inComments(params.position, comments)) {
            return null;
        }

        const simpleFileContext = this.simpleFileContexts.get(params.textDocument.uri);
        const info = getCompletionInfoAtCursor(simpleFileContext, params.position);
        if (info.type === CMakeCompletionType.Command) {
            return this.getCommandSuggestions(this.word);
        } else if (info.type === CMakeCompletionType.Argument) {
            return this.getArgumentSuggestions(info, this.word);
        } else if (info.type === CMakeCompletionType.Variable) {
            return this.getVariableSuggestions(info, this.word);
        }
        throw new Error('Unknown completion type');
    }
}
