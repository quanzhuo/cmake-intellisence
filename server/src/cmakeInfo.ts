import * as cp from 'child_process';
import { promisify } from 'util';

type Modules = string[];
type Policies = string[];
type Variables = string[];
type Properties = string[];

export class CMakeInfo {
    public version: string;
    public major: number;
    public minor: number;
    public patch: number;
    public modules: string[] = [];
    public policies: string[] = [];
    public variables: string[] = [];
    public properties: string[] = [];

    constructor(public cmakePath: string) { }

    public async init() {
        [
            [this.version, this.major, this.minor, this.patch],
            [this.modules, this.policies, this.variables, this.properties]
        ] = await Promise.all([this.getCMakeVersion(), this.getBuiltinEntries()]);
    }

    private async getCMakeVersion(): Promise<[string, number, number, number]> {
        const command = this.cmakePath + " --version";
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

    private async getBuiltinEntries(): Promise<[Modules, Policies, Variables, Properties]> {
        const command = this.cmakePath + " --help-module-list --help-policy-list --help-variable-list --help-property-list";
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const tmp = stdout.trim().split('\n\n\n');
        return [
            tmp[0].split('\n'),
            tmp[1].split('\n'),
            tmp[2].split('\n'),
            tmp[3].split('\n'),
        ];
    }
}
