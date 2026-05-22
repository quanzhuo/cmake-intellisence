import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { Logger } from './logging';

export const READY_NOTIFICATION = 'cmakeIntelliSense/serverReady';
export const CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION = 'cmakeIntelliSense/cmakeToolsProjectSnapshotChanged';

const KYLIN_CMAKE_TOOLS_EXTENSION_ID = 'KylinIdeTeam.kylin-cmake-tools';
const MICROSOFT_CMAKE_TOOLS_EXTENSION_ID = 'ms-vscode.cmake-tools';
const CMAKE_TOOLS_API_VERSION = 5;

type CMakeToolsSourceKind = 'kylin-cmake-tools' | 'ms-vscode-cmake-tools';

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
    sourceKind: CMakeToolsSourceKind;
};

type CMakeToolsProjectSnapshotNotificationParams = {
    workspaceFolderUri: string;
    snapshot: CMakeToolsProjectSnapshot | null;
};

type ExternalCMakeToolsExtensionExports = {
    getApi(version: number): ExternalCMakeToolsApi;
};

type ExternalCMakeToolsApi = {
    onActiveProjectChanged?: vscode.Event<vscode.Uri | undefined>;
    getProject(uri: vscode.Uri): Promise<ExternalCMakeToolsProject | undefined>;
};

type ExternalNamedEntity = {
    name?: string;
};

type ExternalCMakeToolsProject = {
    codeModel?: unknown;
    onCodeModelChanged?: vscode.Event<void>;
    onSelectedConfigurationChanged?: vscode.Event<unknown>;
    configurePreset?: ExternalNamedEntity;
    buildPreset?: ExternalNamedEntity;
    testPreset?: ExternalNamedEntity;
    packagePreset?: ExternalNamedEntity;
    useCMakePresets?: boolean;
    getBuildDirectory(): Promise<string | undefined>;
    getActiveBuildType(): Promise<string | undefined>;
    listBuildTargets(): Promise<string[] | undefined>;
    listTests(): Promise<string[] | undefined>;
};

