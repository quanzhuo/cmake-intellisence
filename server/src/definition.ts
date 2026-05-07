import * as fs from 'fs';
import * as path from 'path';
import { DefinitionParams, Location, LocationLink, Position } from "vscode-languageserver";
import { URI, Utils } from 'vscode-uri';
import { DefinitionSubject } from './argumentSemantics';
import { DestinationType, SymbolResolverBase } from "./symbolResolverBase";
import { FlatCommand } from './flatCommands';
import { getIncludeFileUri } from './utils';

export { DestinationType };

export class DefinitionResolver extends SymbolResolverBase {
    private getKnownPathVariableValue(name: string, sourceUri: URI): string | null {
        const sourceDir = path.dirname(sourceUri.fsPath);
        const rootDir = path.dirname(this.entryFile.fsPath);

        switch (name) {
            case 'CMAKE_CURRENT_LIST_DIR':
            case 'CMAKE_CURRENT_SOURCE_DIR':
                return sourceDir;
            case 'CMAKE_SOURCE_DIR':
            case 'PROJECT_SOURCE_DIR':
                return rootDir;
            default:
                return null;
        }
    }

    private normalizeSetValue(argText: string): string {
        if ((argText.startsWith('"') && argText.endsWith('"')) ||
            (argText.startsWith("'") && argText.endsWith("'"))) {
            return argText.slice(1, -1);
        }

        return argText;
    }

    private getSimpleSetValue(command: FlatCommand): string | null {
        if (command.commandName.toLowerCase() !== 'set') {
            return null;
        }

        const args = command.argument_list();
        if (args.length !== 2) {
            return null;
        }

        const value = args[1]?.getText();
        return value ? this.normalizeSetValue(value) : null;
    }

    private async resolveVariableValue(
        variableName: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string>,
        depth: number,
    ): Promise<string | null> {
        const recursionKey = `${sourceUri.toString()}::${variableName}`;
        if (seen.has(recursionKey)) {
            return null;
        }

        seen.add(recursionKey);
        try {
            const visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryFile.toString(), sourceUri.toString());
            if (!visibleFiles.includes(sourceUri.toString())) {
                visibleFiles.push(sourceUri.toString());
            }

            for (let fileIndex = visibleFiles.length - 1; fileIndex >= 0; fileIndex--) {
                const candidateUri = visibleFiles[fileIndex];
                const commands = await this.getFlatCommands(candidateUri);
                for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex--) {
                    const candidate = commands[commandIndex];
                    if (candidate.commandName.toLowerCase() !== 'set') {
                        continue;
                    }

                    if (candidateUri === sourceUri.toString() && candidate.start.line - 1 > maxLine) {
                        continue;
                    }

                    const args = candidate.argument_list();
                    if (args[0]?.getText() !== variableName) {
                        continue;
                    }

                    const value = this.getSimpleSetValue(candidate);
                    if (!value) {
                        continue;
                    }

                    return this.expandPathVariables(
                        value,
                        URI.parse(candidateUri),
                        candidate.start.line - 1,
                        seen,
                        depth + 1,
                    );
                }
            }

