import { it, expect, describe } from "vitest";
import { readdir, readFile } from "fs/promises";
import { JSDOM } from "jsdom";
import jquery from "jquery";
import _ from 'lodash';
const { chain } = _;


import { subsetEvolution } from "./../src/subset-evolution.js";
import { IExample } from "./../src/selector-loom-options.js";
import { MarkerType } from "../src/models.js";

async function loadExamples(path: string, filter?: (file) => Boolean) {
    return await Promise.all(
        (await readdir(path))
            .filter(file => /\.html$/i.test(file)
                && (!filter || filter(file)))
            .map(async file => {
                const window = (new JSDOM(await readFile(`${path}/${file}`))).window;
                const document = window.document;
                const targetData = JSON.parse((await readFile(`${path}/${file.replace(/\.html$/, ".targets.json")}`)).toString()) as { label?: string, targets: string[] };
                const target = targetData.targets
                    .map(xpath =>
                        document.evaluate(
                            xpath,
                            document,
                            null,
                            window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                            .singleNodeValue as HTMLElement);

                const label = targetData.label
                    ? document.evaluate(
                        targetData.label,
                        document,
                        null,
                        window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                        .singleNodeValue as HTMLElement
                    : undefined;

                if (!(target?.length > 0)
                    || target.some(t => !t))
                    throw new Error("Could not identify target(s)");

                return {
                    document: document,
                    ...(label ? { label } : undefined),
                    target,
                    metadata: {
                        htmlFile: `${path}/${file}`,
                        targetData
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

        expect(result?.selector).toBeUndefined();
    });

    it("examples-02/14759.html", async () => {
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

    it("examples-02/14759.html (inclusions:0.50)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-02", file => file === "14759.html");
        const result = await subsetEvolution({
            examples,
            inclusions: [
                {
                    requiredWordsRatio: 0.50
                }
            ]
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#tabContent-tab-Details .styles__Bullet-sc-6aebpn-0 > span");
    });    
    
    it("examples-02/14759.html (inclusions:0.67)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-02", file => file === "14759.html");
        const result = await subsetEvolution({
            examples,
            inclusions: [
                {
                    requiredWordsRatio: 0.67
                }
            ]
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#tabContent-tab-Details li > span");
    });        

    it("examples-03/21882617.html", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-03", file => file === "21882617.html");
        const result = await subsetEvolution({
            examples
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#pageContent section > div:has(#description) + div .sc-13r1zam-0 > span");
    });

    it("examples-03/21882617.html (no-class)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-03", file => file === "21882617.html");
        const result = await subsetEvolution({
            examples,
            exclusions: {
                type: MarkerType.class
            }
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#pageContent section > div:has(#description) + div div > span");
    });

    it("examples-03/21882617.html (0.67; auto label)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-03", file => file === "21882617.html");
        examples[0].label = "auto";
        const result = await subsetEvolution({
            examples,
            inclusions: {
                requiredWordsRatio: 0.67
            }
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#pageContent section > div:has(#description) + div div > span");
    });


    it("examples-04/00087692008040.html (inclusions:0.67)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-04", file => file === "00087692008040.html");
        const result = await subsetEvolution({
            examples,
            inclusions: [
                {
                    requiredWordsRatio: 0.67
                }
            ]
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#tabContent-tab-Details li > span");
    });        

    it("examples-05/419650-01.html (0.67, auto label)", async () => {
        // load the examples and targets

        const examples = await loadExamples("./test/data/examples-05", file => file === "419650-01.html");
        examples[0].label = "auto";
        const result = await subsetEvolution({
            examples,
            inclusions: [
                {
                    requiredWordsRatio: 0.67
                }
            ]
        });

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#StyledPdpWrapper div > button:has(#description) + div");
    });        


})