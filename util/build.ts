/**
* Microservices Build script
* Remove old files, copy front-end ones.
 */

import { emptyDir, copy } from 'fs-extra';
import child_process from 'child_process';

async function exec(cmd: string, loc: string = './'): Promise<void> {
    return new Promise((res, rej) => {
        const child = child_process.exec(cmd, {cwd: loc}, (err, stdout, stderr) => {
            // if (!!stdout)
            //     console.info(stdout);            
            // if (!!stderr) 
            //     console.error(stderr);

            return (!!err ? rej(err) : res());
        });

        if (!!child.stdout)
            child.stdout.pipe(process.stdout);
        if (!!child.stderr)
            child.stderr.pipe(process.stderr);
    });
}

console.info("Building...");

// Remove current build
await emptyDir("./dist");

// Copy front-end files
// await copy('./src/importer-api/public', './dist/src/importer-api/public');
// await copy('./src/importer-api/views', './dist/src/importer-api/views');

// Copy back-end files
// await copy('./src/importer-api/queries', './dist/src/importer-api/queries');
// await copy('./src/importer-api/wsdl', './dist/src/importer-api/wsdl');
// await copy('./src/importer-api/static', './dist/src/importer-api/static');
// await copy('./src/downloader/parse-defs.json', './dist/src/downloader/parse-defs.json');

await exec('tsc --build tsconfig.json', './');

console.info("...done");

process.exit(0);