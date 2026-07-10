import * as assert from 'assert';
import * as path from 'path';
import { WorkspaceSymbolParams } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from '../../symbolIndex';
import { WorkspaceSymbolResolver } from '../../workspaceSymbol';

suite('WorkspaceSymbolResolver', () => {
    const workspacePath = path.resolve('workspace-symbol-root');
    const workspaceUri = URI.file(workspacePath).toString();

    function addCommand(index: SymbolIndex, filePath: string, name: string): void {
        const uri = URI.file(filePath).toString();
        const cache = new FileSymbolCache(uri);
        cache.addCommand(new Symbol(name, SymbolKind.Function, uri, 0, 0));
        index.setCache(uri, cache);
    }

    function resolve(index: SymbolIndex, query = '') {
        const resolver = new WorkspaceSymbolResolver(index, workspaceUri);
        return resolver.resolve({ query } as WorkspaceSymbolParams);
    }

    test('returns symbols defined inside the workspace', () => {
        const index = new SymbolIndex();
        addCommand(index, path.join(workspacePath, 'cmake', 'helpers.cmake'), 'workspace_helper');

        const result = resolve(index, 'workspace_helper');

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'workspace_helper');
    });

    test('excludes symbols from files outside the workspace', () => {
        const index = new SymbolIndex();
        addCommand(index, path.resolve('cmake-standard-modules', 'External.cmake'), 'external_helper');

        assert.deepStrictEqual(resolve(index, 'external_helper'), []);
    });

    test('does not treat a directory with the same prefix as part of the workspace', () => {
        const index = new SymbolIndex();
        addCommand(index, `${workspacePath}-other${path.sep}helpers.cmake`, 'prefix_helper');

        assert.deepStrictEqual(resolve(index, 'prefix_helper'), []);
    });

    test('allows workspace files whose names start with two dots', () => {
        const index = new SymbolIndex();
        addCommand(index, path.join(workspacePath, '..helpers.cmake'), 'dot_prefix_helper');

        const result = resolve(index, 'dot_prefix_helper');

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'dot_prefix_helper');
    });

    test('excludes non-file caches', () => {
        const index = new SymbolIndex();
        const uri = 'cmake-builtin://system';
        const cache = new FileSymbolCache(uri);
        cache.addCommand(new Symbol('builtin_helper', SymbolKind.BuiltinCommand, uri, 0, 0));
        index.setCache(uri, cache);

        assert.deepStrictEqual(resolve(index, 'builtin_helper'), []);
    });
});
