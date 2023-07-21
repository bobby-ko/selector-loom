import axios from "axios";
import { it, expect, describe } from "vitest";
import { JSDOM } from "jsdom";
import { selectorLoom } from "./../src/selector-loom.js"

const npmProjectPages = [
    "https://www.npmjs.com/package/typescript"
]

describe("#selectorLoom", () => {
    it("#npm-project-page", async () => {
        
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
});