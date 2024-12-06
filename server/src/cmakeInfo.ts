import * as cp from 'child_process';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Connection, TextDocuments } from 'vscode-languageserver';
import { ProjectInfo } from './completion';
import * as cmsp from './generated/CMakeSimpleParser';
import CMakeSimpleParserListener from './generated/CMakeSimpleParserListener';
import which = require('which');
import { getFileContent, getSimpleFileContext } from './utils';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { ParseTreeWalker } from 'antlr4';

type Modules = string[];
type Policies = string[];
type Variables = string[];
type Properties = string[];
type Commands = string[];

export class CMakeInfo {
    public version: string;
    public major: number;
    public minor: number;
    public patch: number;
    public modules: string[] = [];
    public policies: string[] = [];
    public variables: string[] = [];
    public properties: string[] = [];
    public commands: string[] = [];

    constructor(
        public cmakePath: string,
        public cmakeModulePath: string,
        private connection: Connection,
    ) { }

    public async init() {
        const absPath: string | null = which.sync(this.cmakePath, { nothrow: true });
        if (absPath === null) {
            this.connection.window.showInformationMessage(`CMakeInfo.init, cmake not found: ${this.cmakePath}`);
            return;
        } else {
            this.cmakePath = absPath;
        }

        // if this.cmakePath is a symlink, resolve it
        this.cmakePath = await fsp.realpath(this.cmakePath);
        [
            [this.version, this.major, this.minor, this.patch],
            [this.modules, this.policies, this.variables, this.properties, this.commands]
        ] = await Promise.all([this.getCMakeVersion(), this.getBuiltinEntries()]);

        const langVariables: string[] = [];
        const languages = ['C', 'CXX'];
        for (const variable of this.variables) {
            if (variable.includes('<LANG>')) {
                for (const lang of languages) {
                    langVariables.push(variable.replace('<LANG>', lang));
                }
            } else {
                langVariables.push(variable);
            }
        }
        this.variables = langVariables;

        if (!fs.existsSync(this.cmakeModulePath)) {
            try {
                for (const dir of ['cmake', `cmake-${this.major}.${this.minor}`]) {
                    const module = path.join(path.dirname(this.cmakePath), '..', 'share', dir, 'Modules');
                    console.log(`module: ${module}`);
                    if (fs.existsSync(path.join(module, 'FindQt.cmake'))) {
                        this.cmakeModulePath = path.normalize(module);
                        break;
                    }
                }

                if (!fs.existsSync(this.cmakeModulePath)) {
                    this.connection.window.showInformationMessage("CMake system module path not found.");
                }
            } catch (error) {
                this.connection.window.showInformationMessage(`CMakeInfo.init, error: ${error}`);
            }
        }
    }

    private async getCMakeVersion(): Promise<[string, number, number, number]> {
        const command = `"${this.cmakePath}" --version`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
        const res = stdout.match(regexp);
        return [
            res[0],
            parseInt(res[1]),
            parseInt(res[2]),
            parseInt(res[3])
        ];
    }

    private async getBuiltinEntries(): Promise<[Modules, Policies, Variables, Properties, Commands]> {
        const command = `"${this.cmakePath}" --help-module-list --help-policy-list --help-variable-list --help-property-list --help-command-list`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const tmp = stdout.trim().split('\n\n\n');
        return [
            tmp[0].split('\n'),
            tmp[1].split('\n'),
            tmp[2].split('\n'),
            tmp[3].split('\n'),
            tmp[4].split('\n'),
        ];
    }
}

export class ProjectInfoListener extends CMakeSimpleParserListener {
    private commands: Set<string>;
    constructor(
        private cmakeInfo: CMakeInfo,
        private currentCMake: string,
        private baseDirectory: string,
        private simpleFileContexts: Map<string, cmsp.FileContext>,
        private documents: TextDocuments<TextDocument>,
        private parsedFiles: Set<string>,
    ) {
        super();
        this.commands = new Set<string>(this.cmakeInfo.commands);
    }

    static projectInfo: ProjectInfo = {};

    private project(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.projectName = args[0].getText();
        }
    }

    private addExecutable(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.executables = ProjectInfoListener.projectInfo.executables ?? new Set<string>();
            ProjectInfoListener.projectInfo.executables.add(args[0].getText());
        }
    }

    private addLibrary(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.libraries = ProjectInfoListener.projectInfo.libraries ?? new Set<string>();
            ProjectInfoListener.projectInfo.libraries.add(args[0].getText());
        }
    }

    private findPackage(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length < 0) {
            return;
        }

        const packageName = args[0].getText();
        // CMake builtin modules
        let targetCMakeFile = path.join(this.cmakeInfo.cmakeModulePath, `Find${packageName}.cmake`);
        if (!fs.existsSync(targetCMakeFile)) {
            return;
        }

        targetCMakeFile = URI.file(targetCMakeFile).toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        let tree: cmsp.FileContext;
        if (this.simpleFileContexts.has(targetCMakeFile)) {
            tree = this.simpleFileContexts.get(targetCMakeFile);
        } else {
            tree = getSimpleFileContext(getFileContent(this.documents, URI.parse(targetCMakeFile)));
            this.simpleFileContexts.set(targetCMakeFile, tree);
        }
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.simpleFileContexts, this.documents, this.parsedFiles);
        ParseTreeWalker.DEFAULT.walk(projectInfoListener, tree);
    }

    private include(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length !== 1) {
            return;
        }
        const includeFile = args[0].getText();
        let targetCMakeFile = path.join(this.baseDirectory, includeFile);
        if (!fs.existsSync(targetCMakeFile)) {
            targetCMakeFile = path.join(this.cmakeInfo.cmakeModulePath, `${includeFile}.cmake`);
            if (!fs.existsSync(targetCMakeFile)) {
                return;
            }
        }

        targetCMakeFile = URI.file(targetCMakeFile).toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        let tree: cmsp.FileContext;
        if (this.simpleFileContexts.has(targetCMakeFile)) {
            tree = this.simpleFileContexts.get(targetCMakeFile);
        } else {
            tree = getSimpleFileContext(getFileContent(this.documents, URI.parse(targetCMakeFile)));
            this.simpleFileContexts.set(targetCMakeFile, tree);
        }
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.simpleFileContexts, this.documents, this.parsedFiles);
        ParseTreeWalker.DEFAULT.walk(projectInfoListener, tree);
    }

    private functionOrMacro(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.functions = ProjectInfoListener.projectInfo.functions ?? new Set<string>();
            ProjectInfoListener.projectInfo.functions.add(args[0].getText());
        }
    }

    enterCommand?: (ctx: cmsp.CommandContext) => void = (ctx: cmsp.CommandContext) => {
        const commandToken = ctx.start;
        const command: string = commandToken.text.toLowerCase();
        switch (command) {
            case 'project':
                this.project(ctx);
                break;
            case 'add_executable':
                this.addExecutable(ctx);
                break;
            case 'add_library':
                this.addLibrary(ctx);
                break;
            case 'find_package':
                this.findPackage(ctx);
                break;
            case 'include':
                this.include(ctx);
                break;
            case 'function':
            case 'macro':
                this.functionOrMacro(ctx);
                break;
            default:
                break;
        }
    };
}