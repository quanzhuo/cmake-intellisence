import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { deserializeFileSymbolCache, hydrateBuiltinModuleCacheEntry, serializeFileSymbolCache, warmBuiltinModuleCaches } from '../../builtinModuleIndex';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from '../../symbolIndex';

suite('Builtin Module Index Tests', () => {
    test('serializeFileSymbolCache should round-trip symbols and dependencies', () => {
        const uri = 'file:///tmp/Test.cmake';
        const cache = new FileSymbolCache(uri);
        cache.addCommand(new Symbol('my_func', SymbolKind.Function, uri, 1, 2));
        cache.addVariable(new Symbol('MY_VAR', SymbolKind.Variable, uri, 3, 4));
        cache.addDependency('file:///tmp/Other.cmake', 'include');

        const restored = deserializeFileSymbolCache(serializeFileSymbolCache(cache));

        assert.strictEqual(restored.commands.get('my_func')?.[0].name, 'my_func');
        assert.strictEqual(restored.variables.get('MY_VAR')?.[0].line, 3);
        assert.deepStrictEqual(restored.dependencies, [{ uri: 'file:///tmp/Other.cmake', type: 'include' }]);
    });

    test('warmBuiltinModuleCaches should persist and reuse builtin module indexes', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-builtin-cache-'));
        const moduleDir = path.join(tempRoot, 'Modules');
        const previousLocalAppData = process.env.LOCALAPPDATA;
        const previousAppData = process.env.APPDATA;
        process.env.LOCALAPPDATA = tempRoot;
        process.env.APPDATA = tempRoot;
        fs.mkdirSync(moduleDir, { recursive: true });
        fs.writeFileSync(path.join(moduleDir, 'Foo.cmake'), 'set(FOO ON)\n', 'utf8');
        fs.writeFileSync(path.join(moduleDir, 'Bar.cmake'), 'include(Foo)\nfunction(bar)\nendfunction()\n', 'utf8');

        try {
            const firstIndex = new SymbolIndex();
            firstIndex.cmakeModulePath = moduleDir;
            const firstResult = await warmBuiltinModuleCaches({
                symbolIndex: firstIndex,
                cmakePath: 'cmake',
                cmakeVersion: '3.29.0',
                cmakeModulePath: moduleDir,
            });

            assert.strictEqual(firstResult.loadedFromCache, 0);
            assert.strictEqual(firstResult.indexedFresh, 2);

            const secondIndex = new SymbolIndex();
            secondIndex.cmakeModulePath = moduleDir;
            const secondResult = await warmBuiltinModuleCaches({
                symbolIndex: secondIndex,
                cmakePath: 'cmake',
                cmakeVersion: '3.29.0',
                cmakeModulePath: moduleDir,
            });

            assert.strictEqual(secondResult.loadedFromCache, 2);
            assert.strictEqual(secondResult.indexedFresh, 0);

            const barUri = URI.file(path.join(moduleDir, 'Bar.cmake')).toString();
            const fooUri = URI.file(path.join(moduleDir, 'Foo.cmake')).toString();
            const barCache = secondIndex.getCache(barUri);
            assert(barCache, 'Expected cached index for Bar.cmake');
            assert(barCache?.dependencies.some(dep => dep.uri === fooUri && dep.type === 'include'));
        } finally {
            process.env.LOCALAPPDATA = previousLocalAppData;
            process.env.APPDATA = previousAppData;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('hydrateBuiltinModuleCacheEntry should restore a single persisted builtin module on demand', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-builtin-entry-'));
        const moduleDir = path.join(tempRoot, 'Modules');
        const previousLocalAppData = process.env.LOCALAPPDATA;
        const previousAppData = process.env.APPDATA;
        process.env.LOCALAPPDATA = tempRoot;
        process.env.APPDATA = tempRoot;
        fs.mkdirSync(moduleDir, { recursive: true });
        const fooPath = path.join(moduleDir, 'Foo.cmake');
        fs.writeFileSync(fooPath, 'set(FOO ON)\n', 'utf8');

        try {
            const warmIndex = new SymbolIndex();
            await warmBuiltinModuleCaches({
                symbolIndex: warmIndex,
                cmakePath: 'cmake',
                cmakeVersion: '3.29.0',
                cmakeModulePath: moduleDir,
            });

            const coldIndex = new SymbolIndex();
            const fooUri = URI.file(fooPath).toString();
            const hydrated = await hydrateBuiltinModuleCacheEntry({
                symbolIndex: coldIndex,
                cmakePath: 'cmake',
                cmakeVersion: '3.29.0',
                cmakeModulePath: moduleDir,
            }, fooUri);

            assert.strictEqual(hydrated, true);
            assert(coldIndex.getCache(fooUri), 'Expected Foo.cmake cache to be restored on demand');
        } finally {
            process.env.LOCALAPPDATA = previousLocalAppData;
            process.env.APPDATA = previousAppData;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('builtin module commands should participate in builtin command lookup without leaking into user command lookup', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-builtin-commands-'));
        const moduleDir = path.join(tempRoot, 'Modules');
        const previousLocalAppData = process.env.LOCALAPPDATA;
        const previousAppData = process.env.APPDATA;
        process.env.LOCALAPPDATA = tempRoot;
        process.env.APPDATA = tempRoot;
        fs.mkdirSync(moduleDir, { recursive: true });
        const builtinModulePath = path.join(moduleDir, 'ExternalThing.cmake');
        const workspaceFilePath = path.join(tempRoot, 'Local.cmake');
        fs.writeFileSync(builtinModulePath, 'function(ExternalThing_DoWork)\nendfunction()\n', 'utf8');
        fs.writeFileSync(workspaceFilePath, 'function(Local_DoWork)\nendfunction()\n', 'utf8');

        try {
            const symbolIndex = new SymbolIndex();
            symbolIndex.cmakeModulePath = moduleDir;
            symbolIndex.setSystemCache(new FileSymbolCache('cmake-builtin://system'));

            await warmBuiltinModuleCaches({
                symbolIndex,
                cmakePath: 'cmake',
                cmakeVersion: '3.29.0',
                cmakeModulePath: moduleDir,
            });

            const workspaceUri = URI.file(workspaceFilePath).toString();
            const workspaceCache = new FileSymbolCache(workspaceUri);
            workspaceCache.addCommand(new Symbol('Local_DoWork', SymbolKind.Function, workspaceUri, 0, 0));
            symbolIndex.setCache(workspaceUri, workspaceCache);

            const builtinCommands = Array.from(symbolIndex.getAllBuiltinCommands());
            const userCommands = Array.from(symbolIndex.getAllUserCommandSymbols());

            assert(builtinCommands.includes('ExternalThing_DoWork'), 'Expected builtin module command to appear in builtin command lookup');
            assert(!userCommands.includes('ExternalThing_DoWork'), 'Builtin module command should not appear as a user command');
            assert(userCommands.includes('Local_DoWork'), 'Expected workspace function to remain visible as a user command');
            assert.strictEqual(symbolIndex.hasBuiltinCommand('externalthing_dowork'), true);
        } finally {
            process.env.LOCALAPPDATA = previousLocalAppData;
            process.env.APPDATA = previousAppData;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});