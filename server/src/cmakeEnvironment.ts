import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { URI } from 'vscode-uri';
import * as which from 'which';
import { ProjectTargetInfo } from './completion';
import { FlatCommand } from './flatCommands';
import { PathExpressionResolver } from './pathExpressionResolver';
import paths, { mkdir_p } from './paths';
import { execFilePromise } from './processUtils';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { getFindPackageUri, getIncludeFileUri, getIncludeModuleUri } from './utils';

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
    workspaceIgnoreDirectories?: string[];
}

const BUILTIN_ENTRIES_CACHE_VERSION = 1;
const builtinEntriesMemo = new Map<string, Promise<[Set<string>, Set<string>, Set<string>, Set<string>, Set<string>]>>();

type PersistedBuiltinEntries = {
    cacheVersion: number;
    cmakePath: string;
    cmakeExecutableSize: number;
    cmakeExecutableMtimeMs: number;
    modules: string[];
    policies: string[];
    variables: string[];
    properties: string[];
    commands: string[];
};

type CMakeExecutableFingerprint = {
    size: number;
    mtimeMs: number;
};

type BuiltinEntries = [Set<string>, Set<string>, Set<string>, Set<string>, Set<string>];

export type BuiltinEntriesLoadSource = 'memory' | 'disk' | 'cmake';

export interface BuiltinEntriesLoadStats {
    source: BuiltinEntriesLoadSource;
    durationMs: number;
}

type BuiltinEntriesLoadResult = {
    entries: BuiltinEntries;
    stats: BuiltinEntriesLoadStats;
};

export async function initializeCMakeEnvironment(
    extSettings: ExtensionSettings,
    symbolIndex: SymbolIndex,
    onBuiltinEntriesLoaded?: (stats: BuiltinEntriesLoadStats) => void,
): Promise<void> {
    const cmakePath = resolveExecutablePath(extSettings.cmakePath, 'cmake');
    const [version, builtinEntriesResult, pkgConfigModules] = await Promise.all([
        getCMakeVersion(cmakePath),
        getBuiltinEntries(cmakePath),
        getPkgConfigModules(extSettings.pkgConfigPath),
    ]);
    onBuiltinEntriesLoaded?.(builtinEntriesResult.stats);
    const builtinEntries = builtinEntriesResult.entries;
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
    const buildTypes = ['DEBUG', 'RELEASE', 'MINSIZEREL', 'RELWITHDEBINFO'];

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
                // FIXME: <PROJECT-NAME> <PackageName> <FEATURE> <n> <NNNN> <an-attribute>
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
    const buildTypes = ['DEBUG', 'RELEASE', 'MINSIZEREL', 'RELWITHDEBINFO'];
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

function extractCMakeRoot(output: string): string | null {
    const lines = output.split('\n');
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
    return null;
}

async function getCMakeRoot(cmakePath: string, major: number, minor: number): Promise<string | null> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-'));
    try {
        const { stdout } = await execFilePromise(cmakePath, ['--system-information'], { cwd: tmpDir });
        return extractCMakeRoot(stdout);
    } catch (error) {
        // cmake --system-information may exit with a non-zero code (e.g. when compiler
        // detection fails in a container environment) but still write CMAKE_ROOT to stdout.
        const failure = error as { stdout?: string };
        if (failure.stdout) {
            const root = extractCMakeRoot(failure.stdout);
            if (root) {
                return root;
            }
        }

        if (process.platform === 'win32') {
            for (const dir of ['cmake', `cmake-${major}.${minor}`]) {
                const cmakeRoot = path.join(path.dirname(cmakePath), '..', 'share', dir);
                if (fs.existsSync(cmakeRoot)) {
                    return path.normalize(cmakeRoot);
                }
            }
        }
        // Could not determine CMAKE_ROOT; return null so the caller can proceed without it.
        return null;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

async function getBuiltinEntries(cmakePath: string): Promise<BuiltinEntriesLoadResult> {
    const fingerprint = await getCMakeExecutableFingerprint(cmakePath);
    const memoKey = `${cmakePath}\0${fingerprint?.size ?? -1}\0${fingerprint?.mtimeMs ?? -1}`;
    const memoized = builtinEntriesMemo.get(memoKey);
    if (memoized) {
        const startedAt = Date.now();
        const entries = await memoized;
        return {
            entries,
            stats: {
                source: 'memory',
                durationMs: Date.now() - startedAt,
            },
        };
    }

    const request = (async (): Promise<BuiltinEntriesLoadResult> => {
        const startedAt = Date.now();
        const persisted = await readBuiltinEntriesCache(cmakePath);
        if (isPersistedBuiltinEntriesFresh(persisted, cmakePath, fingerprint)) {
            return {
                entries: deserializeBuiltinEntries(persisted),
                stats: {
                    source: 'disk',
                    durationMs: Date.now() - startedAt,
                },
            };
        }

        const fresh = await fetchBuiltinEntriesFromCMake(cmakePath);
        if (fingerprint) {
            await writeBuiltinEntriesCache(cmakePath, fingerprint, fresh);
        }
        return {
            entries: fresh,
            stats: {
                source: 'cmake',
                durationMs: Date.now() - startedAt,
            },
        };
    })();

    const memoRequest = request.then(result => result.entries);
    builtinEntriesMemo.set(memoKey, memoRequest);
    try {
        return await request;
    } catch (error) {
        builtinEntriesMemo.delete(memoKey);
        throw error;
    }
}

function getBuiltinEntriesCacheFilePath(cmakePath: string): string {
    const hash = crypto.createHash('sha256').update(cmakePath).digest('hex').slice(0, 16);
    return path.join(paths.dataDir, 'builtin-help-cache', `${hash}.json`);
}

async function getCMakeExecutableFingerprint(cmakePath: string): Promise<CMakeExecutableFingerprint | null> {
    try {
        const stats = await fs.promises.stat(cmakePath);
        if (!stats.isFile()) {
            return null;
        }
        return {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
        };
    } catch {
        return null;
    }
}

function isPersistedBuiltinEntriesFresh(
    persisted: PersistedBuiltinEntries | null,
    cmakePath: string,
    fingerprint: CMakeExecutableFingerprint | null,
): persisted is PersistedBuiltinEntries {
    return !!persisted
        && persisted.cacheVersion === BUILTIN_ENTRIES_CACHE_VERSION
        && persisted.cmakePath === cmakePath
        && !!fingerprint
        && persisted.cmakeExecutableSize === fingerprint.size
        && persisted.cmakeExecutableMtimeMs === fingerprint.mtimeMs;
}

async function readBuiltinEntriesCache(cmakePath: string): Promise<PersistedBuiltinEntries | null> {
    const filePath = getBuiltinEntriesCacheFilePath(cmakePath);
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as PersistedBuiltinEntries;
        return parsed;
    } catch {
        return null;
    }
}

function deserializeBuiltinEntries(
    persisted: PersistedBuiltinEntries
): BuiltinEntries {
    return [
        new Set(persisted.modules),
        new Set(persisted.policies),
        new Set(persisted.variables),
        new Set(persisted.properties),
        new Set(persisted.commands),
    ];
}

async function writeBuiltinEntriesCache(
    cmakePath: string,
    fingerprint: CMakeExecutableFingerprint,
    entries: BuiltinEntries,
): Promise<void> {
    const filePath = getBuiltinEntriesCacheFilePath(cmakePath);
    const payload: PersistedBuiltinEntries = {
        cacheVersion: BUILTIN_ENTRIES_CACHE_VERSION,
        cmakePath,
        cmakeExecutableSize: fingerprint.size,
        cmakeExecutableMtimeMs: fingerprint.mtimeMs,
        modules: [...entries[0]],
        policies: [...entries[1]],
        variables: [...entries[2]],
        properties: [...entries[3]],
        commands: [...entries[4]],
    };

    let tmpFile: string | undefined;
    try {
        await mkdir_p(path.dirname(filePath));
        tmpFile = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpFile, JSON.stringify(payload), 'utf8');
        await fs.promises.rename(tmpFile, filePath);
    } catch {
        if (tmpFile) {
            await fs.promises.rm(tmpFile, { force: true }).catch(() => undefined);
        }
        // Cache write failures should never block environment initialization.
    }
}

