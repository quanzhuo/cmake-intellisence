import * as fs from 'fs';
import * as path from 'path';
import { DocumentLink, Range } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { DefinitionSubject, resolveArgumentTarget } from './argumentSemantics';
import { FileApiRawSnapshot } from './fileApiSnapshot';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import { PathExpressionRequest, PathExpressionResolver } from './pathExpressionResolver';
import { SymbolIndex } from './symbolIndex';
import { getFindPackageUri, getIncludeModuleUri } from './utils';

export class DocumentLinkInfo {
    private _links: DocumentLink[] = [];
    private readonly fileExistsCache: Map<string, Promise<boolean>> = new Map();
    private pathExpressionResolver?: PathExpressionResolver;

    private constructor(
        public commands: FlatCommand[],
        /**
         * The uri of the current document
         */
        public uri: string,
        public symbolIndex: SymbolIndex,
        public entryFile: string,
        public workspaceFolder: string,
        public getFlatCommands: (uri: string) => Promise<FlatCommand[]>,
        public fileApiRawSnapshot?: FileApiRawSnapshot,
    ) { }

    public static async create(
        commands: FlatCommand[],
        uri: string,
        symbolIndex: SymbolIndex,
        entryFile: string,
        workspaceFolder: string,
        getFlatCommands: (uri: string) => Promise<FlatCommand[]>,
        fileApiRawSnapshot?: FileApiRawSnapshot,
    ): Promise<DocumentLinkInfo> {
        const info = new DocumentLinkInfo(commands, uri, symbolIndex, entryFile, workspaceFolder, getFlatCommands, fileApiRawSnapshot);
        await info.findLinks();
        return info;
    }

    private getCurrentDocumentUri(): URI {
        return URI.parse(this.uri);
    }

    private getPathExpressionResolver(): PathExpressionResolver {
        if (!this.pathExpressionResolver) {
            this.pathExpressionResolver = new PathExpressionResolver({
                symbolIndex: this.symbolIndex,
                getFlatCommands: this.getFlatCommands,
                entryFile: URI.parse(this.entryFile),
            });
        }

        return this.pathExpressionResolver;
    }

    private createLink(argCtx: ArgumentContext, targetUri: URI): DocumentLink {
        const argText = argCtx.getText();
        return {
            range: Range.create(argCtx.start.line - 1, argCtx.start.column, argCtx.stop!.line - 1, argCtx.stop!.column + argText.length),
            target: targetUri.toString(),
            tooltip: targetUri.fsPath,
        };
    }

