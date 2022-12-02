/**
 * This module defines important directories and paths to the extension
 * copy from vscode-cmake-tools
 */

import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

const promisify = util.promisify;
export const stat = promisify(fs.stat);
export const mkdir = promisify(fs.mkdir);

/**
 * Try and stat() a file/folder. If stat() fails for *any reason*, returns `null`.
 * @param filePath The file to try and stat()
 */
export async function tryStat(filePath: fs.PathLike): Promise<fs.Stats | null> {
    try {
        return await stat(filePath);
    } catch (_e) {
        // Don't even bother with the error. Any number of things might have gone
        // wrong. Probably one of: Non-existing file, bad permissions, bad path.
        return null;
    }
}

export async function exists(filePath: string): Promise<boolean> {
    const stat = await tryStat(filePath);
    return stat !== null;
}

/**
 * Creates a directory and all parent directories recursively. If the file
 * already exists, and is not a directory, just return.
 * @param fspath The directory to create
 */
export async function mkdir_p(fspath: string): Promise<void> {
    const parent = path.dirname(fspath);
    if (!await exists(parent)) {
        await mkdir_p(parent);
    } else {
        if (!(await stat(parent)).isDirectory()) {
            throw new Error(`cannot.create.path', 'Cannot create ${fspath}: ${fspath} is a non-directory`);
        }
    }
    if (!await exists(fspath)) {
        await mkdir(fspath);
    } else {
        if (!(await stat(fspath)).isDirectory()) {
            throw new Error(`cannot.create.directory', 'Cannot create directory ${fspath}. It exists, and is not a directory!`);
        }
    }
}

class WindowsEnvironment {
    get AppData(): string | undefined {
        return process.env['APPDATA'];
    }

    get LocalAppData(): string | undefined {
        return process.env['LOCALAPPDATA'];
    }

    get AllUserProfile(): string | undefined {
        return process.env['ProgramData'];
    }

    get ComSpec(): string {
        let comSpec = process.env['ComSpec'];

        if (undefined === comSpec) {
            comSpec = this.SystemRoot! + '\\system32\\cmd.exe';
        }

        return comSpec;
    }

    get HomeDrive(): string | undefined {
        return process.env['HOMEDRIVE'];
    }

    get HomePath(): string | undefined {
        return process.env['HOMEPATH'];
    }

    get ProgramFilesX86(): string | undefined {
        return process.env['ProgramFiles(x86)'];
    }

    get ProgramFiles(): string | undefined {
        return process.env['ProgramFiles'];
    }

    get SystemDrive(): string | undefined {
        return process.env['SystemDrive'];
    }

    get SystemRoot(): string | undefined {
        return process.env['SystemRoot'];
    }

    get Temp(): string | undefined {
        return process.env['TEMP'];
    }
}

/**
 * Directory class.
 */
class Paths {
    private _ninjaPath?: string;

    readonly windows: WindowsEnvironment = new WindowsEnvironment();

    /**
     * The current user's home directory
     */
    get userHome(): string {
        if (process.platform === 'win32') {
            return path.join(process.env['HOMEDRIVE'] || 'C:', process.env['HOMEPATH'] || 'Users\\Public');
        } else {
            return process.env['HOME'] || process.env['PROFILE']!;
        }
    }

    /**
     * The user-local data directory. This is where user-specific persistent
     * application data should be stored.
     */
    get userLocalDir(): string {

        if (process.platform === 'win32') {
            return this.windows.LocalAppData!;
        } else {
            const xdg_dir = process.env['XDG_DATA_HOME'];
            if (xdg_dir) {
                return xdg_dir;
            }
            const home = this.userHome;
            return path.join(home, '.local/share');
        }
    }

    get userRoamingDir(): string {
        if (process.platform === 'win32') {
            return this.windows.AppData!;
        } else {
            const xdg_dir = process.env['XDG_CONFIG_HOME'];
            if (xdg_dir) {
                return xdg_dir;
            }
            const home = this.userHome;
            return path.join(home, '.config');
        }
    }

    /**
     * The directory where CMake Tools should store user-specific persistent
     * data.
     */
    get dataDir(): string {
        return path.join(this.userLocalDir, 'cmake-intellisence');
    }

    /**
     * The "roaming" directory where CMake Tools stores roaming configuration
     * data.
     */
    get roamingDataDir(): string {
        return path.join(this.userRoamingDir, 'cmake-intellisence');
    }

    /**
     * Get the platform-specific temporary directory
     */
    get tmpDir(): string {
        if (process.platform === 'win32') {
            return this.windows.Temp!;
        } else {
            return '/tmp';
        }
    }

    get ninjaPath() {
        return this._ninjaPath;
    }
}

const paths = new Paths();
export default paths;
