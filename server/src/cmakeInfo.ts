import * as cp from 'child_process';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Connection } from 'vscode-languageserver';
import which = require('which');

type Modules = string[];
type Policies = string[];
type Variables = string[];
type Properties = string[];
type Commands = string[];

export class CMakeInfo {
    public version: string;
    public major: number;
    public minor: number;
    public patch: number;
    public modules: string[] = [];
    public policies: string[] = [];
    public variables: string[] = [];
    public properties: string[] = [];
    public commands: string[] = [];
    public systemModulePath?: string;

    constructor(public cmakePath: string, private connection: Connection) { }

    public async init() {
        const absPath: string | null = which.sync(this.cmakePath, { nothrow: true });
        if (absPath === null) {
            this.connection.window.showInformationMessage(`CMakeInfo.init, cmake not found: ${this.cmakePath}`);
            return;
        } else {
            this.cmakePath = absPath;
        }

        // if this.cmakePath is a symlink, resolve it
        this.cmakePath = await fsp.realpath(this.cmakePath);
        [
            [this.version, this.major, this.minor, this.patch],
            [this.modules, this.policies, this.variables, this.properties, this.commands]
        ] = await Promise.all([this.getCMakeVersion(), this.getBuiltinEntries()]);

        try {
            for (const dir of ['cmake', `cmake-${this.major}.${this.minor}`]) {
                const module = path.join(path.dirname(this.cmakePath), '..', 'share', dir, 'Modules');
                console.log(`module: ${module}`);
                if (fs.existsSync(path.join(module, 'FindQt.cmake'))) {
                    this.systemModulePath = path.normalize(module);
                    break;
                }
            }
        } catch (error) {
            this.connection.window.showInformationMessage(`CMakeInfo.init, error: ${error}`);
        }

        if (!this.systemModulePath) {
            this.connection.window.showInformationMessage("CMake system module path not found.");
        }
    }

    private async getCMakeVersion(): Promise<[string, number, number, number]> {
        const command = `"${this.cmakePath}" --version`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
        const res = stdout.match(regexp);
        return [
            res[0],
            parseInt(res[1]),
            parseInt(res[2]),
            parseInt(res[3])
        ];
    }

    private async getBuiltinEntries(): Promise<[Modules, Policies, Variables, Properties, Commands]> {
        const command = `"${this.cmakePath}" --help-module-list --help-policy-list --help-variable-list --help-property-list --help-command-list`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const tmp = stdout.trim().split('\n\n\n');
        return [
            tmp[0].split('\n'),
            tmp[1].split('\n'),
            tmp[2].split('\n'),
            tmp[3].split('\n'),
            tmp[4].split('\n'),
        ];
    }
}
