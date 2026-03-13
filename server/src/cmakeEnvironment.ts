import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as which from 'which';
import { ProjectTargetInfo } from './completion';
import { FlatCommand } from './flatCommands';
import { FileSymbolCache, Symbol, SymbolIndex, SymbolKind } from './symbolIndex';
import { getIncludeFileUri } from './utils';

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

const moduleCommands = ["add_file_dependencies", "android_add_test_data", "fixup_bundle", "copy_and_fixup_bundle", "verify_app", "get_bundle_main_executable", "get_dotapp_dir", "get_bundle_and_executable", "get_bundle_all_executables", "get_item_key", "clear_bundle_keys", "set_bundle_key_values", "get_bundle_keys", "copy_resolved_item_into_bundle", "copy_resolved_framework_into_bundle", "fixup_bundle_item", "verify_bundle_prerequisites", "verify_bundle_symlinks", "check_c_compiler_flag", "check_compiler_flag", "check_c_source_compiles", "check_c_source_runs", "check_cxx_compiler_flag", "check_cxx_source_compiles", "check_cxx_source_runs", "check_cxx_symbol_exists", "check_fortran_compiler_flag", "check_fortran_source_compiles", "check_fortran_source_runs", "check_function_exists", "cmake_push_check_state", "cmake_reset_check_state", "cmake_pop_check_state", "check_ipo_supported", "check_language", "check_linker_flag", "check_objc_compiler_flag", "check_objc_source_compiles", "check_objc_source_runs", "check_objcxx_compiler_flag", "check_objcxx_source_compiles", "check_objcxx_source_runs", "check_pie_supported", "check_prototype_definition", "check_source_compiles", "check_source_runs", "check_symbol_exists", "check_type_size", "cmake_add_fortran_subdirectory", "cmake_dependent_option", "DetermineVSServicePack", "find_dependency", "CMAKE_FORCE_Fortran_COMPILER", "configure_package_config_file", "write_basic_package_version_file", "generate_apple_platform_selection_file", "generate_apple_architecture_selection_file", "check_required_components", "cmake_print_properties", "cmake_print_variables", "cpack_add_component", "cpack_add_component_group", "cpack_add_install_type", "cpack_configure_downloads", "cpack_ifw_add_repository", "cpack_ifw_update_repository", "cpack_ifw_add_package_resources", "cpack_ifw_configure_file", "csharp_set_windows_forms_properties", "csharp_set_designer_cs_properties", "csharp_set_xaml_cs_properties", "csharp_get_filename_keys", "csharp_get_filename_key_base", "csharp_get_dependentupon_name", "ctest_coverage_collect_gcov", "ExternalData_Add_Target", "ExternalProject_Add", "ExternalProject_Get_Property", "ExternalProject_Add_Step", "ExternalProject_Add_StepTargets", "ExternalProject_Add_StepDependencies", "feature_summary", "set_package_properties", "add_feature_info", "set_package_info", "set_feature_info", "print_enabled_features", "print_disabled_features", "FetchContent_MakeAvailable", "FetchContent_GetProperties", "FetchContent_Populate", "FetchContent_Declare", "FetchContent_SetPopulated", "cuda_add_cufft_to_target", "cuda_add_cublas_to_target", "cuda_add_executable", "cuda_add_library", "cuda_build_clean_target", "cuda_compile", "cuda_compile_ptx", "cuda_compile_fatbin", "cuda_compile_cubin", "cuda_compute_separable_compilation_object_file_name", "cuda_include_directories", "cuda_link_separable_compilation_objects", "cuda_select_nvcc_arch_flags", "cuda_wrap_srcs", "doxygen_add_docs", "env_module", "env_module_swap", "env_module_list", "env_module_avail", "matlab_get_version_from_release_name", "matlab_get_release_name_from_version", "matlab_extract_all_installed_versions_from_registry", "matlab_get_all_valid_matlab_roots_from_registry", "matlab_get_mex_suffix", "matlab_get_version_from_matlab_run", "matlab_add_unit_test", "matlab_add_mex", "find_package_handle_standard_args", "find_package_check_version", "find_package_message", "pkg_check_modules", "pkg_search_module", "pkg_get_variable", "protobuf_generate_cpp", "protobuf_generate_python", "protobuf_generate", "squish_add_test", "Subversion_WC_INFO", "Subversion_WC_LOG", "xctest_add_bundle", "xctest_add_test", "FortranCInterface_VERIFY", "FortranCInterface_HEADER", "generate_export_header", "GNUInstallDirs_get_absolute_install_dir", "gtest_add_tests", "gtest_discover_tests", "ProcessorCount", "select_library_configurations", "test_big_endian", "add_jar", "install_jar", "install_jni_symlink", "create_javah", "install_jar_exports", "export_jars", "find_jar", "create_javadoc", "swig_add_library", "swig_link_libraries", "write_compiler_detection_header"];

