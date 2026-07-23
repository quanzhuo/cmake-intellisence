import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as which from 'which';
import paths, { mkdir_p } from './paths';
import { execFilePromise } from './processUtils';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
    workspaceIgnoreDirectories?: string[];
    excludeCMakeBuildDirectories?: boolean;
}
const CMAKE_CACHE_FINGERPRINT_SCHEMA_VERSION = 1;
const builtinEntriesMemo = new Map<string, Promise<[Set<string>, Set<string>, Set<string>, Set<string>, Set<string>]>>();
const cmakeRootMemo = new Map<string, Promise<string | null>>();
const pkgConfigModulesMemo = new Map<string, Promise<Map<string, string>>>();

type PersistedBuiltinEntries = {
    cmakeFingerprint: string;
    modules: string[];
    policies: string[];
    variables: string[];
    properties: string[];
    commands: string[];
};

type PersistedCMakeRoot = {
    cmakeFingerprint: string;
    cmakeRoot: string;
};

type CMakeCacheFingerprint = {
    memoKey: string;
    value: string;
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

export interface CMakeEnvironmentPhaseStats {
    phase: string;
    durationMs: number;
    detail?: string;
}

type TimedResult<T> = {
    value: T;
    durationMs: number;
};

function timeSync<T>(callback: () => T): TimedResult<T> {
    const startedAt = Date.now();
    return {
        value: callback(),
        durationMs: Date.now() - startedAt,
    };
}

async function timeAsync<T>(callback: () => Promise<T>): Promise<TimedResult<T>> {
    const startedAt = Date.now();
    return {
        value: await callback(),
        durationMs: Date.now() - startedAt,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeDirectoryBestEffort(dir: string): Promise<void> {
    const retryableCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !retryableCodes.has(code) || attempt === 4) {
                return;
            }
            await sleep(50 * (attempt + 1));
        }
    }
}

export async function initializeCMakeEnvironment(
    extSettings: ExtensionSettings,
    symbolIndex: SymbolIndex,
    onBuiltinEntriesLoaded?: (stats: BuiltinEntriesLoadStats) => void,
    onPhaseTimed?: (stats: CMakeEnvironmentPhaseStats) => void,
): Promise<void> {
    const resolvedCMakePath = timeSync(() => resolveExecutablePath(extSettings.cmakePath, 'cmake'));
    const cmakePath = resolvedCMakePath.value;
    const cacheFingerprint = await getCMakeCacheFingerprint(cmakePath);
    onPhaseTimed?.({
        phase: 'resolve-cmake-path',
        durationMs: resolvedCMakePath.durationMs,
        detail: cmakePath,
    });

    const [builtinEntriesResult, pkgConfigModules] = await Promise.all([
        timeAsync(() => getBuiltinEntries(cmakePath, cacheFingerprint)).then(result => {
            onPhaseTimed?.({
                phase: 'get-builtin-entries',
                durationMs: result.durationMs,
                detail: result.value.stats.source,
            });
            return result.value;
        }),
        timeAsync(() => getPkgConfigModules(extSettings.pkgConfigPath)).then(result => {
            onPhaseTimed?.({
                phase: 'get-pkg-config-modules',
                durationMs: result.durationMs,
                detail: `count=${result.value.size}`,
            });
            return result.value;
        }),
    ]);
    onBuiltinEntriesLoaded?.(builtinEntriesResult.stats);
    const builtinEntries = builtinEntriesResult.entries;
    const [modules, policies, variables, properties, commands] = builtinEntries;
    const uri = 'cmake-builtin://system';
    const systemCache = new FileSymbolCache(uri);

    for (const command of commands) {
        systemCache.addCommand(new Symbol(command, SymbolKind.BuiltinCommand, uri, 0, 0));
    }
    for (const variable of expandTemplateEntries(variables)) {
        systemCache.addVariable(new Symbol(variable, SymbolKind.BuiltinVariable, uri, 0, 0));
    }
    for (const moduleName of modules) {
        systemCache.addModule(new Symbol(moduleName, SymbolKind.Module, uri, 0, 0));
    }
    for (const policy of policies) {
        systemCache.addPolicy(new Symbol(policy, SymbolKind.Policy, uri, 0, 0));
    }
    for (const property of expandTemplateEntries(properties)) {
        systemCache.addProperty(new Symbol(property, SymbolKind.Property, uri, 0, 0));
    }

    symbolIndex.cmakePath = cmakePath;
    symbolIndex.cmakeFingerprint = cacheFingerprint.value;
    symbolIndex.pkgConfigPath = extSettings.pkgConfigPath;
    symbolIndex.pkgConfigModules = pkgConfigModules;
    const modulePathResult = await timeAsync(() => getCMakeModulePath(cmakePath, cacheFingerprint));
    symbolIndex.cmakeModulePath = modulePathResult.value;
    onPhaseTimed?.({
        phase: 'get-cmake-module-path',
        durationMs: modulePathResult.durationMs,
        detail: modulePathResult.value ?? 'not-found',
    });
    symbolIndex.setSystemCache(systemCache);
}

