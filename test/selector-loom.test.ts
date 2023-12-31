import axios from "axios";
import { it, expect, describe } from "vitest";
import { JSDOM } from "jsdom";
import jquery from "jquery";
import { IExample, MarkerType, selectorLoom } from "./../src/selector-loom.js"

const npmProjectPages = [
    "https://www.npmjs.com/package/typescript"
]

describe("#selectorLoom", () => {
    it("npm-project-page", async () => {
        
        // scrape some NPM product pages
        const examples = await Promise.all(npmProjectPages
            .map(async npmProjectPage => {
                
                const pageResponse = await axios(npmProjectPage);
                const window = (new JSDOM(pageResponse.data)).window;
                const document = window.document;

                return {
                    document,
                    target:
                        document.evaluate(
                            '//*[@id="top"]/div[3]/div[3]/div/div/p',       // downloads number
                            document,
                            null,
                            window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                            .singleNodeValue as HTMLElement
                };
            }));

        const result = await selectorLoom({
            examples
        });

        console.info(result?.selector);
        // #top p.fw6.black-80.f4.pr2

        expect(result).not.toBeNull();
    });

    it("npm-project-page (label, no-class)", async () => {
        
        // scrape some NPM product pages
        const examples = await Promise.all(npmProjectPages
            .map(async npmProjectPage => {
                
                const pageResponse = await axios(npmProjectPage);
                const window = (new JSDOM(pageResponse.data)).window;
                const document = window.document;

                return {
                    document,
                    label: document.evaluate(
                        '//*[@id="top"]/div[3]/div[3]/div/h3/text()',          // "Weekly Downloads" label
                        document,
                        null,
                        window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                        .singleNodeValue as HTMLElement,
                    target:
                        document.evaluate(
                            '//*[@id="top"]/div[3]/div[3]/div/div/p',       // downloads number
                            document,
                            null,
                            window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                            .singleNodeValue as HTMLElement
                };
            }));

        const result = await selectorLoom({
            examples,
            exclusions: {
                type: MarkerType.class
            }
        });

        console.info(result?.selector);
        // #top div > div:has(h3:contains('Weekly Downloads')) p

        expect(result).not.toBeNull();

        for (const example of examples)
        {
            const $ = jquery(example.document.defaultView as Window) as unknown as JQueryStatic;
            const content = $(result?.selector as string)[0].textContent as string;
            expect(content).match(/[0-9,]+/);
        };
    });

    it("npm-project-page (label, 0.67)", async () => {
        
        // scrape some NPM product pages
        const examples = await Promise.all(npmProjectPages
            .map(async npmProjectPage => {
                
                const pageResponse = await axios(npmProjectPage);
                const window = (new JSDOM(pageResponse.data)).window;
                const document = window.document;

                return {
                    document,
                    target:
                        document.evaluate(
                            '//*[@id="top"]/div[3]/div[3]/div/div/p',       // downloads number
                            document,
                            null,
                            window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                            .singleNodeValue as HTMLElement
                } as IExample;
            }));

        const result = await selectorLoom({
            examples,
            inclusions: {
                requiredWordsRatio: 0.67
            }
        });

        // console.info(result?.selector);
        // #top div > div:has(h3:contains('Weekly Downloads')) p

        expect(result).not.toBeNull();
        expect(result?.selector).toBe("#top p.black-80.flex-auto");

        for (const example of examples)
        {
            const $ = jquery(example.document.defaultView as Window) as unknown as JQueryStatic;;
            const content = $(result?.selector as string)[0].textContent as string;
            expect(content).match(/[0-9,]+/);
        };
    });      
});