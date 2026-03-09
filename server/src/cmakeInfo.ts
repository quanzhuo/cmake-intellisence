import { ParseTreeWalker } from 'antlr4';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as which from 'which';
import { ProjectInfo } from './completion';
import { FlatCommand, extractFlatCommands } from './flatCommands';
import { FileContext } from './generated/CMakeParser';
import { getFileContent, getFileContext } from './utils';

type Modules = string[];
type Policies = string[];
type Variables = string[];
type Properties = string[];
type Commands = string[];

export interface ExtensionSettings {
    loggingLevel: string;
    cmakePath: string;
    pkgConfigPath: string;
    cmdCaseDiagnostics: boolean;
}

export class CMakeInfo {
    public version?: string;
    public major?: number;
    public minor?: number;
    public patch?: number;
    public modules: string[] = [];
    public policies: string[] = [];
    public variables: string[] = [];
    public properties: string[] = [];
    public commands: string[] = [];
    public pkgConfigModules: Map<string, string> = new Map<string, string>();
    public cmakePath: string;
    public cmakeModulePath?: string;
    public pkgConfigPath: string;

    constructor(extSettings: ExtensionSettings) {
        this.cmakePath = extSettings.cmakePath;
        this.pkgConfigPath = extSettings.pkgConfigPath;
    }

    public async init() {
        const absPath: string | null = which.sync(this.cmakePath, { nothrow: true });
        if (absPath === null) {
            throw new Error(`cmake not found: ${this.cmakePath}`);
        } else {
            this.cmakePath = absPath;
        }

        [
            [this.version, this.major, this.minor, this.patch],
            [this.modules, this.policies, this.variables, this.properties, this.commands]
        ] = await Promise.all([this.getCMakeVersion(), this.getBuiltinEntries()]);

        this.properties = [...new Set(this.properties)];

        const langVariables: string[] = [];
        const languages = ['C', 'CXX'];
        for (const variable of this.variables) {
            if (variable.includes('<LANG>')) {
                for (const lang of languages) {
                    langVariables.push(variable.replace('<LANG>', lang));
                }
            } else {
                langVariables.push(variable);
            }
        }
        this.variables = langVariables;
        this.variables = [...new Set(this.variables)];

        const cmakeRoot = await this.getCMakeRoot();
        console.log(`CMakeInfo.init, cmakeRoot: ${cmakeRoot}`);
        if (cmakeRoot) {
            this.cmakeModulePath = path.join(cmakeRoot, 'Modules');
        } else {
            console.error('CMake system module path not found.');
        }

        await this.initPkgConfigModules();
    }

