import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { SymbolIndex } from '../../symbolIndex';
import { getFileContent, getIncludeFileUri, getIncludeModuleUri } from '../../utils';

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
});