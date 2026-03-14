export interface CancellationLike {
    readonly isCancellationRequested: boolean;
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