    private async getCMakeRoot(): Promise<string | null> {
        const command = `"${this.cmakePath}" --system-information`;
        try {
            const { stdout } = await promisify(cp.exec)(command, { cwd: os.tmpdir() });
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
            // On Windows, if msvc is not installed, cmake --system-information may fail with follwing error:

            // -- Building for: NMake Makefiles
            // CMake Error at CMakeLists.txt:6 (project):
            //   Running
            //    'nmake' '-?'
            //   failed with:
            //    no such file or directory
            // CMake Error: CMAKE_C_COMPILER not set, after EnableLanguage
            // CMake Error: CMAKE_CXX_COMPILER not set, after EnableLanguage
            // Error: --system-information failed on internal CMake!
            const message = JSON.stringify(error);
            if (process.platform === 'win32' && message.includes('nmake') && message.includes('no such file or directory')) {
                for (const dir of ['cmake', `cmake-${this.major}.${this.minor}`]) {
                    const cmakeRoot = path.join(path.dirname(this.cmakePath), '..', 'share', dir);
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

    private async getCMakeVersion(): Promise<[string, number, number, number]> {
        const command = `"${this.cmakePath}" --version`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
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

    private async getBuiltinEntries(): Promise<[Modules, Policies, Variables, Properties, Commands]> {
        const command = `"${this.cmakePath}" --help-module-list --help-policy-list --help-variable-list --help-property-list --help-command-list`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        const tmp = stdout.trim().split('\n\n\n');
        const moduleCommands = ["add_file_dependencies", "android_add_test_data", "fixup_bundle", "copy_and_fixup_bundle", "verify_app", "get_bundle_main_executable", "get_dotapp_dir", "get_bundle_and_executable", "get_bundle_all_executables", "get_item_key", "clear_bundle_keys", "set_bundle_key_values", "get_bundle_keys", "copy_resolved_item_into_bundle", "copy_resolved_framework_into_bundle", "fixup_bundle_item", "verify_bundle_prerequisites", "verify_bundle_symlinks", "check_c_compiler_flag", "check_compiler_flag", "check_c_source_compiles", "check_c_source_runs", "check_cxx_compiler_flag", "check_cxx_source_compiles", "check_cxx_source_runs", "check_cxx_symbol_exists", "check_fortran_compiler_flag", "check_fortran_source_compiles", "check_fortran_source_runs", "check_function_exists", "cmake_push_check_state", "cmake_reset_check_state", "cmake_pop_check_state", "check_ipo_supported", "check_language", "check_linker_flag", "check_objc_compiler_flag", "check_objc_source_compiles", "check_objc_source_runs", "check_objcxx_compiler_flag", "check_objcxx_source_compiles", "check_objcxx_source_runs", "check_pie_supported", "check_prototype_definition", "check_source_compiles", "check_source_runs", "check_symbol_exists", "check_type_size", "cmake_add_fortran_subdirectory", "cmake_dependent_option", "DetermineVSServicePack", "find_dependency", "CMAKE_FORCE_Fortran_COMPILER", "configure_package_config_file", "write_basic_package_version_file", "generate_apple_platform_selection_file", "generate_apple_architecture_selection_file", "check_required_components", "cmake_print_properties", "cmake_print_variables", "cpack_add_component", "cpack_add_component_group", "cpack_add_install_type", "cpack_configure_downloads", "cpack_ifw_add_repository", "cpack_ifw_update_repository", "cpack_ifw_add_package_resources", "cpack_ifw_configure_file", "csharp_set_windows_forms_properties", "csharp_set_designer_cs_properties", "csharp_set_xaml_cs_properties", "csharp_get_filename_keys", "csharp_get_filename_key_base", "csharp_get_dependentupon_name", "ctest_coverage_collect_gcov", "ExternalData_Add_Target", "ExternalProject_Add", "ExternalProject_Get_Property", "ExternalProject_Add_Step", "ExternalProject_Add_StepTargets", "ExternalProject_Add_StepDependencies", "feature_summary", "set_package_properties", "add_feature_info", "set_package_info", "set_feature_info", "print_enabled_features", "print_disabled_features", "FetchContent_MakeAvailable", "FetchContent_GetProperties", "FetchContent_Populate", "FetchContent_Declare", "FetchContent_SetPopulated", "cuda_add_cufft_to_target", "cuda_add_cublas_to_target", "cuda_add_executable", "cuda_add_library", "cuda_build_clean_target", "cuda_compile", "cuda_compile_ptx", "cuda_compile_fatbin", "cuda_compile_cubin", "cuda_compute_separable_compilation_object_file_name", "cuda_include_directories", "cuda_link_separable_compilation_objects", "cuda_select_nvcc_arch_flags", "cuda_wrap_srcs", "doxygen_add_docs", "env_module", "env_module_swap", "env_module_list", "env_module_avail", "matlab_get_version_from_release_name", "matlab_get_release_name_from_version", "matlab_extract_all_installed_versions_from_registry", "matlab_get_all_valid_matlab_roots_from_registry", "matlab_get_mex_suffix", "matlab_get_version_from_matlab_run", "matlab_add_unit_test", "matlab_add_mex", "find_package_handle_standard_args", "find_package_check_version", "find_package_message", "pkg_check_modules", "pkg_search_module", "pkg_get_variable", "protobuf_generate_cpp", "protobuf_generate_python", "protobuf_generate", "squish_add_test", "Subversion_WC_INFO", "Subversion_WC_LOG", "xctest_add_bundle", "xctest_add_test", "FortranCInterface_VERIFY", "FortranCInterface_HEADER", "generate_export_header", "GNUInstallDirs_get_absolute_install_dir", "gtest_add_tests", "gtest_discover_tests", "ProcessorCount", "select_library_configurations", "test_big_endian", "add_jar", "install_jar", "install_jni_symlink", "create_javah", "install_jar_exports", "export_jars", "find_jar", "create_javadoc", "swig_add_library", "swig_link_libraries", "write_compiler_detection_header"];
        return [
            tmp[0].split('\n'),
            tmp[1].split('\n'),
            tmp[2].split('\n'),
            tmp[3].split('\n'),
            tmp[4].split('\n').concat(moduleCommands),
        ];
    }

    private async initPkgConfigModules(): Promise<void> {
        const pkgConfig = which.sync(this.pkgConfigPath, { nothrow: true });
        if (pkgConfig === null) {
            return;
        }

        const command = `"${pkgConfig}" --list-all`;
        const { stdout, stderr } = await promisify(cp.exec)(command);
        if (stdout.trim().length === 0) {
            return;
        }
        const lines = stdout.split('\n');
        for (const line of lines) {
            const firstSpace = line.indexOf(' ');
            const pkgName = line.substring(0, firstSpace);
            const description = line.substring(firstSpace).trimStart();
            this.pkgConfigModules.set(pkgName, description);
        }
    }
}

export class ProjectInfoListener {
    private commands: Set<string>;
    constructor(
        private cmakeInfo: CMakeInfo,
        private currentCMake: string,
        private baseDirectory: string,
        private fileContexts: Map<string, FileContext>,
        private documents: TextDocuments<TextDocument>,
        private parsedFiles: Set<string>,
        private workspaceFolder: string,
    ) {
        this.commands = new Set<string>(this.cmakeInfo.commands);
    }

    static projectInfo: ProjectInfo = {} as ProjectInfo;

    resetProjectInfo(): void {
        ProjectInfoListener.projectInfo = {} as ProjectInfo;
    }

    private project(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.projectName = args[0].getText();
        }
    }

    private addExecutable(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.executables = ProjectInfoListener.projectInfo.executables ?? new Set<string>();
            ProjectInfoListener.projectInfo.executables.add(args[0].getText());
        }
    }

    private addLibrary(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.libraries = ProjectInfoListener.projectInfo.libraries ?? new Set<string>();
            ProjectInfoListener.projectInfo.libraries.add(args[0].getText());
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
        // CMake builtin modules
        let targetCMakeFile: string | null = path.join(this.cmakeInfo.cmakeModulePath ?? '', `Find${packageName}.cmake`);
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

        let tree: FileContext;
        if (this.fileContexts.has(targetCMakeFile)) {
            tree = this.fileContexts.get(targetCMakeFile)!;
        } else {
            tree = getFileContext(getFileContent(this.documents, URI.parse(targetCMakeFile)));
            this.fileContexts.set(targetCMakeFile, tree);
        }
        const commands = extractFlatCommands(tree);
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.fileContexts, this.documents, this.parsedFiles, this.workspaceFolder);
        projectInfoListener.processCommands(commands);
    }

    private include(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length !== 1) {
            return;
        }
        const includeFile = args[0].getText();
        let targetCMakeFile = path.join(this.baseDirectory, includeFile);
        if (!fs.existsSync(targetCMakeFile)) {
            targetCMakeFile = path.join(this.cmakeInfo.cmakeModulePath ?? '', `${includeFile}.cmake`);
            if (!fs.existsSync(targetCMakeFile)) {
                return;
            }
        }

        targetCMakeFile = URI.file(targetCMakeFile).toString();
        if (this.parsedFiles.has(targetCMakeFile)) {
            return;
        }

        let tree: FileContext;
        if (this.fileContexts.has(targetCMakeFile)) {
            tree = this.fileContexts.get(targetCMakeFile)!;
        } else {
            tree = getFileContext(getFileContent(this.documents, URI.parse(targetCMakeFile)));
            this.fileContexts.set(targetCMakeFile, tree);
        }
        const commands = extractFlatCommands(tree);
        const projectInfoListener = new ProjectInfoListener(this.cmakeInfo, targetCMakeFile, this.baseDirectory, this.fileContexts, this.documents, this.parsedFiles, this.workspaceFolder);
        projectInfoListener.processCommands(commands);
    }

    private functionOrMacro(ctx: FlatCommand): void {
        const args = ctx.argument_list();
        if (args.length > 0) {
            ProjectInfoListener.projectInfo.functions = ProjectInfoListener.projectInfo.functions ?? new Set<string>();
            ProjectInfoListener.projectInfo.functions.add(args[0].getText());
        }
    }

    processCommands(commands: FlatCommand[]): void {
        for (const cmd of commands) {
            const commandName: string = cmd.commandName.toLowerCase();
            switch (commandName) {
                case 'project':
                    this.project(cmd);
                    break;
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
                case 'function':
                case 'macro':
                    this.functionOrMacro(cmd);
                    break;
                default:
                    break;
            }
        }
    }
}