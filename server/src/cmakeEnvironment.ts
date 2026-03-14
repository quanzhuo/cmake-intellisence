import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as which from 'which';
import { ProjectTargetInfo } from './completion';
import { FlatCommand } from './flatCommands';
import { execFilePromise } from './processUtils';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { getIncludeFileUri } from './utils';

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

export async function initializeCMakeEnvironment(extSettings: ExtensionSettings, symbolIndex: SymbolIndex): Promise<void> {
    const cmakePath = resolveExecutablePath(extSettings.cmakePath, 'cmake');
    const [version, builtinEntries, pkgConfigModules] = await Promise.all([
        getCMakeVersion(cmakePath),
        getBuiltinEntries(cmakePath),
        getPkgConfigModules(extSettings.pkgConfigPath),
    ]);
    const [modules, policies, variables, properties, commands] = builtinEntries;
    const uri = 'cmake-builtin://system';
    const systemCache = new FileSymbolCache(uri);

    for (const command of commands) {
        systemCache.addCommand(new Symbol(command, SymbolKind.BuiltinCommand, uri, 0, 0));
    }
    for (const variable of expandVariables(variables)) {
        systemCache.addVariable(new Symbol(variable, SymbolKind.BuiltinVariable, uri, 0, 0));
    }
    for (const moduleName of modules) {
        systemCache.addModule(new Symbol(moduleName, SymbolKind.Module, uri, 0, 0));
    }
    for (const policy of policies) {
        systemCache.addPolicy(new Symbol(policy, SymbolKind.Policy, uri, 0, 0));
    }
    for (const property of expandProperties(properties)) {
        systemCache.addProperty(new Symbol(property, SymbolKind.Property, uri, 0, 0));
    }

    symbolIndex.cmakePath = cmakePath;
    symbolIndex.cmakeVersion = version[0];
    symbolIndex.pkgConfigPath = extSettings.pkgConfigPath;
    symbolIndex.pkgConfigModules = pkgConfigModules;
    symbolIndex.cmakeModulePath = await getCMakeModulePath(cmakePath, version[1], version[2]);
    symbolIndex.setSystemCache(systemCache);
}

function resolveExecutablePath(executable: string, label: string): string {
    const absPath: string | null = which.sync(executable, { nothrow: true });
    if (absPath === null) {
        throw new Error(`${label} not found: ${executable}`);
    }
    return absPath;
}

function expandVariables(variables: Set<string>): Set<string> {
    const expandedVariables = new Set<string>();
    const languages = ['C', 'CXX'];
    const buildTypes = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];

    const countLeftAngle = (str: string): number => (str.match(/</g)?.length ?? 0);

    for (const variable of variables) {
        const angleCount = countLeftAngle(variable);

        if (angleCount === 0) {
            expandedVariables.add(variable);
        } else if (angleCount === 1) {
            if (variable.includes('<LANG>')) {
                for (const lang of languages) {
                    expandedVariables.add(variable.replace('<LANG>', lang));
                }
            } else if (variable.includes('<CONFIG>')) {
                for (const buildType of buildTypes) {
                    expandedVariables.add(variable.replace('<CONFIG>', buildType));
                }
            } else {
                // FIXME: <PROJECT-NAME> <PackageName> <FETAURE> <n> <NNNN> <an-attribute>
                // 这些情况暂不处理
                expandedVariables.add(variable);
            }
        } else if (angleCount === 2) {
            if (variable.includes('<LANG>') && variable.includes('<CONFIG>')) {
                for (const lang of languages) {
                    for (const buildType of buildTypes) {
                        expandedVariables.add(variable.replace('<LANG>', lang).replace('<CONFIG>', buildType));
                    }
                }
            } else {
                // FIXME: 其他包含两个尖括号的变量，暂不处理
                // 1. <LANG> 和 <FEATURE>
                // 2. <LANG> 和 <TYPE>
                expandedVariables.add(variable);
            }
        } else {
            // 包含三个或以上尖括号的变量，暂不处理
            expandedVariables.add(variable);
        }
    }
    return expandedVariables;
}

function expandProperties(properties: Set<string>): Set<string> {
    const expandedProperties = new Set<string>();
    const languages = ['C', 'CXX'];
    const buildTypes = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];
    const countLeftAngle = (str: string): number => (str.match(/</g)?.length ?? 0);
    for (const property of properties) {
        const angleCount = countLeftAngle(property);
        if (angleCount === 0) {
            expandedProperties.add(property);
        } else if (angleCount === 1) {
            if (property.includes('<LANG>')) {
                for (const lang of languages) {
                    expandedProperties.add(property.replace('<LANG>', lang));
                }
            } else if (property.includes('<CONFIG>')) {
                for (const buildType of buildTypes) {
                    expandedProperties.add(property.replace('<CONFIG>', buildType));
                }
            } else {
                // FIXME: <NAME> <LIBRARY> <tagname> <refname> <variable> <section> <tool> <an-attribute>
                expandedProperties.add(property);
            }
        } else {
            // FIXME: <tagname> 和 <refname> 可能会出现在同一个属性中，暂不处理
            expandedProperties.add(property);
        }
    }
    return expandedProperties;
}

async function getCMakeModulePath(cmakePath: string, major: number, minor: number): Promise<string | undefined> {
    const cmakeRoot = await getCMakeRoot(cmakePath, major, minor);
    return cmakeRoot ? path.join(cmakeRoot, 'Modules') : undefined;
}

