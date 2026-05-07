import * as fs from 'fs';
import * as path from 'path';
import { DefinitionParams, Location, LocationLink } from "vscode-languageserver";
import { URI, Utils } from 'vscode-uri';
import { DestinationType, SymbolResolverBase } from "./symbolResolverBase";
import { FlatCommand } from './flatCommands';
import { getIncludeFileUri } from './utils';

export { DestinationType };

export class DefinitionResolver extends SymbolResolverBase {
    private expandKnownPathVariables(argText: string): string | null {
        const rootDir = path.dirname(this.entryFile.fsPath);
        const replacements = new Map<string, string>([
            ['CMAKE_CURRENT_LIST_DIR', this.baseDir.fsPath],
            ['CMAKE_CURRENT_SOURCE_DIR', this.baseDir.fsPath],
            ['CMAKE_SOURCE_DIR', rootDir],
            ['PROJECT_SOURCE_DIR', rootDir],
        ]);

        let unresolved = false;
        const expanded = argText.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
            const replacement = replacements.get(name);
            if (!replacement) {
                unresolved = true;
                return _;
            }
            return replacement;
        });

        return unresolved ? null : expanded;
    }

    private toFileLocation(uri: URI): Location {
        return {
            uri: uri.toString(),
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            }
        };
    }

    private resolveRelativeFile(argText: string): URI | null {
        const expanded = this.expandKnownPathVariables(argText);
        if (!expanded) {
            return null;
        }

        const target = path.isAbsolute(expanded)
            ? URI.file(path.normalize(expanded))
            : Utils.joinPath(this.baseDir, expanded);

        if (!fs.existsSync(target.fsPath) || fs.statSync(target.fsPath).isDirectory()) {
            return null;
        }
        return target;
    }

    private resolveLiteralFileUri(command: FlatCommand, argIndex: number): URI | null {
        const args = command.argument_list();
        const argText = args[argIndex]?.getText();
        if (!argText) {
            return null;
        }

        const commandName = command.ID().symbol.text.toLowerCase();
        switch (commandName) {
            case 'include':
                if (argIndex !== 0) {
                    return null;
                }
                const includeArg = this.expandKnownPathVariables(argText);
                if (!includeArg) {
                    return null;
                }

                if (path.isAbsolute(includeArg)) {
                    const includeUri = URI.file(path.normalize(includeArg));
                    if (!fs.existsSync(includeUri.fsPath) || fs.statSync(includeUri.fsPath).isDirectory()) {
                        return null;
                    }
                    return includeUri;
                }

                return getIncludeFileUri(this.symbolIndex, this.baseDir, includeArg);
            case 'add_subdirectory': {
                if (argIndex !== 0) {
                    return null;
                }
                const subdirArg = this.expandKnownPathVariables(argText);
                if (!subdirArg) {
                    return null;
                }
                const cmakeLists = path.isAbsolute(subdirArg)
                    ? URI.file(path.join(path.normalize(subdirArg), 'CMakeLists.txt'))
                    : Utils.joinPath(this.baseDir, subdirArg, 'CMakeLists.txt');
                return fs.existsSync(cmakeLists.fsPath) ? cmakeLists : null;
            }
            case 'configure_file':
                return argIndex <= 1 ? this.resolveRelativeFile(argText) : null;
            case 'add_executable':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['WIN32', 'MACOSX_BUNDLE', 'EXCLUDE_FROM_ALL', 'IMPORTED', 'ALIAS']));
            case 'add_library':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['STATIC', 'SHARED', 'MODULE', 'OBJECT', 'ALIAS', 'GLOBAL', 'INTERFACE', 'IMPORTED']));
            case 'target_sources':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['INTERFACE', 'PUBLIC', 'PRIVATE', 'FILE_SET', 'TYPE', 'BASE_DIRS', 'FILES']));
            default:
                return null;
        }
    }

    private resolveSourceFileArgument(argIndex: number, argText: string, keywords: Set<string>): URI | null {
        if (argIndex === 0 || keywords.has(argText)) {
            return null;
        }

        if (!argText.includes('/') && !argText.includes('\\') && path.extname(argText) === '') {
            return null;
        }

        return this.resolveRelativeFile(argText);
    }

    private tryResolveFileDefinition(position: import('vscode-languageserver').Position): Location[] | null {
        const argIndex = this.getArgumentIndexAtPosition(this.command, position);
        if (argIndex === null) {
            return null;
        }

        const uri = this.resolveLiteralFileUri(this.command, argIndex);
        return uri ? [this.toFileLocation(uri)] : null;
    }

    public async resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        const targetWord = this.getTargetWord(document, params.position);
        if (!targetWord) {
            return null;
        }

        await this.determineContextAndRoot();

        const fileResults = this.tryResolveFileDefinition(params.position);
        if (fileResults) {
            return fileResults;
        }

        const destinationType = this.getDestinationType(this.command, targetWord, params.position);
        const isCommand = destinationType === DestinationType.Command;
        const isTarget = destinationType === DestinationType.Target;
        const searchName = isCommand ? targetWord.toLowerCase() : targetWord;

        if (isCommand) {
            if (this.isBuiltinCommand(searchName)) {
                return null;
            }
        }

        const results: Location[] = [];

        if (isCommand) {
            const candidateFiles = this.symbolIndex.getReachableFiles(this.entryFile.toString());
            if (!candidateFiles.includes(this.curFile.toString())) {
                candidateFiles.push(this.curFile.toString());
            }

            // CMake functions & macros are broadly globally available once executed within the same entry tree.
            for (const uri of candidateFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (!cache) {
                    continue;
                }
                const symbols = cache.commands.get(searchName);
                if (symbols) {
                    results.push(...symbols.map(s => s.getLocation()));
                }
            }
        } else if (isTarget) {
            const candidateFiles = this.symbolIndex.getReachableFiles(this.entryFile.toString());
            if (!candidateFiles.includes(this.curFile.toString())) {
                candidateFiles.push(this.curFile.toString());
            }

            for (const uri of candidateFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (!cache) {
                    continue;
                }

                const symbols = cache.targets.get(searchName);
                if (symbols) {
                    results.push(...symbols.map(s => s.getLocation()));
                }
            }
        } else {
            // Variables use dynamic scoping paths
            const visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryFile.toString(), this.curFile.toString());
            // If current file wasn't reachable from root, at least check current file itself
            if (!visibleFiles.includes(this.curFile.toString())) {
                visibleFiles.push(this.curFile.toString());
            }

            for (const uri of visibleFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (cache) {
                    const symbols = cache.variables.get(searchName);
                    if (symbols) {
                        // Do not jump to variable assignments that appear after current line in same file!
                        const validSymbols = uri === this.curFile.toString()
                            ? symbols.filter(s => s.line <= params.position.line)
                            : symbols;
                        this.logger.info(`Found valid symbols for ${searchName} in ${uri}: ${validSymbols.length}`);
                        results.push(...validSymbols.map(s => s.getLocation()));
                    }
                }
            }

            // To be accurate and helpful, reverse the array so the "closest" lexical definitions show up first
            results.reverse();
        }

        this.logger.info(`Returning ${results.length} results for ${searchName}`);
        return results.length > 0 ? results : null;
    }
}

