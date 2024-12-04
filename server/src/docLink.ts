import * as fs from 'fs';
import * as path from 'path';
import { DocumentLink, Range } from "vscode-languageserver";
import { URI } from 'vscode-uri';
import { CMakeInfo } from './cmakeInfo';
import * as cmsp from "./generated/CMakeSimpleParser";

export class DocumentLinkInfo {
    private _links: DocumentLink[] = [];
    constructor(
        public simpleFileContext: cmsp.FileContext,
        /**
         * The uri of the current document
         */
        public uri: string,
        public cmakeInfo: CMakeInfo,
    ) {
        this.findLinks();
    }

    private findLinks() {
        const commandLists = this.simpleFileContext.command_list();
        const argCtxList: cmsp.ArgumentContext[] = [];
        for (const cmd of commandLists) {
            const cmdName = cmd.ID().getText();
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
                case 'configure_file':
                    links = this.configureFile(cmd);
                    break;
                default:
                    argCtxList.push(...cmd.argument_list().filter((argCtx: cmsp.ArgumentContext) => {
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

    private getLinksFromArguments(args: cmsp.ArgumentContext[], uri: string): DocumentLink[] {
        const vscodeUri = URI.parse(uri);
        const folder = path.dirname(vscodeUri.fsPath);
        return args.filter((argCtx: cmsp.ArgumentContext) => {
            const source = argCtx.getText();
            const filePath = path.join(folder, source);
            return fs.existsSync(filePath);
        }).map((argCtx: cmsp.ArgumentContext) => {
            const source = argCtx.getText();
            const filePath = path.join(folder, source);
            return {
                range: Range.create(argCtx.start.line - 1, argCtx.start.column, argCtx.stop.line - 1, argCtx.stop.column + source.length),
                target: URI.file(filePath).toString(),
                tooltip: filePath,
            };
        });
    }

    private addExecutable(cmd: cmsp.CommandContext): DocumentLink[] {
        return this.addSourceFiles(cmd, ["WIN32", "MACOSX_BUNDLE", "EXCLUDE_FROM_ALL", "IMPORTED", "ALIAS"]);
    }

    private addLibrary(cmd: cmsp.CommandContext): DocumentLink[] {
        return this.addSourceFiles(cmd, ["STATIC", "SHARED", "MODULE", "OBJECT", "ALIAS", "GLOBAL", "INTERFACE", "IMPORTED"]);
    }

    private targetSources(cmd: cmsp.CommandContext): DocumentLink[] {
        return this.addSourceFiles(cmd, ["INTERFACE", "PUBLIC", "PRIVATE", "FILE_SET", "TYPE", "BASE_DIRS", "FILES"]);
    }

    private addSubDirectory(cmd: cmsp.CommandContext): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const links = this.getLinksFromArguments(args, this.uri);
        links.forEach(link => {
            const targetPath = path.join(URI.parse(link.target).fsPath, 'CMakeLists.txt');
            link.target = URI.file(targetPath).toString();
        });
        return links;
    }

    private include(cmd: cmsp.CommandContext): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 1) {
            return [];
        }

        const firstArg: cmsp.ArgumentContext = args[0];
        const argName = firstArg.getText();
        if (this.cmakeInfo.modules.includes(argName)) {
            return this.includeSystemModule(firstArg);
        }

        return this.getLinksFromArguments([firstArg], this.uri);
    }

    private configureFile(cmd: cmsp.CommandContext): DocumentLink[] {
        const args = cmd.argument_list();
        if (args.length < 2) {
            return [];
        }

        return this.getLinksFromArguments(args.slice(0, 2), this.uri);
    }

    private includeSystemModule(arg: cmsp.ArgumentContext): DocumentLink[] {
        const moduleName = arg.getText();
        if (!this.cmakeInfo.cmakeModulePath) {
            return [];
        }

        const modulePath = path.join(this.cmakeInfo.cmakeModulePath, `${moduleName}.cmake`);
        if (fs.existsSync(modulePath)) {
            return [{
                range: Range.create(arg.start.line - 1, arg.start.column, arg.stop.line - 1, arg.stop.column + moduleName.length),
                target: URI.file(modulePath).toString(),
                tooltip: modulePath,
            }];
        } else {

            return [];
        }
    }

    private addSourceFiles(cmd: cmsp.CommandContext, keywords: string[]): DocumentLink[] {
        let args: cmsp.ArgumentContext[] = cmd.argument_list();
        if (args.length <= 1) {
            return [];
        }

        // The first argument is the target name, ignore it
        args = args.slice(1).filter((argCtx: cmsp.ArgumentContext) => {
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