    private async findLinks(): Promise<void> {
        for (const cmd of this.commands) {
            const cmdName = cmd.ID().getText().toLowerCase();
            let links: DocumentLink[] = [];
            switch (cmdName) {
                case "add_executable":
                    links = await this.addExecutable(cmd);
                    break;
                case "add_library":
                    links = await this.addLibrary(cmd);
                    break;
                case "add_subdirectory":
                    links = await this.addSubDirectory(cmd);
                    break;
                case "target_sources":
                    links = await this.targetSources(cmd);
                    break;
                case 'include':
                    links = await this.include(cmd);
                    break;
                case 'find_package':
                    links = await this.findPackage(cmd);
                    break;
                case 'configure_file':
                    links = await this.configureFile(cmd);
                    break;
                default:
                    links = await this.addSemanticFileLinks(cmd);
            }

            this._links.push(...links);
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        const existing = this.fileExistsCache.get(filePath);
        if (existing) {
            return existing;
        }

        const request = fs.promises.stat(filePath)
            .then(stats => !stats.isDirectory())
            .catch(() => false);
        this.fileExistsCache.set(filePath, request);
        return request;
    }

    private createPathExpressionRequest(commandName: string, argText: string, maxLine: number): PathExpressionRequest {
        return {
            commandName,
            argText,
            sourceUri: this.getCurrentDocumentUri(),
            maxLine,
        };
    }

    private async resolveFileArgument(commandName: string, argText: string, maxLine: number): Promise<URI | null> {
        return this.getPathExpressionResolver().resolveFileRequest(this.createPathExpressionRequest(commandName, argText, maxLine));
    }

    private async resolveSubdirectoryTarget(commandName: string, argText: string, maxLine: number): Promise<URI | null> {
        const currentUri = this.getCurrentDocumentUri();
        const expanded = await this.getPathExpressionResolver().expandPathExpression(this.createPathExpressionRequest(commandName, argText, maxLine));
        if (!expanded) {
            return null;
        }

        const cmakeLists = path.isAbsolute(expanded)
            ? URI.file(path.join(path.normalize(expanded), 'CMakeLists.txt'))
            : URI.file(path.resolve(path.dirname(currentUri.fsPath), expanded, 'CMakeLists.txt'));

        if (!await this.fileExists(cmakeLists.fsPath)) {
            return null;
        }

        return cmakeLists;
    }

    private async addSemanticFileLinks(cmd: FlatCommand, argIndices?: number[]): Promise<DocumentLink[]> {
        const links: DocumentLink[] = [];
        const args = cmd.argument_list();
        const targetIndices = argIndices
            ?? args.flatMap((_, index) => {
                const resolved = resolveArgumentTarget(cmd, index);
                return resolved?.subject === DefinitionSubject.FilePath ? [index] : [];
            });

        for (const index of targetIndices) {
            const argCtx = args[index];
            if (!argCtx.stop) {
                continue;
            }

            const resolved = resolveArgumentTarget(cmd, index);
            if (!resolved || resolved.subject !== DefinitionSubject.FilePath) {
                continue;
            }

            const targetUri = await this.resolveFileArgument(cmd.commandName.toLowerCase(), resolved.text, argCtx.start.line - 1);
            if (!targetUri) {
                continue;
            }

            links.push(this.createLink(argCtx, targetUri));
        }

        return links;
    }

    private addExecutable(cmd: FlatCommand): Promise<DocumentLink[]> {
        return this.addSourceFiles(cmd);
    }

    private addLibrary(cmd: FlatCommand): Promise<DocumentLink[]> {
        return this.addSourceFiles(cmd);
    }

    private targetSources(cmd: FlatCommand): Promise<DocumentLink[]> {
        return this.addSourceFiles(cmd);
    }

    private async addSubDirectory(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        // Only the first argument is source_dir; the rest are binary_dir or
        // keywords (EXCLUDE_FROM_ALL, SYSTEM) and should not become links.
        const firstArg = args[0];
        const resolved = resolveArgumentTarget(cmd, 0);
        if (!resolved || resolved.subject !== DefinitionSubject.FilePath) {
            return [];
        }
        if (!firstArg.stop) {
            return [];
        }

        const targetUri = await this.resolveSubdirectoryTarget(cmd.commandName.toLowerCase(), resolved.text, firstArg.start.line - 1);
        if (!targetUri) {
            return [];
        }

        return [this.createLink(firstArg, targetUri)];
    }

    private async include(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const firstArg: ArgumentContext = args[0];
        const resolved = resolveArgumentTarget(cmd, 0);
        if (!resolved) {
            return [];
        }

        if (resolved.subject === DefinitionSubject.IncludeModule) {
            if (this.symbolIndex.getSystemCache().modules.has(resolved.text)) {
                return this.includeSystemModule(firstArg);
            }

            const targetUri = getIncludeModuleUri(this.symbolIndex, resolved.text, this.fileApiRawSnapshot);
            return targetUri ? [this.createLink(firstArg, targetUri)] : [];
        }

        return resolved.subject === DefinitionSubject.FilePath
            ? this.addSemanticFileLinks(cmd, [0])
            : [];
    }

    private async findPackage(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const firstArg: ArgumentContext = args[0];
        const resolved = resolveArgumentTarget(cmd, 0);
        if (!resolved || resolved.subject !== DefinitionSubject.FindPackage) {
            return [];
        }

        const targetUri = await getFindPackageUri(this.symbolIndex, this.workspaceFolder, resolved.text, this.fileApiRawSnapshot);
        return targetUri ? [this.createLink(firstArg, targetUri)] : [];
    }

    private configureFile(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 2) {
            return Promise.resolve([]);
        }

        return this.addSemanticFileLinks(cmd, [0, 1]);
    }

    private includeSystemModule(arg: ArgumentContext): Promise<DocumentLink[]> {
        const argName = arg.getText();
        return this.builtinModule(arg, `${argName}.cmake`);
    }

    private async builtinModule(arg: ArgumentContext, moduleName: string): Promise<DocumentLink[]> {
        if (!arg.stop) {
            return [];
        }
        const argName = arg.getText();
        if (!this.symbolIndex.cmakeModulePath) {
            return [];
        }

        const modulePath = path.join(this.symbolIndex.cmakeModulePath, moduleName);
        if (await this.fileExists(modulePath)) {
            return [{
                range: Range.create(arg.start.line - 1, arg.start.column, arg.stop.line - 1, arg.stop.column + argName.length),
                target: URI.file(modulePath).toString(),
                tooltip: modulePath,
            }];
        } else {
            return [];
        }
    }

    private addSourceFiles(cmd: FlatCommand): Promise<DocumentLink[]> {
        return this.addSemanticFileLinks(cmd);
    }

    get links(): DocumentLink[] {
        return this._links;
    }
}
