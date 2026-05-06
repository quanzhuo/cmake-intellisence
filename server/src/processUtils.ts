import * as cp from 'child_process';
import * as path from 'path';

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export interface ExecFileResult {
    stdout: string;
    stderr: string;
}

export interface ExecFileFailure extends Error {
    stdout: string;
    stderr: string;
    code?: number | string | null;
    signal?: NodeJS.Signals | null;
}

export function execFilePromise(file: string, args: string[], options?: cp.ExecFileOptions): Promise<ExecFileResult> {
    // On Windows, .bat and .cmd files cannot be launched directly by CreateProcess —
    // Node.js raises EINVAL.  Route them through cmd.exe /c so they execute correctly.
    let actualFile = file;
    let actualArgs = args;
    if (process.platform === 'win32') {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.bat' || ext === '.cmd') {
            actualArgs = ['/c', file, ...args];
            actualFile = process.env['ComSpec'] ?? 'cmd.exe';
        }
    }

    return new Promise((resolve, reject) => {
        cp.execFile(
            actualFile,
            actualArgs,
            {
                encoding: 'utf8',
                timeout: DEFAULT_EXEC_TIMEOUT_MS,
                maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
                ...(options ?? {}),
            },
            (error, stdout, stderr) => {
                const stdoutText = String(stdout);
                const stderrText = String(stderr);

                if (error) {
                    const failure = Object.assign(new Error(error.message), {
                        name: error.name,
                        stdout: stdoutText,
                        stderr: stderrText,
                        code: error.code,
                        signal: error.signal,
                    }) as ExecFileFailure;
                    reject(failure);
                    return;
                }

                resolve({ stdout: stdoutText, stderr: stderrText });
            }
        );
    });
}