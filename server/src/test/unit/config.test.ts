import * as assert from 'assert';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { resolveExtensionSettings } from '../../config';

suite('config compatibility tests', () => {
    const defaults: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
        workspaceIgnoreDirectories: ['.git', 'build'],
    };

    test('prefers current settings when current keys are customized', () => {
        const resolved = resolveExtensionSettings({
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist'],
        }, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'error',
            cmdCaseDiagnostics: false,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy'],
        }, defaults);

        assert.deepStrictEqual(resolved, {
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist'],
        });
    });

    test('falls back to legacy settings when current keys stay at defaults', () => {
        const resolved = resolveExtensionSettings({
            cmakePath: 'cmake',
            loggingLevel: 'off',
            cmdCaseDiagnostics: false,
            pkgConfigPath: 'pkg-config',
            workspaceIgnoreDirectories: ['.git', 'build'],
        }, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'warning',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy', ' out '],
        }, defaults);

        assert.deepStrictEqual(resolved, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'warning',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy', 'out'],
        });
    });

    test('uses defaults when neither key is configured', () => {
        const resolved = resolveExtensionSettings(undefined, undefined, defaults);
        assert.deepStrictEqual(resolved, defaults);
    });
});