import * as fs from 'fs';
import * as path from 'path';
import { DefinitionParams, Location, LocationLink, Position } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { DefinitionSubject } from './argumentSemantics';
import { PathExpressionRequest, PathExpressionResolver } from './pathExpressionResolver';
import { DestinationType, SymbolResolverBase } from "./symbolResolverBase";
import { FlatCommand } from './flatCommands';
import { getFindPackageUri, getIncludeFileUri, getIncludeModuleUri } from './utils';

export { DestinationType };

export class DefinitionResolver extends SymbolResolverBase {
    private getPathExpressionResolver(): PathExpressionResolver {
        return new PathExpressionResolver({
            symbolIndex: this.symbolIndex,
            getFlatCommands: this.getFlatCommands,
            entryFile: this.entryFile,
        });
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

    private async resolveRelativeFile(argText: string, sourceUri: URI, maxLine: number): Promise<URI | null> {
        return this.getPathExpressionResolver().resolveFileRequest({
            argText,
            sourceUri,
            maxLine,
        });
    }

    private createPathExpressionRequest(commandName: string, argText: string, sourceUri: URI, maxLine: number): PathExpressionRequest {
        return {
            commandName,
            argText,
            sourceUri,
            maxLine,
        };
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
        const request = this.createPathExpressionRequest(commandName, argText, sourceUri, position.line);

        switch (commandName) {
            case 'include':
                if (argIndex !== 0) {
                    return null;
                }
                const pathResolver = this.getPathExpressionResolver();
                const includeArg = await pathResolver.expandPathExpression(request);
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

                return getIncludeFileUri(this.symbolIndex, sourceBaseDir, includeArg)
                    ?? getIncludeModuleUri(this.symbolIndex, includeArg);
            case 'add_subdirectory': {
                if (argIndex !== 0) {
                    return null;
                }
                const subdirArg = await this.getPathExpressionResolver().expandPathExpression(request);
                if (!subdirArg) {
                    return null;
                }
                const cmakeLists = path.isAbsolute(subdirArg)
                    ? URI.file(path.join(path.normalize(subdirArg), 'CMakeLists.txt'))
                    : URI.file(path.resolve(path.dirname(sourceUri.fsPath), subdirArg, 'CMakeLists.txt'));
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
            case 'find_package':
                return argIndex === 0
                    ? getFindPackageUri(this.symbolIndex, path.dirname(this.entryFile.fsPath), argText)
                    : null;
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

        const pathResolver = this.getPathExpressionResolver();
        const expanded = await pathResolver.expandPathExpression(this.createPathExpressionRequest(this.command.commandName.toLowerCase(), argText, sourceUri, maxLine));
        if (!expanded) {
            return null;
        }

        if (!expanded.includes('/') && !expanded.includes('\\') && path.extname(expanded) === '') {
            return null;
        }

        return pathResolver.resolveExpandedFile(expanded, sourceUri);
    }

    private async tryResolveFileDefinition(position: Position): Promise<Location[] | null> {
        const argIndex = this.getArgumentIndexAtPosition(this.command, position);
        if (argIndex === null) {
            return null;
        }

        const uri = await this.resolveLiteralFileUri(this.command, argIndex, position);
        return uri ? [this.toFileLocation(uri)] : null;
    }

    private getReachableCandidateFiles(): string[] {
        const candidateFiles = this.symbolIndex.getReachableFiles(this.entryFile.toString());
        if (!candidateFiles.includes(this.curFile.toString())) {
            candidateFiles.push(this.curFile.toString());
        }
        return candidateFiles;
    }

    private resolveCommandDefinitions(searchName: string): Location[] {
        if (this.isBuiltinCommand(searchName)) {
            return [];
        }

        const results: Location[] = [];
        for (const uri of this.getReachableCandidateFiles()) {
            const cache = this.symbolIndex.getCache(uri);
            if (!cache) {
                continue;
            }

            const symbols = cache.commands.get(searchName);
            if (symbols) {
                results.push(...symbols.map(symbol => symbol.getLocation()));
            }
        }

        return results;
    }

    private resolveTargetDefinitions(searchName: string): Location[] {
        const results: Location[] = [];
        for (const uri of this.getReachableCandidateFiles()) {
            const cache = this.symbolIndex.getCache(uri);
            if (!cache) {
                continue;
            }

            const symbols = cache.targets.get(searchName);
            if (symbols) {
                results.push(...symbols.map(symbol => symbol.getLocation()));
            }
        }

        return results;
    }

    private resolveVariableDefinitions(searchName: string, currentLine: number): Location[] {
        const results: Location[] = [];
        const visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryFile.toString(), this.curFile.toString());
        if (!visibleFiles.includes(this.curFile.toString())) {
            visibleFiles.push(this.curFile.toString());
        }

        for (const uri of visibleFiles) {
            const cache = this.symbolIndex.getCache(uri);
            if (!cache) {
                continue;
            }

            const symbols = cache.variables.get(searchName);
            if (!symbols) {
                continue;
            }

            const validSymbols = uri === this.curFile.toString()
                ? symbols.filter(symbol => symbol.line <= currentLine)
                : symbols;
            this.logger.info(`Found valid symbols for ${searchName} in ${uri}: ${validSymbols.length}`);
            results.push(...validSymbols.map(symbol => symbol.getLocation()));
        }

        results.reverse();
        return results;
    }

    private async resolveBySubject(subject: DefinitionSubject, searchName: string, position: Position): Promise<Location[] | null> {
        switch (subject) {
            case DefinitionSubject.Command: {
                const results = this.resolveCommandDefinitions(searchName.toLowerCase());
                return results.length > 0 ? results : null;
            }
            case DefinitionSubject.Target: {
                const results = this.resolveTargetDefinitions(searchName);
                return results.length > 0 ? results : null;
            }
            case DefinitionSubject.FilePath:
            case DefinitionSubject.IncludeModule:
            case DefinitionSubject.FindPackage:
                return this.tryResolveFileDefinition(position);
            case DefinitionSubject.Variable:
            default: {
                const results = this.resolveVariableDefinitions(searchName, position.line);
                return results.length > 0 ? results : null;
            }
        }
    }

    public async resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        await this.determineContextAndRoot();

        const resolvedTarget = this.getResolvedCursorTarget(document, params.position);
        if (!resolvedTarget) {
            return null;
        }

        const results = await this.resolveBySubject(resolvedTarget.subject, resolvedTarget.text, params.position);
        this.logger.info(`Returning ${results?.length ?? 0} results for ${resolvedTarget.text}`);
        return results;
    }
}