function resolveExecutablePath(executable: string, label: string): string {
    const absPath: string | null = which.sync(executable, { nothrow: true });
    if (absPath === null) {
        throw new Error(`${label} not found: ${executable}`);
    }
    return absPath;
}

function expandTemplateEntries(entries: Set<string>): Set<string> {
    const placeholders: ReadonlyArray<readonly [string, readonly string[]]> = [
        ['<LANG>', ['C', 'CXX']],
        ['<CONFIG>', ['DEBUG', 'RELEASE', 'MINSIZEREL', 'RELWITHDEBINFO']],
    ];
    const result = new Set<string>();
    for (const entry of entries) {
        let variants = [entry];
        for (const [placeholder, values] of placeholders) {
            variants = variants.flatMap(variant => variant.includes(placeholder)
                ? values.map(value => variant.split(placeholder).join(value))
                : [variant]
            );
        }
        variants.forEach(variant => result.add(variant));
    }
    return result;
}

async function getCMakeModulePath(cmakePath: string, cacheFingerprint: CMakeCacheFingerprint): Promise<string | undefined> {
    const cmakeRoot = await getCMakeRoot(cmakePath, cacheFingerprint);
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

async function getCMakeRoot(cmakePath: string, cacheFingerprint: CMakeCacheFingerprint): Promise<string | null> {
    const memoized = cmakeRootMemo.get(cacheFingerprint.memoKey);
    if (memoized) {
        return memoized;
    }

    const request = (async (): Promise<string | null> => {
        const persisted = await readCMakeRootCache(cmakePath);
        if (hasMatchingCMakeCacheFingerprint(persisted?.cmakeFingerprint, cacheFingerprint.value)) {
            return persisted!.cmakeRoot;
        }

        const detectedRoot = await detectCMakeRoot(cmakePath);
        if (detectedRoot) {
            await writeCMakeRootCache(cmakePath, cacheFingerprint.value, detectedRoot);
        }
        return detectedRoot;
    })();

    cmakeRootMemo.set(cacheFingerprint.memoKey, request);
    try {
        return await request;
    } catch (error) {
        cmakeRootMemo.delete(cacheFingerprint.memoKey);
        throw error;
    }
}

function detectBundledCMakeRoot(cmakePath: string): string | null {
    const shareDir = path.join(path.dirname(cmakePath), '..', 'share');
    try {
        const candidates = fs.readdirSync(shareDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && (entry.name === 'cmake' || entry.name.startsWith('cmake-')))
            .map(entry => path.join(shareDir, entry.name))
            .filter(candidate => fs.existsSync(path.join(candidate, 'Modules')))
            .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
        return candidates[0] ? path.normalize(candidates[0]) : null;
    } catch {
        return null;
    }
}

async function detectCMakeRoot(cmakePath: string): Promise<string | null> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisense-'));
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
            const bundledRoot = detectBundledCMakeRoot(cmakePath);
            if (bundledRoot) {
                return bundledRoot;
            }
        }
        // Could not determine CMAKE_ROOT; return null so the caller can proceed without it.
        return null;
    } finally {
        await removeDirectoryBestEffort(tmpDir);
    }
}

