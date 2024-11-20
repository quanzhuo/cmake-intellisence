import { resolve } from "path";
import { env, extensions } from "vscode";
import * as fs from 'fs';

export interface ILanguagePack {
    [key: string]: string;
}

export class Localize {
    private bundle = this.resolveLanguagePack();

    public localize(key: string, ...args: string[]): string {
        const message = this.bundle[key] || key;
        return this.format(message, args);
    }

    private format(message: string, args: string[] = []): string {
        return args.length
            ? message.replace(
                /\{(\d+)\}/g,
                (match, rest: any[]) => args[rest[0]] || match
            )
            : message;
    }

    private resolveLanguagePack(): ILanguagePack {

        const languageFormat = "package.nls{0}.json";
        const defaultLanguage = languageFormat.replace("{0}", "");

        var rootPath = extensions?.getExtension('KylinIdeTeam.cmake-intellisence')?.extensionPath;
        if (rootPath === undefined) {
            rootPath = extensions.getExtension.name;
        }
        const resolvedLanguage = this.recurseCandidates(
            rootPath,
            languageFormat,
            env.language,
        );

        const languageFilePath = resolve(rootPath, resolvedLanguage);

        try {
            const defaultLanguageBundle = JSON.parse(
                resolvedLanguage !== defaultLanguage
                    ? fs.readFileSync(resolve(rootPath, defaultLanguage), "utf-8")
                    : "{}"
            );

            const resolvedLanguageBundle = JSON.parse(
                fs.readFileSync(languageFilePath, "utf-8")
            );

            return { ...defaultLanguageBundle, ...resolvedLanguageBundle };
        } catch (err) {
            throw err;
        }
    }

    private recurseCandidates(
        rootPath: string,
        format: string,
        candidate: string
    ): string {
        const filename = format.replace("{0}", `.${candidate}`);
        const filepath = resolve(rootPath, filename);
        if (fs.existsSync(filepath)) {
            return filename;
        }
        if (candidate.split("-")[0] !== candidate) {
            return this.recurseCandidates(rootPath, format, candidate.split("-")[0]);
        }
        return format.replace("{0}", "");
    }
}

export default Localize.prototype.localize.bind(new Localize());
