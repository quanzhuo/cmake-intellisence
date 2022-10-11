import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


function isGrammarOutdate(fileName) {
    const thisFile = fileURLToPath(import.meta.url);
    const json = path.join(path.dirname(thisFile), '..', 'syntaxes', fileName);
    if (!existsSync(json)) {
        return true;
    }
    const yaml = json.replace('.json', '.yml');
    const jsonState = statSync(json);
    const yamlState = statSync(yaml);
    if (yamlState.mtimeMs > jsonState.mtimeMs) {
        console.log(`${yaml} changed, Grammar is outdate, re-generate it.`);
        return true;
    }
    return false;
}

function yamlToJson() {
    if (isGrammarOutdate('cmake.tmLanguage.json')) {
        execSync('npm run grammar-cmake');
    }

    if (isGrammarOutdate('cmakecache.tmLanguage.json')) {
        execSync('npm run grammar-cmakecache');
    }

    if (isGrammarOutdate('cmdsignature.tmLanguage.json')) {
        execSync('npm run grammar-cmdsignature');
    }
}

yamlToJson();
