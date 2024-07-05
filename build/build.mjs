import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

async function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(command, args, {
            stdio: 'inherit',
            shell: true,
        });

        console.log(`Running command: ${command} ${args.join(' ')}`);

        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with code ${code}`));
            }
        });
    });
}

class PackageStep {
    constructor(folder) {
        this.folder = folder;
        this.packageJson = path.join(folder, 'package.json');
        this.packageJsonData = JSON.parse(fs.readFileSync(this.packageJson));
        this.version = this.packageJsonData.version;
        this.name = this.packageJsonData.name;
        this.vsixName = `${this.name}-${this.version}.vsix`;
    }
    modifyPackageJson() { }
    addDepends() { }
    renameVsix() { }
    async postSetup() {
        console.log('rename vsixs...');
        this.renameVsix();
        console.log('restore workspace...');
        await runCommand('git', ['restore', '.']);
        await runCommand('git', ['clean', '-fdx', '-e', '*.vsix', '-e', 'node_modules']);
    }

    async run() {
        console.log('modify package.json...');
        this.modifyPackageJson();
        fs.writeFileSync(this.packageJson, JSON.stringify(this.packageJsonData, null, 2));
        this.addDepends();
        await runCommand('vsce', ['package']);
        await this.postSetup();
    }
}

class KylinIdePackage extends PackageStep {
    constructor(folder) {
        super(folder);
    }

    modifyPackageJson() {
        this.packageJsonData.downloadUrl = 'https://gitee.com/openkylin/cmake-intellisence/releases';
        this.packageJsonData.keywords = [
            "KylinIdeDev",
            "KylinIdeDevEdit",
            "KylinIdeDevCYuYan",
            "KylinIdeDevCPlusPlus",
            "KylinIdeDevOtherLanguages"
        ];
        this.packageJsonData.description = "CMake IntelliSence for Kylin-IDE";
    }

    renameVsix() {
        const kyVsix = path.join(this.folder, `${this.name}-Kylin-IDE-${this.version}.vsix`);
        fs.renameSync(path.join(this.folder, this.vsixName), kyVsix);
    }

    addDepends() {
        console.log('add depends.json for Kylin-IDE...');
        const depends = {
            deb: {
                default_arch: {
                    default_os: {
                        cmake: {},
                    }
                }
            },
            rpm: {
                default_arch: {
                    default_os: {
                        cmake: {},
                    }
                }
            }
        };

        fs.writeFileSync(path.join(this.folder, 'depends.json'), JSON.stringify(depends, null, 4));
    }
}

class VSCodePackage extends PackageStep {
    constructor(folder) {
        super(folder);
    }

    modifyPackageJson() {
        this.packageJsonData.keywords = [
            "CMake",
            "C++",
            "development",
        ];
        this.packageJsonData.description = "CMake IntelliSence for Visual Studio Code";
    }

    renameVsix() {
        const vscVsix = path.join(this.folder, `${this.name}-VSCode-${this.version}.vsix`);
        fs.renameSync(path.join(this.folder, this.vsixName), vscVsix);
    }
}

console.log('clean workspace...');
await runCommand('git', ['clean', '-fdx']);
await runCommand('npm', ['i', '--registry=http://registry.npmmirror.com']);
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const workspace = path.join(__dirname, '..');
let packageTool = new KylinIdePackage(workspace);
await packageTool.run();
packageTool = new VSCodePackage(workspace);
await packageTool.run();