            return null;
        } finally {
            seen.delete(recursionKey);
        }
    }

    private async expandPathVariables(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string> = new Set(),
        depth = 0,
    ): Promise<string | null> {
        if (depth > 8) {
            return null;
        }

        const matches = Array.from(argText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return argText;
        }

        let expanded = argText;
        for (const match of matches) {
            const placeholder = match[0];
            const variableName = match[1];
            const replacement = this.getKnownPathVariableValue(variableName, sourceUri)
                ?? await this.resolveVariableValue(variableName, sourceUri, maxLine, seen, depth + 1);

            if (!replacement) {
                return null;
            }

            expanded = expanded.replace(placeholder, replacement);
        }

        return expanded.includes('${')
            ? this.expandPathVariables(expanded, sourceUri, maxLine, seen, depth + 1)
            : expanded;
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

    private resolveExpandedFile(argText: string, sourceUri: URI): URI | null {
        const baseDir = URI.file(path.dirname(sourceUri.fsPath));
        const target = path.isAbsolute(argText)
            ? URI.file(path.normalize(argText))
            : Utils.joinPath(baseDir, argText);

        if (!fs.existsSync(target.fsPath) || fs.statSync(target.fsPath).isDirectory()) {
            return null;
        }

        return target;
    }

    private async resolveRelativeFile(argText: string, sourceUri: URI, maxLine: number): Promise<URI | null> {
        const expanded = await this.expandPathVariables(argText, sourceUri, maxLine);
        if (!expanded) {
            return null;
        }

        return this.resolveExpandedFile(expanded, sourceUri);
    }

    private async resolveLiteralFileUri(command: FlatCommand, argIndex: number, position: Position): Promise<URI | null> {
        const args = command.argument_list();
        const argText = args[argIndex]?.getText();
        if (!argText) {
            return null;
        }

        const commandName = command.ID().symbol.text.toLowerCase();
        const sourceUri = this.curFile;
        const sourceBaseDir = URI.file(path.dirname(sourceUri.fsPath));

        switch (commandName) {
            case 'include':
                if (argIndex !== 0) {
                    return null;
                }
                const includeArg = await this.expandPathVariables(argText, sourceUri, position.line);
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

                return getIncludeFileUri(this.symbolIndex, sourceBaseDir, includeArg);
            case 'add_subdirectory': {
                if (argIndex !== 0) {
                    return null;
                }
                const subdirArg = await this.expandPathVariables(argText, sourceUri, position.line);
                if (!subdirArg) {
                    return null;
                }
                const cmakeLists = path.isAbsolute(subdirArg)
                    ? URI.file(path.join(path.normalize(subdirArg), 'CMakeLists.txt'))
                    : Utils.joinPath(sourceBaseDir, subdirArg, 'CMakeLists.txt');
                return fs.existsSync(cmakeLists.fsPath) ? cmakeLists : null;
            }
            case 'configure_file':
                return argIndex <= 1 ? this.resolveRelativeFile(argText, sourceUri, position.line) : null;
            case 'add_executable':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['WIN32', 'MACOSX_BUNDLE', 'EXCLUDE_FROM_ALL', 'IMPORTED', 'ALIAS']), sourceUri, position.line);
            case 'add_library':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['STATIC', 'SHARED', 'MODULE', 'OBJECT', 'ALIAS', 'GLOBAL', 'INTERFACE', 'IMPORTED']), sourceUri, position.line);
            case 'target_sources':
                return this.resolveSourceFileArgument(argIndex, argText, new Set(['INTERFACE', 'PUBLIC', 'PRIVATE', 'FILE_SET', 'TYPE', 'BASE_DIRS', 'FILES']), sourceUri, position.line);
            default:
                return null;
        }
    }

    private async resolveSourceFileArgument(
        argIndex: number,
        argText: string,
        keywords: Set<string>,
        sourceUri: URI,
        maxLine: number,
    ): Promise<URI | null> {
        if (argIndex === 0 || keywords.has(argText)) {
            return null;
        }

        const expanded = await this.expandPathVariables(argText, sourceUri, maxLine);
        if (!expanded) {
            return null;
        }

        if (!expanded.includes('/') && !expanded.includes('\\') && path.extname(expanded) === '') {
            return null;
        }

        return this.resolveExpandedFile(expanded, sourceUri);
    }

    private async tryResolveFileDefinition(position: Position): Promise<Location[] | null> {
        const argIndex = this.getArgumentIndexAtPosition(this.command, position);
        if (argIndex === null) {
            return null;
        }

        const uri = await this.resolveLiteralFileUri(this.command, argIndex, position);
        return uri ? [this.toFileLocation(uri)] : null;
    }

    public async resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        await this.determineContextAndRoot();

        const resolvedTarget = this.getResolvedCursorTarget(document, params.position);
        const fileResults = await this.tryResolveFileDefinition(params.position);
        if (fileResults) {
            return fileResults;
        }

        if (!resolvedTarget) {
            return null;
        }

        if (resolvedTarget.subject === DefinitionSubject.FilePath) {
            return null;
        }

        const destinationType = this.getDestinationType(this.command, resolvedTarget.text, params.position);
        const isCommand = destinationType === DestinationType.Command;
        const isTarget = destinationType === DestinationType.Target;
        const searchName = isCommand ? resolvedTarget.text.toLowerCase() : resolvedTarget.text;

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

