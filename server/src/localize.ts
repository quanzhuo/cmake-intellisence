import * as fs from 'fs';
import { resolve, join } from "path";

export interface ILanguagePack {
    [key: string]: string;
}

export class Localize {
    private bundle?: ILanguagePack;
    private locale: string = 'en';
    private get rootPath(): string {
        let current = __dirname;
        while (!fs.existsSync(resolve(current, 'package.nls.json'))) {
            const next = resolve(current, '..');
            if (next === current) {
                return __dirname; // fallback
            }
            current = next;
        }
        return current;
    }

    public init(locale: string) {
        this.locale = locale.toLowerCase();
        this.bundle = undefined; // reload on init
    }

    public localize(key: string, ...args: string[]): string {
        if (!this.bundle) {
            this.bundle = this.resolveLanguagePack();
        }
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

        const resolvedLanguage = this.recurseCandidates(
            this.rootPath,
            languageFormat,
            this.locale,
        );

        const languageFilePath = resolve(this.rootPath, resolvedLanguage);

        try {
            const defaultLanguageBundle = JSON.parse(
                resolvedLanguage !== defaultLanguage
                    ? fs.readFileSync(resolve(this.rootPath, defaultLanguage), "utf-8")
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

const localizeInstance = new Localize();
const localize = localizeInstance.localize.bind(localizeInstance);
export { localizeInstance as localizeInitializer };
export default localize;
