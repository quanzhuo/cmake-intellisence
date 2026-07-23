export interface CancellationLike {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export class RequestCancelledError extends Error {
    constructor() {
        super('Request cancelled');
        this.name = 'RequestCancelledError';
    }
}

export function isCancellationRequested(tokenOrCheck?: CancellationLike | (() => boolean)): boolean {
    if (!tokenOrCheck) {
        return false;
    }

    if (typeof tokenOrCheck === 'function') {
        return tokenOrCheck();
    }

    return tokenOrCheck.isCancellationRequested;
}

export function throwIfCancelled(tokenOrCheck?: CancellationLike | (() => boolean)): void {
    if (isCancellationRequested(tokenOrCheck)) {
        throw new RequestCancelledError();
    }
}

export function isCancellationError(error: unknown): error is RequestCancelledError {
    return error instanceof RequestCancelledError;
}

export async function waitForCancellation<T>(request: PromiseLike<T>, token?: CancellationLike): Promise<T> {
    throwIfCancelled(token);
    if (!token?.onCancellationRequested) {
        return request;
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let cancellation: { dispose(): void } | undefined;
        cancellation = token.onCancellationRequested!(() => {
            if (settled) {
                return;
            }
            settled = true;
            cancellation?.dispose();
            reject(new RequestCancelledError());
        });
        if (settled) {
            cancellation.dispose();
        }

        Promise.resolve(request).then(
            value => {
                if (settled) {
                    return;
                }
                settled = true;
                cancellation?.dispose();
                resolve(value);
            },
            error => {
                if (settled) {
                    return;
                }
                settled = true;
                cancellation?.dispose();
                reject(error);
            },
        );
    });
}