function execFilePromise(file: string, args: string[], options?: cp.ExecFileOptions): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        cp.execFile(file, args, { encoding: 'utf8', ...(options ?? {}) }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export async function initializeCMakeEnvironment(extSettings: ExtensionSettings, symbolIndex: SymbolIndex): Promise<void> {
    const cmakePath = resolveExecutablePath(extSettings.cmakePath, 'cmake');
    const [version, builtinEntries, pkgConfigModules] = await Promise.all([
        getCMakeVersion(cmakePath),
        getBuiltinEntries(cmakePath),
        getPkgConfigModules(extSettings.pkgConfigPath),
    ]);
    const [modules, policies, variables, properties, commands] = builtinEntries;
    const uri = 'cmake-builtin://system';
    const systemCache = new FileSymbolCache(uri);

    for (const command of commands) {
        systemCache.addCommand(new Symbol(command, SymbolKind.BuiltinCommand, uri, 0, 0));
    }
    for (const variable of expandVariables(variables)) {
        systemCache.addVariable(new Symbol(variable, SymbolKind.BuiltinVariable, uri, 0, 0));
    }
    for (const moduleName of modules) {
        systemCache.addModule(new Symbol(moduleName, SymbolKind.Module, uri, 0, 0));
    }
    for (const policy of policies) {
        systemCache.addPolicy(new Symbol(policy, SymbolKind.Policy, uri, 0, 0));
    }
    for (const property of expandProperties(properties)) {
        systemCache.addProperty(new Symbol(property, SymbolKind.Property, uri, 0, 0));
    }

    symbolIndex.cmakePath = cmakePath;
    symbolIndex.pkgConfigPath = extSettings.pkgConfigPath;
    symbolIndex.pkgConfigModules = pkgConfigModules;
    symbolIndex.cmakeModulePath = await getCMakeModulePath(cmakePath, version[1], version[2]);
    symbolIndex.setSystemCache(systemCache);
}

function resolveExecutablePath(executable: string, label: string): string {
    const absPath: string | null = which.sync(executable, { nothrow: true });
    if (absPath === null) {
        throw new Error(`${label} not found: ${executable}`);
    }
    return absPath;
}

function expandVariables(variables: Set<string>): Set<string> {
    const expandedVariables = new Set<string>();
    const languages = ['C', 'CXX'];
    const buildTypes = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];

    const countLeftAngle = (str: string): number => (str.match(/</g)?.length ?? 0);

    for (const variable of variables) {
        const angleCount = countLeftAngle(variable);

        if (angleCount === 0) {
            expandedVariables.add(variable);
        } else if (angleCount === 1) {
            if (variable.includes('<LANG>')) {
                for (const lang of languages) {
                    expandedVariables.add(variable.replace('<LANG>', lang));
                }
            } else if (variable.includes('<CONFIG>')) {
                for (const buildType of buildTypes) {
                    expandedVariables.add(variable.replace('<CONFIG>', buildType));
                }
            } else {
                // FIXME: <PROJECT-NAME> <PackageName> <FETAURE> <n> <NNNN> <an-attribute>
                // 这些情况暂不处理
                expandedVariables.add(variable);
            }
        } else if (angleCount === 2) {
            if (variable.includes('<LANG>') && variable.includes('<CONFIG>')) {
                for (const lang of languages) {
                    for (const buildType of buildTypes) {
                        expandedVariables.add(variable.replace('<LANG>', lang).replace('<CONFIG>', buildType));
                    }
                }
            } else {
                // FIXME: 其他包含两个尖括号的变量，暂不处理
                // 1. <LANG> 和 <FEATURE>
                // 2. <LANG> 和 <TYPE>
                expandedVariables.add(variable);
            }
        } else {
            // 包含三个或以上尖括号的变量，暂不处理
            expandedVariables.add(variable);
        }
    }
    return expandedVariables;
}

