import * as fs from 'fs';
import * as path from 'path';
import { DocumentLink, Range } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { DefinitionSubject, resolveArgumentTarget } from './argumentSemantics';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import { SymbolIndex } from './symbolIndex';

export class DocumentLinkInfo {
    private _links: DocumentLink[] = [];
    private readonly fileExistsCache: Map<string, Promise<boolean>> = new Map();

    private constructor(
        public commands: FlatCommand[],
        /**
         * The uri of the current document
         */
        public uri: string,
        public symbolIndex: SymbolIndex,
    ) { }

    public static async create(commands: FlatCommand[], uri: string, symbolIndex: SymbolIndex): Promise<DocumentLinkInfo> {
        const info = new DocumentLinkInfo(commands, uri, symbolIndex);
        await info.findLinks();
        return info;
    }

    private async findLinks(): Promise<void> {
        const argCtxList: ArgumentContext[] = [];
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
                    argCtxList.push(...this.getSemanticFileArguments(cmd));
            }

            this._links.push(...links);
        }
        this._links.push(...await this.getLinksFromArguments(argCtxList, this.uri));
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

    private async getLinksFromArguments(args: ArgumentContext[], uri: string): Promise<DocumentLink[]> {
        const vscodeUri = URI.parse(uri);
        const folder = path.dirname(vscodeUri.fsPath);
        const links: DocumentLink[] = [];
        for (const argCtx of args) {
            if (!argCtx.stop) {
                continue;
            }

            const source = argCtx.getText();
            const filePath = path.join(folder, source);
            if (!await this.fileExists(filePath)) {
                continue;
            }

            links.push({
                range: Range.create(argCtx.start.line - 1, argCtx.start.column, argCtx.stop!.line - 1, argCtx.stop!.column + source.length),
                target: URI.file(filePath).toString(),
                tooltip: filePath,
            });
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

        const source = resolved.text;
        const vscodeUri = URI.parse(this.uri);
        const folder = path.dirname(vscodeUri.fsPath);

        // The argument is always a directory; resolve CMakeLists.txt inside it.
        const targetFsPath = path.join(folder, source, 'CMakeLists.txt');

        if (!await this.fileExists(targetFsPath)) {
            return [];
        }

        return [{
            range: Range.create(
                firstArg.start.line - 1, firstArg.start.column,
                firstArg.stop.line - 1, firstArg.stop.column + source.length
            ),
            target: URI.file(targetFsPath).toString(),
            tooltip: targetFsPath,
        }];
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

        if (resolved.subject === DefinitionSubject.IncludeModule && this.symbolIndex.getSystemCache().modules.has(resolved.text)) {
            return this.includeSystemModule(firstArg);
        }

        return resolved.subject === DefinitionSubject.FilePath
            ? this.getLinksFromArguments([firstArg], this.uri)
            : [];
    }

    private findPackage(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return Promise.resolve([]);
        }

        const firstArg: ArgumentContext = args[0];
        const resolved = resolveArgumentTarget(cmd, 0);
        if (!resolved || resolved.subject !== DefinitionSubject.FindPackage) {
            return Promise.resolve([]);
        }

        return this.builtinModule(firstArg, `Find${resolved.text}.cmake`);
    }

    private configureFile(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = cmd.argument_list();
        if (args.length < 2) {
            return Promise.resolve([]);
        }

        return this.getLinksFromArguments(this.getSemanticFileArguments(cmd).slice(0, 2), this.uri);
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

    private getSemanticFileArguments(cmd: FlatCommand): ArgumentContext[] {
        return cmd.argument_list().filter((argCtx: ArgumentContext, index: number) => {
            const resolved = resolveArgumentTarget(cmd, index);
            return resolved?.subject === DefinitionSubject.FilePath;
        });
    }

    private addSourceFiles(cmd: FlatCommand): Promise<DocumentLink[]> {
        const args = this.getSemanticFileArguments(cmd);
        if (args.length === 0) {
            return Promise.resolve([]);
        }

        return this.getLinksFromArguments(args, this.uri);
    }

    get links(): DocumentLink[] {
        return this._links;
    }
}