async function getBuiltinEntries(cmakePath: string, cacheFingerprint: CMakeCacheFingerprint): Promise<BuiltinEntriesLoadResult> {
    const memoized = builtinEntriesMemo.get(cacheFingerprint.memoKey);
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
        if (hasMatchingCMakeCacheFingerprint(persisted?.cmakeFingerprint, cacheFingerprint.value)) {
            const cachedEntries = deserializeBuiltinEntries(persisted!);
            return {
                entries: cachedEntries,
                stats: {
                    source: 'disk',
                    durationMs: Date.now() - startedAt,
                },
            };
        }

        const fresh = await fetchBuiltinEntriesFromCMake(cmakePath);
        await writeBuiltinEntriesCache(cmakePath, cacheFingerprint.value, fresh);
        return {
            entries: fresh,
            stats: {
                source: 'cmake',
                durationMs: Date.now() - startedAt,
            },
        };
    })();

    const memoRequest = request.then(result => result.entries);
    builtinEntriesMemo.set(cacheFingerprint.memoKey, memoRequest);
    try {
        return await request;
    } catch (error) {
        builtinEntriesMemo.delete(cacheFingerprint.memoKey);
        throw error;
    }
}

function getBuiltinEntriesCacheFilePath(cmakePath: string): string {
    const hash = crypto.createHash('sha256').update(cmakePath).digest('hex').slice(0, 16);
    return path.join(paths.dataDir, 'builtin-help-cache', `${hash}.json`);
}

function getCMakeRootCacheFilePath(cmakePath: string): string {
    const hash = crypto.createHash('sha256').update(cmakePath).digest('hex').slice(0, 16);
    return path.join(paths.dataDir, 'cmake-root-cache', `${hash}.json`);
}

async function getCMakeCacheFingerprint(cmakePath: string): Promise<CMakeCacheFingerprint> {
    let size = -1;
    let mtimeMs = -1;
    try {
        const stats = await fs.promises.stat(cmakePath);
        if (!stats.isFile()) {
            throw new Error(`cmake path is not a file: ${cmakePath}`);
        }
        size = stats.size;
        mtimeMs = stats.mtimeMs;
    } catch (error) {
        // Only swallow standard Node.js file-system errors (have a 'code' property).
        // Re-throw custom errors (e.g. !stats.isFile()) to let the caller handle them.
        if (!(error instanceof Error && 'code' in error)) {
            throw error;
        }
    }

    const raw = [
        CMAKE_CACHE_FINGERPRINT_SCHEMA_VERSION.toString(),
        cmakePath,
        size.toString(),
        mtimeMs.toString(),
    ].join('\0');
    return {
        memoKey: raw,
        value: crypto.createHash('sha256').update(raw).digest('hex'),
    };
}

function hasMatchingCMakeCacheFingerprint(persistedFingerprint: string | undefined, currentFingerprint: string): boolean {
    return !!persistedFingerprint && persistedFingerprint === currentFingerprint;
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

async function readCMakeRootCache(cmakePath: string): Promise<PersistedCMakeRoot | null> {
    const filePath = getCMakeRootCacheFilePath(cmakePath);
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as PersistedCMakeRoot;
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
    cmakeFingerprint: string,
    entries: BuiltinEntries,
): Promise<void> {
    const filePath = getBuiltinEntriesCacheFilePath(cmakePath);
    const payload: PersistedBuiltinEntries = {
        cmakeFingerprint,
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

async function writeCMakeRootCache(
    cmakePath: string,
    cmakeFingerprint: string,
    cmakeRoot: string,
): Promise<void> {
    const filePath = getCMakeRootCacheFilePath(cmakePath);
    const payload: PersistedCMakeRoot = {
        cmakeFingerprint,
        cmakeRoot,
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
    const memoKey = pkgConfigPath;
    const memoized = pkgConfigModulesMemo.get(memoKey);
    if (memoized) {
        return memoized;
    }

    const request = (async (): Promise<Map<string, string>> => {
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
    })();

    pkgConfigModulesMemo.set(memoKey, request);
    try {
        return await request;
    } catch (error) {
        pkgConfigModulesMemo.delete(memoKey);
        throw error;
    }
}