function expandProperties(properties: Set<string>): Set<string> {
    const expandedProperties = new Set<string>();
    const languages = ['C', 'CXX'];
    const buildTypes = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];
    const countLeftAngle = (str: string): number => (str.match(/</g)?.length ?? 0);
    for (const property of properties) {
        const angleCount = countLeftAngle(property);
        if (angleCount === 0) {
            expandedProperties.add(property);
        } else if (angleCount === 1) {
            if (property.includes('<LANG>')) {
                for (const lang of languages) {
                    expandedProperties.add(property.replace('<LANG>', lang));
                }
            } else if (property.includes('<CONFIG>')) {
                for (const buildType of buildTypes) {
                    expandedProperties.add(property.replace('<CONFIG>', buildType));
                }
            } else {
                // FIXME: <NAME> <LIBRARY> <tagname> <refname> <variable> <section> <tool> <an-attribute>
                expandedProperties.add(property);
            }
        } else {
            // FIXME: <tagname> 和 <refname> 可能会出现在同一个属性中，暂不处理
            expandedProperties.add(property);
        }
    }
    return expandedProperties;
}

async function getCMakeModulePath(cmakePath: string, major: number, minor: number): Promise<string | undefined> {
    const cmakeRoot = await getCMakeRoot(cmakePath, major, minor);
    return cmakeRoot ? path.join(cmakeRoot, 'Modules') : undefined;
}

async function getCMakeRoot(cmakePath: string, major: number, minor: number): Promise<string | null> {
    try {
        const { stdout } = await execFilePromise(cmakePath, ['--system-information'], { cwd: os.tmpdir() });
        const lines = stdout.split('\n');
        for (const line of lines) {
            if (line.startsWith('CMAKE_ROOT')) {
                const startQuote = line.indexOf('"');
                const endQuote = line.lastIndexOf('"');
                if (startQuote !== -1 && endQuote !== -1 && startQuote < endQuote) {
                    return line.substring(startQuote + 1, endQuote);
                }
                return null;
            }
        }
    } catch (error) {
        if (process.platform === 'win32') {
            for (const dir of ['cmake', `cmake-${major}.${minor}`]) {
                const cmakeRoot = path.join(path.dirname(cmakePath), '..', 'share', dir);
                if (fs.existsSync(cmakeRoot)) {
                    return path.normalize(cmakeRoot);
                }
            }
        } else {
            throw error;
        }
    }
    return null;
}

async function getCMakeVersion(cmakePath: string): Promise<[string, number, number, number]> {
    const { stdout } = await execFilePromise(cmakePath, ['--version']);
    const regexp: RegExp = /(\d+)\.(\d+)\.(\d+)/;
    const res = stdout.match(regexp);
    if (!res) {
        throw new Error(`Failed to parse cmake version from: ${stdout}`);
    }
    return [
        res[0],
        parseInt(res[1]),
        parseInt(res[2]),
        parseInt(res[3])
    ];
}

async function getBuiltinEntries(cmakePath: string): Promise<[Set<string>, Set<string>, Set<string>, Set<string>, Set<string>]> {
    const { stdout } = await execFilePromise(cmakePath, ['--help-module-list', '--help-policy-list', '--help-variable-list', '--help-property-list', '--help-command-list']);
    const tmp = stdout.trim().split('\n\n\n');
    return [
        new Set(tmp[0].split('\n')),
        new Set(tmp[1].split('\n')),
        new Set(tmp[2].split('\n')),
        new Set(tmp[3].split('\n')),
        new Set([...tmp[4].split('\n'), ...moduleCommands]),
    ];
}

