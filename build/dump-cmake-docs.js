const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outputDir = path.join(__dirname, '..', 'cmake-docs');
const categories = [
    { name: 'command', listFlag: '--help-command-list', helpFlag: '--help-command' },
    { name: 'module', listFlag: '--help-module-list', helpFlag: '--help-module' },
    { name: 'policy', listFlag: '--help-policy-list', helpFlag: '--help-policy' },
    { name: 'variable', listFlag: '--help-variable-list', helpFlag: '--help-variable' },
    { name: 'property', listFlag: '--help-property-list', helpFlag: '--help-property' }
];

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

categories.forEach(category => {
    const categoryDir = path.join(outputDir, category.name);
    if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
    }

    console.log(`Processing ${category.name}...`);
    try {
        const listOutput = execSync(`cmake ${category.listFlag}`).toString();
        const items = listOutput.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

        items.forEach(item => {
            // Sanitize filename
            // Replace < > : " / \ | ? * with _
            const filename = item.replace(/[<>:"/\\|?*]/g, '_') + '.rst';
            const filePath = path.join(categoryDir, filename);

            try {
                const docOutput = execSync(`cmake ${category.helpFlag} "${item}"`).toString();
                fs.writeFileSync(filePath, docOutput);
            } catch (err) {
                console.error(`  Failed to get help for ${category.name}: ${item}`);
            }
        });
    } catch (err) {
        console.error(`Failed to list ${category.name}`, err.message);
    }
});

console.log('Done.');
