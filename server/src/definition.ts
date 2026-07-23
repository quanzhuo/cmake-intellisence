import * as fs from 'fs';
import * as path from 'path';
import { DefinitionParams, Location, LocationLink, Position } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { DefinitionSubject } from './argumentSemantics';
import { FileApiRawSnapshot } from './fileApiSnapshot';
import { PathExpressionRequest, PathExpressionResolver } from './pathExpressionResolver';
import { SymbolBindingResolver } from './symbolBinding';
import { SymbolNamespace } from './symbolIndex';
import { SymbolResolverBase } from "./symbolResolverBase";
import { FlatCommand } from './flatCommands';
import { getFindPackageUri, getIncludeFileUri, getIncludeModuleUri } from './utils';

export class DefinitionResolver extends SymbolResolverBase {
    private pathExpressionResolver?: PathExpressionResolver;

    constructor(
        documents: SymbolResolverBase['documents'],
        symbolIndex: SymbolResolverBase['symbolIndex'],
        getFlatCommands: SymbolResolverBase['getFlatCommands'],
        workspaceFolder: string,
        curFile: URI,
        command: FlatCommand,
        logger: SymbolResolverBase['logger'],
        shouldCancel?: () => boolean,
        private fileApiRawSnapshot?: FileApiRawSnapshot,
        private buildDirectory?: string,
        ensureFileIndexed?: (uri: string, entryFile: string) => Promise<boolean>,
    ) {
        super(documents, symbolIndex, getFlatCommands, workspaceFolder, curFile, command, logger, shouldCancel, ensureFileIndexed);
    }

    private getPathExpressionResolver(): PathExpressionResolver {
        if (!this.pathExpressionResolver) {
            this.pathExpressionResolver = new PathExpressionResolver({
                symbolIndex: this.symbolIndex,
                getFlatCommands: this.getFlatCommands,
                entryFile: this.entryFile,
                buildDirectory: this.buildDirectory,
                buildDirectoriesBySourcePath: this.fileApiRawSnapshot?.buildDirectoriesBySourcePath,
            });
        }

        return this.pathExpressionResolver;
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

                const normalizedModuleName = includeArg.replace(/^["']|["']$/g, '');
                const indexedDependency = this.symbolIndex.getAvailableDependencies(
                    sourceUri.toString(),
                    this.entryFile.toString(),
                ).find(dependency => {
                    if (dependency.type !== 'include' || normalizedModuleName.includes('/') || normalizedModuleName.includes('\\')) {
                        return false;
                    }
                    return path.basename(URI.parse(dependency.uri).fsPath).toLowerCase() === `${normalizedModuleName}.cmake`.toLowerCase();
                });

                return getIncludeFileUri(this.symbolIndex, sourceBaseDir, includeArg)
                    ?? (indexedDependency ? URI.parse(indexedDependency.uri) : null)
                    ?? getIncludeModuleUri(this.symbolIndex, includeArg, this.fileApiRawSnapshot);
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
                    ? getFindPackageUri(this.symbolIndex, this.workspaceFolder, argText, {
                        fileApiRawSnapshot: this.fileApiRawSnapshot,
                        buildDirectory: this.buildDirectory,
                        command,
                        sourceUri,
                    })
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

    private async resolveBySubject(subject: DefinitionSubject, position: Position): Promise<Location[] | null> {
        switch (subject) {
            case DefinitionSubject.FilePath:
            case DefinitionSubject.IncludeModule:
            case DefinitionSubject.FindPackage:
                return this.tryResolveFileDefinition(position);
            case DefinitionSubject.Test:
            case DefinitionSubject.Property:
                return null;
            default:
                break;
        }

        const bindingResolver = new SymbolBindingResolver(
            this.symbolIndex,
            this.entryFile.toString(),
            this.curFile.toString(),
        );
        const namespace: SymbolNamespace = subject === DefinitionSubject.Command
            ? 'command'
            : subject === DefinitionSubject.Target
                ? 'target'
                : 'variable';
        let occurrence = bindingResolver.findOccurrenceAt(position, namespace);
        if (!occurrence && subject === DefinitionSubject.Variable) {
            occurrence = bindingResolver.findOccurrenceAt(position, 'cache-variable')
                ?? bindingResolver.findOccurrenceAt(position, 'environment-variable');
        }
        if (!occurrence) {
            return null;
        }

        const binding = bindingResolver.resolveDefinitions(occurrence);
        const results = binding.declarations.map(declaration => ({
            uri: declaration.uri,
            range: declaration.range,
        }));
        return results.length > 0 ? results : null;
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

        const results = await this.resolveBySubject(resolvedTarget.subject, params.position);
        this.logger.info(`Returning ${results?.length ?? 0} results for ${resolvedTarget.text}`);
        return results;
    }
}