async function fetchBuiltinEntriesFromCMake(cmakePath: string): Promise<BuiltinEntries> {
    const [modules, policies, variables, properties, commands] = await Promise.all([
        execFilePromise(cmakePath, ['--help-module-list']),
        execFilePromise(cmakePath, ['--help-policy-list']),
        execFilePromise(cmakePath, ['--help-variable-list']),
        execFilePromise(cmakePath, ['--help-property-list']),
        execFilePromise(cmakePath, ['--help-command-list']),
    ]);
    const toSet = (stdout: string) => new Set(stdout.trim().split('\n').filter(Boolean));
    return [
        toSet(modules.stdout),
        toSet(policies.stdout),
        toSet(variables.stdout),
        toSet(properties.stdout),
        toSet(commands.stdout),
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
    private pathExpressionResolver?: PathExpressionResolver;

    constructor(
        private symbolIndex: SymbolIndex,
        private currentCMake: string,
        private baseDirectory: string,
        private loadFlatCommands: (uri: string) => Promise<FlatCommand[]>,
        private parsedFiles: Set<string>,
        private workspaceFolder: string,
        targetInfo?: ProjectTargetInfo,
        private entryCMake: string = currentCMake,
    ) {
        this.targetInfo = targetInfo ?? {} as ProjectTargetInfo;
    }

    private getPathExpressionResolver(): PathExpressionResolver {
        if (!this.pathExpressionResolver) {
            this.pathExpressionResolver = new PathExpressionResolver({
                symbolIndex: this.symbolIndex,
                getFlatCommands: this.loadFlatCommands,
                entryFile: URI.parse(this.entryCMake),
            });
        }

        return this.pathExpressionResolver;
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

    private async findPackage(ctx: FlatCommand): Promise<void> {
        const args = ctx.argument_list();
        if (args.length <= 0) {
            return;
        }

        const packageName = args[0].getText();
        const targetCMakeUri = await getFindPackageUri(this.symbolIndex, this.workspaceFolder, packageName);
        if (!targetCMakeUri) {
            return;
        }

        const targetCMakeFile = targetCMakeUri.toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = await this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo, this.entryCMake);
        await targetInfoListener.processCommands(commands);
    }

    private async include(ctx: FlatCommand): Promise<void> {
        const args = ctx.argument_list();
        if (args.length !== 1) {
            return;
        }
        const includeFile = args[0].getText();
        const includeUri = await this.getPathExpressionResolver().resolveFileExpression(includeFile, URI.parse(this.currentCMake), args[0].start.line - 1)
            ?? getIncludeFileUri(this.symbolIndex, URI.file(this.baseDirectory), includeFile)
            ?? getIncludeModuleUri(this.symbolIndex, includeFile);
        if (!includeUri) {
            return;
        }

        const targetCMakeFile = includeUri.toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = await this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo, this.entryCMake);
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