import { it, expect, describe } from "vitest";
import { readdir, readFile } from "fs/promises";
import { JSDOM } from "jsdom";
import _ from 'lodash';
const { chain } = _;


import { subsetEvolution } from "./../src/subset-evolution.js";
import { IExample } from "./../src/selector-loom-options.js";

async function loadExamples(path: string, filter?: (file) => Boolean)
{
    return await Promise.all(
        (await readdir(path))
            .filter(file => /\.html$/i.test(file)
                && (!filter || filter(file)))
            .map(async file => {
                const window = (new JSDOM(await readFile(`${path}/${file}`))).window;
                const document = window.document;
                const xpaths = JSON.parse((await readFile(`${path}/${file.replace(/\.html$/, ".targets.json")}`)).toString()) as string[];
                const target = xpaths
                    .map(xpath => 
                        document.evaluate(                    
                            xpath,
                            document,
                            null,
                            window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                        .singleNodeValue as HTMLElement);

                if (!(target?.length > 0)
                    || target.some(t => !t))
                    throw new Error("Could not identify target(s)");

                return {
                    document: document,
                    target,
                    metadata: {
                        htmlFile: `${path}/${file}`,
                        targetXPaths: xpaths
                    }
                } as IExample;
            }));
}

describe("#subsetEvolution", () => {
    it("examples-01/*", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-01");
        const result = await subsetEvolution({
            examples
        });

        expect(result).toBeNull();
    });

    it("examples-02/12213.html", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-02", file => file === "14759.html");
        const result = await subsetEvolution({
            examples
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#tabContent-tab-Details .styles__Bullet-sc-6aebpn-0 > span");
    });

    it("examples-02/*", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-02");
        const result = await subsetEvolution({
            examples
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#tabContent-tab-Details .styles__Bullet-sc-6aebpn-0 > span");
    });    
})