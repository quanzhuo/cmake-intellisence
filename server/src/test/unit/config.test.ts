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
        excludeCMakeBuildDirectories: true,
        enableCMakeToolsIntegration: true,
    };

    test('prefers current settings when current keys are customized', () => {
        const resolved = resolveExtensionSettings({
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist'],
            excludeCMakeBuildDirectories: false,
        }, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'error',
            cmdCaseDiagnostics: false,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy'],
            excludeCMakeBuildDirectories: true,
        }, defaults);

        assert.deepStrictEqual(resolved, {
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist'],
            excludeCMakeBuildDirectories: false,
            enableCMakeToolsIntegration: true,
        });
    });

    test('falls back to legacy settings when current keys stay at defaults', () => {
        const resolved = resolveExtensionSettings({
            cmakePath: 'cmake',
            loggingLevel: 'off',
            cmdCaseDiagnostics: false,
            pkgConfigPath: 'pkg-config',
            workspaceIgnoreDirectories: ['.git', 'build'],
            excludeCMakeBuildDirectories: true,
        }, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'warning',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy', ' out '],
            excludeCMakeBuildDirectories: false,
        }, defaults);

        assert.deepStrictEqual(resolved, {
            cmakePath: '/legacy/cmake',
            loggingLevel: 'warning',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/legacy/pkg-config',
            workspaceIgnoreDirectories: ['legacy', 'out'],
            excludeCMakeBuildDirectories: false,
            enableCMakeToolsIntegration: true,
        });
    });

    test('uses defaults when neither key is configured', () => {
        const resolved = resolveExtensionSettings(undefined, undefined, defaults);
        assert.deepStrictEqual(resolved, defaults);
    });
});
