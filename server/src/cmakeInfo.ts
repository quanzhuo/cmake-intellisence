import { ParseTreeWalker } from 'antlr4';
import * as cp from 'child_process';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Connection, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { ProjectInfo } from './completion';
import * as cmsp from './generated/CMakeSimpleParser';
import CMakeSimpleParserListener from './generated/CMakeSimpleParserListener';
import { getFileContent, getSimpleFileContext } from './utils';
import * as which from 'which';

type Modules = string[];
type Policies = string[];
type Variables = string[];
type Properties = string[];
type Commands = string[];

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

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
    public pkgConfigModules: Map<string, string> = new Map<string, string>();
    public cmakePath: string;
    public cmakeModulePath: string;
    public pkgConfigPath: string;
    private connection: Connection;

    constructor(extSettings: ExtensionSettings, connection: Connection,) {
        this.cmakePath = extSettings.cmakePath;
        this.pkgConfigPath = extSettings.pkgConfigPath;
        this.connection = connection;
    }

    public async init() {
        const absPath: string | null = which.sync(this.cmakePath, { nothrow: true });
        if (absPath === null) {
            this.connection.window.showInformationMessage(`CMakeInfo.init, cmake not found: ${this.cmakePath}`);
            return;
        } else {
            this.cmakePath = absPath;
        }

        [
            [this.version, this.major, this.minor, this.patch],
            [this.modules, this.policies, this.variables, this.properties, this.commands]
        ] = await Promise.all([this.getCMakeVersion(), this.getBuiltinEntries()]);

        this.properties = [...new Set(this.variables)];

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
        this.variables = [...new Set(this.variables)];

        try {
            const cmakeRoot = await this.getCMakeRoot();
            if (cmakeRoot) {
                this.cmakeModulePath = path.join(cmakeRoot, 'Modules');
            } else {
                this.connection.window.showInformationMessage("CMake system module path not found.");
            }
        } catch (error) {
            this.connection.window.showInformationMessage(`CMakeInfo.init, error: ${error}`);
        }

        await this.initPkgConfigModules();
    }

    private async getCMakeRoot(): Promise<string | null> {
        const command = `"${this.cmakePath}" --system-information`;
        try {
            const { stdout } = await promisify(cp.exec)(command, { cwd: process.cwd() });
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.startsWith('CMAKE_ROOT')) {
                    const startQuote = line.indexOf('"');
                    const endQuote = line.lastIndexOf('"');
                    if (startQuote !== -1 && endQuote !== -1 && startQuote < endQuote) {
                        return line.substring(startQuote + 1, endQuote);
                    }
                    return null;
                }
            }
        } catch (error) {
            this.connection.window.showInformationMessage(`Error retrieving CMAKE_ROOT: ${error}`);
        }
        return null;
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

    private async initPkgConfigModules(): Promise<void> {
        const pkgConfig = which.sync(this.pkgConfigPath, { nothrow: true });
        if (pkgConfig === null) {
            return;
        }

        const command = `"${pkgConfig}" --list-all`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        if (stdout.trim().length === 0) {
            return;
        }
        const lines = stdout.split('\n');
        for (const line of lines) {
            const firstSpace = line.indexOf(' ');
            const pkgName = line.substring(0, firstSpace);
            const description = line.substring(firstSpace).trimStart();
            this.pkgConfigModules.set(pkgName, description);
        }
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
        private workspaceFolder: string,
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

    private findConfigPackage(packageName: string): string | null {
        const cmakeCacheFile = path.join(this.workspaceFolder, 'build', 'CMakeCache.txt');
        if (!fs.existsSync(cmakeCacheFile)) {
            return null;
        }
        const content = fs.readFileSync(cmakeCacheFile, 'utf-8');
        const regex = new RegExp(`^${packageName}_DIR:PATH=(.*)$`, 'm');
        const match = content.match(regex);
        const packageDir = match ? match[1] : null;
        if (!packageDir) {
            return null;
        }
        const alternatives = [
            path.join(packageDir, 'lib', 'cmake', packageName, `${packageName}Config.cmake`),
            path.join(packageDir, 'lib', 'cmake', packageName, `${packageName.toLowerCase()}-config.cmake`),
            path.join(packageDir, `${packageName}Config.cmake`),
            path.join(packageDir, `${packageName.toLowerCase()}-config.cmake`),
        ];

        for (const pkgConfig of alternatives) {
            if (fs.existsSync(pkgConfig)) {
                return pkgConfig;
            }
        }
        return null;
    }

    private findPackage(ctx: cmsp.CommandContext): void {
        const args = ctx.argument_list();
        if (args.length <= 0) {
            return;
        }

        const packageName = args[0].getText();
        // CMake builtin modules
        let targetCMakeFile = path.join(this.cmakeInfo.cmakeModulePath, `Find${packageName}.cmake`);
        if (!fs.existsSync(targetCMakeFile)) {
            targetCMakeFile = this.findConfigPackage(packageName);
            if (!targetCMakeFile) {
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
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.simpleFileContexts, this.documents, this.parsedFiles, this.workspaceFolder);
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
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.simpleFileContexts, this.documents, this.parsedFiles, this.workspaceFolder);
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