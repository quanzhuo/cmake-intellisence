import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { FileApiRawSnapshot } from '../../fileApiSnapshot';
import { SymbolIndex } from '../../symbolIndex';
import { getFileContent, getFindPackageUri, getIncludeFileUri, getIncludeModuleUri, normalizeQuotedArgument } from '../../utils';

suite('Utils Tests', () => {
    test('getFileContent should return empty text for directories', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-'));
        const documents = new TextDocuments(TextDocument);

        try {
            const result = await getFileContent(documents, URI.file(tempDir));
            assert.strictEqual(result, '');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('getFileContent should return empty text for missing paths', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-utils-missing-'));
        const missingPath = path.join(tempDir, '${CMAKE_CURRENT_LIST_DIR}', 'SelectLibraryConfigurations.cmake');
        const documents = new TextDocuments(TextDocument);

        try {
            const result = await getFileContent(documents, URI.file(missingPath));
            assert.strictEqual(result, '');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
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

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', undefined, buildDir);
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

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', fileApiRawSnapshot);
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

            const result = await getFindPackageUri(symbolIndex, tempDir, 'Example', fileApiRawSnapshot);
            assert.strictEqual(result?.toString(), URI.file(findModulePath).toString());
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});