export class CMakeToolsSnapshotBridge implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly projectDisposables = new Map<string, vscode.Disposable[]>();
    private readonly trackedProjects = new Map<string, ExternalCMakeToolsProject | undefined>();
    private readonly lastPublishedSnapshots = new Map<string, CMakeToolsProjectSnapshot | null>();
    private providerExtensionId?: string;
    private providerApi?: ExternalCMakeToolsApi;
    private providerDisposable?: vscode.Disposable;
    private serverReady = false;

    constructor(
        private readonly client: LanguageClient,
        private readonly logger: Logger,
    ) {
        this.client.onNotification(READY_NOTIFICATION, () => {
            void this.handleServerReady();
        });

        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                void this.ensureAttachedAndRefresh('workspace-folders-changed');
            }),
        );
    }

    dispose(): void {
        this.providerDisposable?.dispose();
        this.providerDisposable = undefined;
        this.disposeTrackedProjects();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async handleServerReady(): Promise<void> {
        this.serverReady = true;
        await this.ensureAttachedAndRefresh('server-ready');
    }

    private async ensureAttachedAndRefresh(reason: string): Promise<void> {
        const providerExtension = this.getPreferredProviderExtension();
        if (!providerExtension) {
            this.detachProvider();
            await this.publishNullSnapshots('provider-not-installed');
            return;
        }

        if (!providerExtension.isActive) {
            this.detachProvider();
            await this.publishNullSnapshots('provider-not-active');
            return;
        }

        if (!this.attachProviderApi(providerExtension)) {
            await this.publishNullSnapshots('provider-api-unavailable');
            return;
        }

        await this.refreshAllWorkspaces(reason);
    }

    private getPreferredProviderExtension(): vscode.Extension<ExternalCMakeToolsExtensionExports> | undefined {
        const preferred = vscode.extensions.getExtension<ExternalCMakeToolsExtensionExports>(KYLIN_CMAKE_TOOLS_EXTENSION_ID);
        if (preferred) {
            return preferred;
        }

        return vscode.extensions.getExtension<ExternalCMakeToolsExtensionExports>(MICROSOFT_CMAKE_TOOLS_EXTENSION_ID);
    }

    private attachProviderApi(providerExtension: vscode.Extension<ExternalCMakeToolsExtensionExports>): boolean {
        if (this.providerExtensionId === providerExtension.id && this.providerApi) {
            return true;
        }

        this.detachProvider();

        const api = providerExtension.exports?.getApi?.(CMAKE_TOOLS_API_VERSION);
        if (!api) {
            this.logger.warn(`CMake Tools API is unavailable from ${providerExtension.id}`);
            return false;
        }

        this.providerExtensionId = providerExtension.id;
        this.providerApi = api;
        this.providerDisposable = api.onActiveProjectChanged?.(() => {
            void this.refreshAllWorkspaces('active-project-changed');
        });
        this.logger.info(`Attached CMake Tools bridge to ${providerExtension.id}`);
        return true;
    }

    private detachProvider(): void {
        this.providerDisposable?.dispose();
        this.providerDisposable = undefined;
        this.providerExtensionId = undefined;
        this.providerApi = undefined;
        this.disposeTrackedProjects();
    }

    private disposeTrackedProjects(): void {
        for (const disposables of this.projectDisposables.values()) {
            for (const disposable of disposables) {
                disposable.dispose();
            }
        }
        this.projectDisposables.clear();
        this.trackedProjects.clear();
    }

    private async refreshAllWorkspaces(reason: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const workspaceFolder of workspaceFolders) {
            await this.publishWorkspaceSnapshot(workspaceFolder, this.getPreferredUriForWorkspace(workspaceFolder), reason);
        }
    }

    private getPreferredUriForWorkspace(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)?.uri.toString() === workspaceFolder.uri.toString()) {
            return activeEditor.document.uri;
        }

        return workspaceFolder.uri;
    }

    private async publishWorkspaceSnapshot(
        workspaceFolder: vscode.WorkspaceFolder,
        sourceUri: vscode.Uri,
        reason: string,
    ): Promise<void> {
        if (!this.serverReady || !this.client.isRunning()) {
            return;
        }

        const workspaceFolderUri = workspaceFolder.uri.toString();
        const project = await this.providerApi?.getProject(sourceUri);
        this.trackProject(workspaceFolderUri, workspaceFolder, project);

        if (!project || !this.providerExtensionId) {
            this.sendSnapshot({ workspaceFolderUri, snapshot: null }, reason);
            return;
        }

        const snapshot = await this.createSnapshot(workspaceFolder, sourceUri, project, this.providerExtensionId);
        this.sendSnapshot({ workspaceFolderUri, snapshot }, reason);
    }

    private trackProject(
        workspaceFolderUri: string,
        workspaceFolder: vscode.WorkspaceFolder,
        project: ExternalCMakeToolsProject | undefined,
    ): void {
        const trackedProject = this.trackedProjects.get(workspaceFolderUri);
        if (trackedProject === project) {
            return;
        }

        const currentDisposables = this.projectDisposables.get(workspaceFolderUri) ?? [];
        for (const disposable of currentDisposables) {
            disposable.dispose();
        }
        this.projectDisposables.delete(workspaceFolderUri);

        if (!project) {
            this.trackedProjects.set(workspaceFolderUri, undefined);
            return;
        }

        const disposables: vscode.Disposable[] = [];
        if (project.onCodeModelChanged) {
            disposables.push(project.onCodeModelChanged(() => {
                void this.publishWorkspaceSnapshot(workspaceFolder, this.getPreferredUriForWorkspace(workspaceFolder), 'code-model-changed');
            }));
        }
        if (project.onSelectedConfigurationChanged) {
            disposables.push(project.onSelectedConfigurationChanged(() => {
                void this.publishWorkspaceSnapshot(workspaceFolder, this.getPreferredUriForWorkspace(workspaceFolder), 'selected-configuration-changed');
            }));
        }

        this.trackedProjects.set(workspaceFolderUri, project);
        this.projectDisposables.set(workspaceFolderUri, disposables);
    }

    private async createSnapshot(
        workspaceFolder: vscode.WorkspaceFolder,
        sourceUri: vscode.Uri,
        project: ExternalCMakeToolsProject,
        providerExtensionId: string,
    ): Promise<CMakeToolsProjectSnapshot> {
        const [buildDirectory, activeBuildType, targetNames, testNames] = await Promise.all([
            project.getBuildDirectory(),
            project.getActiveBuildType(),
            project.listBuildTargets(),
            project.listTests(),
        ]);

        const sourceKind: CMakeToolsSourceKind = providerExtensionId === KYLIN_CMAKE_TOOLS_EXTENSION_ID
            ? 'kylin-cmake-tools'
            : 'ms-vscode-cmake-tools';

        return {
            workspaceFolderUri: workspaceFolder.uri.toString(),
            sourceUri: sourceUri.toString(),
            projectId: `${workspaceFolder.uri.toString()}::${buildDirectory ?? sourceUri.toString()}`,
            buildDirectory,
            activeBuildType,
            useCMakePresets: project.useCMakePresets ?? false,
            configurePresetName: project.configurePreset?.name,
            buildPresetName: project.buildPreset?.name,
            testPresetName: project.testPreset?.name,
            packagePresetName: project.packagePreset?.name,
            targetNames: [...(targetNames ?? [])].sort((left, right) => left.localeCompare(right)),
            testNames: [...(testNames ?? [])].sort((left, right) => left.localeCompare(right)),
            codeModelSummary: {
                hasCodeModel: project.codeModel !== undefined && project.codeModel !== null,
            },
            generation: 0,
            sourceKind,
        };
    }

    private async publishNullSnapshots(reason: string): Promise<void> {
        if (!this.serverReady || !this.client.isRunning()) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const workspaceFolder of workspaceFolders) {
            this.sendSnapshot({
                workspaceFolderUri: workspaceFolder.uri.toString(),
                snapshot: null,
            }, reason);
        }
    }

    private sendSnapshot(params: CMakeToolsProjectSnapshotNotificationParams, reason: string): void {
        const previousSnapshot = this.lastPublishedSnapshots.get(params.workspaceFolderUri);
        const nextSnapshot = this.withSnapshotGeneration(previousSnapshot, params.snapshot);

        if (this.areSnapshotsEquivalent(previousSnapshot, nextSnapshot)) {
            return;
        }

        this.lastPublishedSnapshots.set(params.workspaceFolderUri, nextSnapshot);
        params = {
            ...params,
            snapshot: nextSnapshot,
        };
        this.logger.debug(`Sending CMake Tools snapshot update: ${reason}`, params);
        this.client.sendNotification(CMAKE_TOOLS_PROJECT_SNAPSHOT_NOTIFICATION, params);
    }

    private withSnapshotGeneration(
        previousSnapshot: CMakeToolsProjectSnapshot | null | undefined,
        snapshot: CMakeToolsProjectSnapshot | null,
    ): CMakeToolsProjectSnapshot | null {
        if (!snapshot) {
            return null;
        }

        const generation = previousSnapshot && this.areSnapshotsEquivalent(previousSnapshot, snapshot)
            ? previousSnapshot.generation
            : (previousSnapshot?.generation ?? 0) + 1;

        return {
            ...snapshot,
            generation,
        };
    }

    private areSnapshotsEquivalent(
        previousSnapshot: CMakeToolsProjectSnapshot | null | undefined,
        nextSnapshot: CMakeToolsProjectSnapshot | null | undefined,
    ): boolean {
        if (!previousSnapshot || !nextSnapshot) {
            return previousSnapshot === nextSnapshot;
        }

        return previousSnapshot.workspaceFolderUri === nextSnapshot.workspaceFolderUri
            && previousSnapshot.projectId === nextSnapshot.projectId
            && previousSnapshot.buildDirectory === nextSnapshot.buildDirectory
            && previousSnapshot.activeBuildType === nextSnapshot.activeBuildType
            && previousSnapshot.useCMakePresets === nextSnapshot.useCMakePresets
            && previousSnapshot.configurePresetName === nextSnapshot.configurePresetName
            && previousSnapshot.buildPresetName === nextSnapshot.buildPresetName
            && previousSnapshot.testPresetName === nextSnapshot.testPresetName
            && previousSnapshot.packagePresetName === nextSnapshot.packagePresetName
            && previousSnapshot.sourceKind === nextSnapshot.sourceKind
            && previousSnapshot.codeModelSummary?.hasCodeModel === nextSnapshot.codeModelSummary?.hasCodeModel
            && this.haveSameEntries(previousSnapshot.targetNames, nextSnapshot.targetNames)
            && this.haveSameEntries(previousSnapshot.testNames, nextSnapshot.testNames);
    }

    private haveSameEntries(previousValues: string[], nextValues: string[]): boolean {
        return previousValues.length === nextValues.length
            && previousValues.every((value, index) => value === nextValues[index]);
    }
}