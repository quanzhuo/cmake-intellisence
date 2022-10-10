import * as cp from 'child_process';

export type Entries = [string, string, string, string];

export function getBuiltinEntries(): Entries {
    const args = ['cmake', '--help-module-list', '--help-policy-list',
        '--help-variable-list', '--help-property-list'];
    const cmd: string = args.join(' ');
    const output = cp.execSync(cmd, { encoding: 'utf-8' });
    return output.trim().split('\n\n\n') as Entries;
}