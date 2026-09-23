import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { FileApiRawSnapshot } from '../../fileApiSnapshot';
import { SymbolIndex } from '../../symbolIndex';
import { getFindPackageUri, getIncludeFileUri, getIncludeModuleUri, isIncludeModuleReference, matchesIncludeModulePath, normalizeQuotedArgument, parseCMakeText } from '../../utils';

suite('Utils Tests', () => {
    test('parseCMakeText captures syntax errors without the default console listener', () => {
        const parsed = parseCMakeText('set()');

        assert(parsed.syntaxDiagnostics.length > 0);
    });

    test('getIncludeFileUri should stay file-only and not resolve builtin modules', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-file-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.writeFileSync(path.join(modulesDir, 'CMakePrintHelpers.cmake'), '# module\n', 'utf8');

            const result = getIncludeFileUri(symbolIndex, URI.file(tempDir), 'CMakePrintHelpers');
            assert.strictEqual(result, null);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getIncludeModuleUri should resolve builtin include modules', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-module-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const modulePath = path.join(modulesDir, 'CMakePrintHelpers.cmake');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.writeFileSync(modulePath, '# module\n', 'utf8');

            const result = getIncludeModuleUri(symbolIndex, 'CMakePrintHelpers');
            assert.strictEqual(result?.toString(), URI.file(modulePath).toString());
            assert.strictEqual(getIncludeModuleUri(symbolIndex, 'local/include-local.cmake'), null);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('include module helpers should preserve nested module path components', () => {
        assert.strictEqual(isIncludeModuleReference('Sub/Mod'), true);
        assert.strictEqual(isIncludeModuleReference('Sub\\Mod'), true);
        assert.strictEqual(isIncludeModuleReference('Foo.Bar'), true);
        assert.strictEqual(isIncludeModuleReference('Sub/Foo.Bar'), true);
        assert.strictEqual(isIncludeModuleReference('"Sub/Mod"'), true);
        assert.strictEqual(isIncludeModuleReference('Sub/Mod.cmake'), false);
        assert.strictEqual(isIncludeModuleReference('/absolute/Sub/Mod'), false);
        assert.strictEqual(isIncludeModuleReference('${MODULE_DIR}/Mod'), false);
        assert.strictEqual(matchesIncludeModulePath('Sub/Mod', '/workspace/modules/Sub/Mod.cmake'), true);
        assert.strictEqual(matchesIncludeModulePath('Sub/Mod', '/workspace/modules/Other/Mod.cmake'), false);
        assert.strictEqual(
            matchesIncludeModulePath('Sub/Mod', '/workspace/modules/sub/mod.cmake'),
            process.platform === 'win32',
        );
    });

    test('getIncludeModuleUri should resolve nested builtin include modules', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-nested-module-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const modulePath = path.join(modulesDir, 'Sub', 'Mod.cmake');
        const dottedModulePath = path.join(modulesDir, 'Sub', 'Foo.Bar.cmake');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(path.dirname(modulePath), { recursive: true });
            fs.writeFileSync(modulePath, '# nested module\n', 'utf8');
            fs.writeFileSync(dottedModulePath, '# dotted nested module\n', 'utf8');

            const result = getIncludeModuleUri(symbolIndex, 'Sub/Mod');
            assert.strictEqual(result?.toString(), URI.file(modulePath).toString());
            const dottedResult = getIncludeModuleUri(symbolIndex, 'Sub/Foo.Bar');
            assert.strictEqual(dottedResult?.toString(), URI.file(dottedModulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('normalizeQuotedArgument should strip one pair of enclosing quotes', () => {
        assert.strictEqual(normalizeQuotedArgument('"Example"'), 'Example');
        assert.strictEqual(normalizeQuotedArgument("'Example'"), 'Example');
        assert.strictEqual(normalizeQuotedArgument('Example'), 'Example');
    });

    test('getIncludeModuleUri should resolve quoted builtin include modules', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-module-quoted-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const modulePath = path.join(modulesDir, 'CMakePrintHelpers.cmake');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.writeFileSync(modulePath, '# module\n', 'utf8');

            const result = getIncludeModuleUri(symbolIndex, '"CMakePrintHelpers"');
            assert.strictEqual(result?.toString(), URI.file(modulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getIncludeModuleUri should resolve external modules from File API cmake inputs', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-module-file-api-'));
        const externalModulePath = path.join(tempDir, 'cmake', 'ExternalHelpers.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [
                {
                    path: externalModulePath,
                    isExternal: true,
                },
            ],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(path.dirname(externalModulePath), { recursive: true });
            fs.writeFileSync(externalModulePath, '# external module\n', 'utf8');

            const result = getIncludeModuleUri(symbolIndex, 'ExternalHelpers', fileApiRawSnapshot);
            assert.strictEqual(result?.toString(), URI.file(externalModulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getIncludeModuleUri should match nested modules by full File API path suffix', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-include-nested-file-api-'));
        const wrongModulePath = path.join(tempDir, 'other', 'Mod.cmake');
        const nestedModulePath = path.join(tempDir, 'modules', 'Sub', 'Mod.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [
                { path: wrongModulePath, isExternal: true },
                { path: nestedModulePath, isExternal: true },
            ],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(path.dirname(wrongModulePath), { recursive: true });
            fs.mkdirSync(path.dirname(nestedModulePath), { recursive: true });
            fs.writeFileSync(wrongModulePath, '# unrelated module with the same basename\n', 'utf8');
            fs.writeFileSync(nestedModulePath, '# nested module\n', 'utf8');

            const result = getIncludeModuleUri(symbolIndex, 'Sub/Mod', fileApiRawSnapshot);
            assert.strictEqual(result?.toString(), URI.file(nestedModulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve builtin Find-modules first', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-module-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const modulePath = path.join(modulesDir, 'FindThreads.cmake');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.writeFileSync(modulePath, '# module\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Threads');
            assert.strictEqual(result?.toString(), URI.file(modulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve quoted builtin Find-modules', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-module-quoted-'));
        const modulesDir = path.join(tempDir, 'Modules');
        const modulePath = path.join(modulesDir, 'FindThreads.cmake');
        const symbolIndex = new SymbolIndex();
        symbolIndex.cmakeModulePath = modulesDir;

        try {
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.writeFileSync(modulePath, '# module\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, '"Threads"');
            assert.strictEqual(result?.toString(), URI.file(modulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve config packages from CMakeCache', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-config-'));
        const buildDir = path.join(tempDir, 'build');
        const packageDir = path.join(tempDir, 'packages', 'Example');
        const configPath = path.join(packageDir, 'ExampleConfig.cmake');
        const symbolIndex = new SymbolIndex();

        try {
            fs.mkdirSync(buildDir, { recursive: true });
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(configPath, '# config\n', 'utf8');
            fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), `Example_DIR:PATH=${packageDir}\n`, 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example');
            assert.strictEqual(result?.toString(), URI.file(configPath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve config packages from custom build directory', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-custom-build-'));
        const buildDir = path.join(tempDir, 'cmake-build-debug');
        const packageDir = path.join(tempDir, 'packages', 'Example');
        const configPath = path.join(packageDir, 'ExampleConfig.cmake');
        const symbolIndex = new SymbolIndex();

        try {
            fs.mkdirSync(buildDir, { recursive: true });
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(configPath, '# config\n', 'utf8');
            fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), `Example_DIR:PATH=${packageDir}\n`, 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', { buildDirectory: buildDir });
            assert.strictEqual(result?.toString(), URI.file(configPath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve config packages from File API cache snapshot first', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-file-api-'));
        const packageDir = path.join(tempDir, 'packages', 'Example');
        const configPath = path.join(packageDir, 'ExampleConfig.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {
                Example_DIR: {
                    name: 'Example_DIR',
                    type: 'PATH',
                    value: packageDir,
                },
            },
            cmakeInputs: [],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(configPath, '# config\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', { fileApiRawSnapshot });
            assert.strictEqual(result?.toString(), URI.file(configPath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve external Find-modules from File API cmake inputs', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-module-file-api-'));
        const findModulePath = path.join(tempDir, 'cmake', 'FindExample.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [
                {
                    path: findModulePath,
                    isExternal: true,
                },
            ],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(path.dirname(findModulePath), { recursive: true });
            fs.writeFileSync(findModulePath, '# external find module\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', { fileApiRawSnapshot });
            assert.strictEqual(result?.toString(), URI.file(findModulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve config packages from case-insensitive cache keys and file names', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-case-insensitive-'));
        const packageDir = path.join(tempDir, 'packages', 'harfbuzz');
        const configPath = path.join(packageDir, 'harfbuzzConfig.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {
                harfbuzz_DIR: {
                    name: 'harfbuzz_DIR',
                    type: 'PATH',
                    value: packageDir,
                },
            },
            cmakeInputs: [],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(configPath, '# config\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'HarfBuzz', { fileApiRawSnapshot });
            assert.strictEqual(result?.toString(), URI.file(configPath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve workspace Find-modules without File API', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-workspace-module-'));
        const sourceDir = path.join(tempDir, 'cmake');
        const sourceFile = path.join(sourceDir, 'Dependencies.cmake');
        const findModulePath = path.join(tempDir, 'CMake', 'Modules', 'FindHarfBuzz.cmake');
        const symbolIndex = new SymbolIndex();

        try {
            fs.mkdirSync(path.dirname(findModulePath), { recursive: true });
            fs.mkdirSync(sourceDir, { recursive: true });
            fs.writeFileSync(findModulePath, '# workspace find module\n', 'utf8');
            fs.writeFileSync(sourceFile, 'find_package(HarfBuzz)\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'HarfBuzz', {
                sourceUri: URI.file(sourceFile),
            });
            assert.strictEqual(
                path.normalize(result?.fsPath ?? '').toLowerCase(),
                path.normalize(findModulePath).toLowerCase(),
            );
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFindPackageUri should resolve config packages directly from File API cmake inputs', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-find-package-input-config-'));
        const packageDir = path.join(tempDir, 'packages', 'rlottie');
        const configPath = path.join(packageDir, 'rlottieConfig.cmake');
        const symbolIndex = new SymbolIndex();
        const fileApiRawSnapshot: FileApiRawSnapshot = {
            replyDirectory: path.join(tempDir, '.cmake', 'api', 'v1', 'reply'),
            indexFile: 'index-test.json',
            indexMtimeMs: 1,
            cacheEntriesByName: {},
            cmakeInputs: [
                {
                    path: configPath,
                    isExternal: true,
                },
            ],
            globDependencies: [],
            toolchainsByLanguage: {},
            targetsByName: {},
            targetsById: {},
        };

        try {
            fs.mkdirSync(packageDir, { recursive: true });
            fs.writeFileSync(configPath, '# config\n', 'utf8');

            const result = await getFindPackageUri(symbolIndex, tempDir, 'rlottie', { fileApiRawSnapshot });
            assert.strictEqual(result?.toString(), URI.file(configPath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
