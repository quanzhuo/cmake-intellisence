import * as cp from 'child_process';

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
    return new Promise((resolve, reject) => {
        cp.execFile(
            file,
            args,
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