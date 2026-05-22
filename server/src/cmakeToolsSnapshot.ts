export const READY_NOTIFICATION = 'cmakeIntelliSense/serverReady';
export const CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION = 'cmakeIntelliSense/cmakeToolsProjectSnapshotChanged';

export type CMakeToolsProjectSnapshot = {
    workspaceFolderUri: string;
    sourceUri?: string;
    projectId: string;
    buildDirectory?: string;
    activeBuildType?: string;
    useCMakePresets: boolean;
    configurePresetName?: string;
    buildPresetName?: string;
    testPresetName?: string;
    packagePresetName?: string;
    targetNames: string[];
    testNames: string[];
    codeModelSummary?: {
        hasCodeModel: boolean;
    };
    generation: number;
    sourceKind: 'kylin-cmake-tools' | 'ms-vscode-cmake-tools';
};

export type CMakeToolsProjectSnapshotNotificationParams = {
    workspaceFolderUri: string;
    snapshot: CMakeToolsProjectSnapshot | null;
};