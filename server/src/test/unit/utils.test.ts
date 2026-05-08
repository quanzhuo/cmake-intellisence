import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { SymbolIndex } from '../../symbolIndex';
import { getFileContent, getFindPackageUri, getIncludeFileUri, getIncludeModuleUri } from '../../utils';

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
});