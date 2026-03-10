import * as fs from 'fs';
import * as path from 'path';
import { DocumentLink, Range } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import { SymbolIndex } from './symbolIndex';

export class DocumentLinkInfo {
    private _links: DocumentLink[] = [];
    constructor(
        public commands: FlatCommand[],
        /**
         * The uri of the current document
         */
        public uri: string,
        public symbolIndex: SymbolIndex,
    ) {
        this.findLinks();
    }

    private findLinks() {
        const argCtxList: ArgumentContext[] = [];
        for (const cmd of this.commands) {
            const cmdName = cmd.ID().getText().toLowerCase();
            let links: DocumentLink[] = [];
            switch (cmdName) {
                case "add_executable":
                    links = this.addExecutable(cmd);
                    break;
                case "add_library":
                    links = this.addLibrary(cmd);
                    break;
                case "add_subdirectory":
                    links = this.addSubDirectory(cmd);
                    break;
                case "target_sources":
                    links = this.targetSources(cmd);
                    break;
                case 'include':
                    links = this.include(cmd);
                    break;
                case 'find_package':
                    links = this.findPackage(cmd);
                    break;
                case 'configure_file':
                    links = this.configureFile(cmd);
                    break;
                default:
                    argCtxList.push(...cmd.argument_list().filter((argCtx: ArgumentContext) => {
                        const argText = argCtx.getText();
                        return argCtx.getChildCount() === 1 &&
                            (argText.endsWith('.cpp') ||
                                argText.endsWith('.c') ||
                                argText.endsWith('.h') ||
                                argText.endsWith('.hpp') ||
                                argText.endsWith('.cxx'));
                    }));

            }

            this._links.push(...links);
        }
        this._links.push(...this.getLinksFromArguments(argCtxList, this.uri));
    }

    private getLinksFromArguments(args: ArgumentContext[], uri: string): DocumentLink[] {
        const vscodeUri = URI.parse(uri);
        const folder = path.dirname(vscodeUri.fsPath);
        return args.filter((argCtx: ArgumentContext) => {
            const source = argCtx.getText();
            const filePath = path.join(folder, source);
            return fs.existsSync(filePath);
        }).map((argCtx: ArgumentContext) => {
            if (!argCtx.stop) {
                throw new Error('Argument context stop token is missing.');
            }
            const source = argCtx.getText();
            const filePath = path.join(folder, source);
            return {
                range: Range.create(argCtx.start.line - 1, argCtx.start.column, argCtx.stop.line - 1, argCtx.stop.column + source.length),
                target: URI.file(filePath).toString(),
                tooltip: filePath,
            };
        });
    }

    private addExecutable(cmd: FlatCommand): DocumentLink[] {
        return this.addSourceFiles(cmd, ["WIN32", "MACOSX_BUNDLE", "EXCLUDE_FROM_ALL", "IMPORTED", "ALIAS"]);
    }

    private addLibrary(cmd: FlatCommand): DocumentLink[] {
        return this.addSourceFiles(cmd, ["STATIC", "SHARED", "MODULE", "OBJECT", "ALIAS", "GLOBAL", "INTERFACE", "IMPORTED"]);
    }

    private targetSources(cmd: FlatCommand): DocumentLink[] {
        return this.addSourceFiles(cmd, ["INTERFACE", "PUBLIC", "PRIVATE", "FILE_SET", "TYPE", "BASE_DIRS", "FILES"]);
    }

    private addSubDirectory(cmd: FlatCommand): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const links = this.getLinksFromArguments(args, this.uri);
        links.forEach(link => {
            const targetPath = path.join(URI.parse(link.target ?? '').fsPath, 'CMakeLists.txt');
            link.target = URI.file(targetPath).toString();
            link.tooltip = path.join(link.tooltip ?? '', 'CMakeLists.txt');
        });
        return links;
    }

    private include(cmd: FlatCommand): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const firstArg: ArgumentContext = args[0];
        const argName = firstArg.getText();
        if (this.symbolIndex.getSystemCache().modules.has(argName)) {
            return this.includeSystemModule(firstArg);
        }

        return this.getLinksFromArguments([firstArg], this.uri);
    }

    private findPackage(cmd: FlatCommand): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const firstArg: ArgumentContext = args[0];
        const argName = firstArg.getText();
        return this.builtinModule(firstArg, `Find${argName}.cmake`);
    }

    private configureFile(cmd: FlatCommand): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 2) {
            return [];
        }

        return this.getLinksFromArguments(args.slice(0, 2), this.uri);
    }

    private includeSystemModule(arg: ArgumentContext): DocumentLink[] {
        const argName = arg.getText();
        return this.builtinModule(arg, `${argName}.cmake`);
    }

    private builtinModule(arg: ArgumentContext, moduleName: string): DocumentLink[] {
        if (!arg.stop) {
            throw new Error('Argument context stop token is missing.');
        }
        const argName = arg.getText();
        if (!this.symbolIndex.cmakeModulePath) {
            return [];
        }

        const modulePath = path.join(this.symbolIndex.cmakeModulePath, moduleName);
        if (fs.existsSync(modulePath)) {
            return [{
                range: Range.create(arg.start.line - 1, arg.start.column, arg.stop.line - 1, arg.stop.column + argName.length),
                target: URI.file(modulePath).toString(),
                tooltip: modulePath,
            }];
        } else {
            return [];
        }
    }

    private addSourceFiles(cmd: FlatCommand, keywords: string[]): DocumentLink[] {
        let args: ArgumentContext[] = cmd.argument_list();
        if (args.length <= 1) {
            return [];
        }

        // The first argument is the target name, ignore it
        args = args.slice(1).filter((argCtx: ArgumentContext) => {
            const argName = argCtx.getText();
            return keywords.indexOf(argName) === -1;
        });

        if (args.length === 0) {
            return [];
        }

        return this.getLinksFromArguments(args, this.uri);
    }

    get links(): DocumentLink[] {
        return this._links;
    }
}