async function getCMakeRoot(cmakePath: string, major: number, minor: number): Promise<string | null> {
    try {
        const { stdout } = await execFilePromise(cmakePath, ['--system-information'], { cwd: os.tmpdir() });
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
        if (process.platform === 'win32') {
            for (const dir of ['cmake', `cmake-${major}.${minor}`]) {
                const cmakeRoot = path.join(path.dirname(cmakePath), '..', 'share', dir);
                if (fs.existsSync(cmakeRoot)) {
                    return path.normalize(cmakeRoot);
                }
            }
        } else {
            throw error;
        }
    }
    return null;
}

async function getCMakeVersion(cmakePath: string): Promise<[string, number, number, number]> {
    const { stdout } = await execFilePromise(cmakePath, ['--version']);
    const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
    const res = stdout.match(regexp);
    if (!res) {
        throw new Error(`Failed to parse cmake version from: ${stdout}`);
    }
    return [
        res[0],
        parseInt(res[1]),
        parseInt(res[2]),
        parseInt(res[3])
    ];
}

async function getBuiltinEntries(cmakePath: string): Promise<[Set<string>, Set<string>, Set<string>, Set<string>, Set<string>]> {
    const { stdout } = await execFilePromise(cmakePath, ['--help-module-list', '--help-policy-list', '--help-variable-list', '--help-property-list', '--help-command-list']);
    const tmp = stdout.trim().split('\n\n\n');
    return [
        new Set(tmp[0].split('\n')),
        new Set(tmp[1].split('\n')),
        new Set(tmp[2].split('\n')),
        new Set(tmp[3].split('\n')),
        new Set(tmp[4].split('\n')),
    ];
}

async function getPkgConfigModules(pkgConfigPath: string): Promise<Map<string, string>> {
    const modules = new Map<string, string>();
    const pkgConfig = which.sync(pkgConfigPath, { nothrow: true });
    if (pkgConfig === null) {
        return modules;
    }

    const { stdout } = await execFilePromise(pkgConfig, ['--list-all']);
    if (stdout.trim().length === 0) {
        return modules;
    }

    for (const line of stdout.split('\n')) {
        const firstSpace = line.indexOf(' ');
        if (firstSpace <= 0) {
            continue;
        }
        const pkgName = line.substring(0, firstSpace);
        const description = line.substring(firstSpace).trimStart();
        modules.set(pkgName, description);
    }
    return modules;
}

export class ProjectTargetInfoListener {
    targetInfo: ProjectTargetInfo;

    constructor(
        private symbolIndex: SymbolIndex,
        private currentCMake: string,
        private baseDirectory: string,
        private loadFlatCommands: (uri: string) => Promise<FlatCommand[]>,
        private parsedFiles: Set<string>,
        private workspaceFolder: string,
        targetInfo?: ProjectTargetInfo,
    ) {
        this.targetInfo = targetInfo ?? {} as ProjectTargetInfo;
    }

    private addExecutable(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            this.targetInfo.executables = this.targetInfo.executables ?? new Set<string>();
            this.targetInfo.executables.add(args[0].getText());
        }
    }

    private addLibrary(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            this.targetInfo.libraries = this.targetInfo.libraries ?? new Set<string>();
            this.targetInfo.libraries.add(args[0].getText());
        }
    }

    private async findConfigPackage(packageName: string): Promise<string | null> {
        const cmakeCacheFile = path.join(this.workspaceFolder, 'build', 'CMakeCache.txt');
        try {
            const cacheStats = await fs.promises.stat(cmakeCacheFile);
            if (!cacheStats.isFile()) {
                return null;
            }
        } catch {
            return null;
        }

        const content = await fs.promises.readFile(cmakeCacheFile, 'utf-8');
        const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escapedName}_DIR:PATH=(.*)$`, 'm');
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
            try {
                const stats = await fs.promises.stat(pkgConfig);
                if (!stats.isFile()) {
                    continue;
                }
                return pkgConfig;
            } catch {
                continue;
            }
        }
        return null;
    }

    private async findPackage(ctx: FlatCommand): Promise<void> {
        const args = ctx.argument_list();
        if (args.length <= 0) {
            return;
        }

        const packageName = args[0].getText();
        let targetCMakeFile: string | null = path.join(this.symbolIndex.cmakeModulePath ?? '', `Find${packageName}.cmake`);
        if (!fs.existsSync(targetCMakeFile)) {
            targetCMakeFile = await this.findConfigPackage(packageName);
            if (!targetCMakeFile) {
                return;
            }
        }

        targetCMakeFile = URI.file(targetCMakeFile).toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = await this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo);
        await targetInfoListener.processCommands(commands);
    }

    private async include(ctx: FlatCommand): Promise<void> {
        const args = ctx.argument_list();
        if (args.length !== 1) {
            return;
        }
        const includeFile = args[0].getText();
        const includeUri = getIncludeFileUri(this.symbolIndex, URI.file(this.baseDirectory), includeFile);
        if (!includeUri) {
            return;
        }

        const targetCMakeFile = includeUri.toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = await this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo);
        await targetInfoListener.processCommands(commands);
    }

    async processCommands(commands: FlatCommand[]): Promise<void> {
        if (this.parsedFiles.has(this.currentCMake)) {
            return;
        }
        this.parsedFiles.add(this.currentCMake);

        for (const cmd of commands) {
            const commandName: string = cmd.commandName.toLowerCase();
            switch (commandName) {
                case 'add_executable':
                    this.addExecutable(cmd);
                    break;
                case 'add_library':
                    this.addLibrary(cmd);
                    break;
                case 'find_package':
                    await this.findPackage(cmd);
                    break;
                case 'include':
                    await this.include(cmd);
                    break;
                default:
                    break;
            }
        }
    }
}