async function getPkgConfigModules(pkgConfigPath: string): Promise<Map<string, string>> {
    const modules = new Map<string, string>();
    const pkgConfig = which.sync(pkgConfigPath, { nothrow: true });
    if (pkgConfig === null) {
        return modules;
    }

    const { stdout } = await execFilePromise(pkgConfig, ['--list-all']);
    if (stdout.trim().length === 0) {
        return modules;
    }

    for (const line of stdout.split('\n')) {
        const firstSpace = line.indexOf(' ');
        if (firstSpace <= 0) {
            continue;
        }
        const pkgName = line.substring(0, firstSpace);
        const description = line.substring(firstSpace).trimStart();
        modules.set(pkgName, description);
    }
    return modules;
}

export class ProjectTargetInfoListener {
    targetInfo: ProjectTargetInfo;

    constructor(
        private symbolIndex: SymbolIndex,
        private currentCMake: string,
        private baseDirectory: string,
        private loadFlatCommands: (uri: string) => FlatCommand[],
        private parsedFiles: Set<string>,
        private workspaceFolder: string,
        targetInfo?: ProjectTargetInfo,
    ) {
        this.targetInfo = targetInfo ?? {} as ProjectTargetInfo;
    }

    private addExecutable(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            this.targetInfo.executables = this.targetInfo.executables ?? new Set<string>();
            this.targetInfo.executables.add(args[0].getText());
        }
    }

    private addLibrary(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            this.targetInfo.libraries = this.targetInfo.libraries ?? new Set<string>();
            this.targetInfo.libraries.add(args[0].getText());
        }
    }

    private findConfigPackage(packageName: string): string | null {
        const cmakeCacheFile = path.join(this.workspaceFolder, 'build', 'CMakeCache.txt');
        if (!fs.existsSync(cmakeCacheFile)) {
            return null;
        }
        const content = fs.readFileSync(cmakeCacheFile, 'utf-8');
        const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escapedName}_DIR:PATH=(.*)$`, 'm');
        const match = content.match(regex);
        const packageDir = match ? match[1] : null;
        if (!packageDir) {
            return null;
        }
        const alternatives = [
            path.join(packageDir, 'lib', 'cmake', packageName, `${packageName}Config.cmake`),
            path.join(packageDir, 'lib', 'cmake', packageName, `${packageName.toLowerCase()}-config.cmake`),
            path.join(packageDir, `${packageName}Config.cmake`),
            path.join(packageDir, `${packageName.toLowerCase()}-config.cmake`),
        ];

        for (const pkgConfig of alternatives) {
            if (fs.existsSync(pkgConfig)) {
                return pkgConfig;
            }
        }
        return null;
    }

    private findPackage(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length <= 0) {
            return;
        }

        const packageName = args[0].getText();
        let targetCMakeFile: string | null = path.join(this.symbolIndex.cmakeModulePath ?? '', `Find${packageName}.cmake`);
        if (!fs.existsSync(targetCMakeFile)) {
            targetCMakeFile = this.findConfigPackage(packageName);
            if (!targetCMakeFile) {
                return;
            }
        }

        targetCMakeFile = URI.file(targetCMakeFile).toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo);
        targetInfoListener.processCommands(commands);
    }

    private include(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length !== 1) {
            return;
        }
        const includeFile = args[0].getText();
        const includeUri = getIncludeFileUri(this.symbolIndex, URI.file(this.baseDirectory), includeFile);
        if (!includeUri) {
            return;
        }

        const targetCMakeFile = includeUri.toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        const commands = this.loadFlatCommands(targetCMakeFile);
        const nextBaseDirectory = path.dirname(URI.parse(targetCMakeFile).fsPath);
        const targetInfoListener = new ProjectTargetInfoListener(this.symbolIndex, targetCMakeFile, nextBaseDirectory, this.loadFlatCommands, this.parsedFiles, this.workspaceFolder, this.targetInfo);
        targetInfoListener.processCommands(commands);
    }

    processCommands(commands: FlatCommand[]): void {
        if (this.parsedFiles.has(this.currentCMake)) {
            return;
        }
        this.parsedFiles.add(this.currentCMake);

        for (const cmd of commands) {
            const commandName: string = cmd.commandName.toLowerCase();
            switch (commandName) {
                case 'add_executable':
                    this.addExecutable(cmd);
                    break;
                case 'add_library':
                    this.addLibrary(cmd);
                    break;
                case 'find_package':
                    this.findPackage(cmd);
                    break;
                case 'include':
                    this.include(cmd);
                    break;
                default:
                    break;
            }
        }
    }
}