# selector-loom

### Generate CSS selector to target exact element from examples.

Use this module when you want to generate a simplified and optimized CSS selector which would target specific elements in a webpage DOM. The `selectorLoom` function accepts one or more examples of a Document & HTMLElement target(s) and returns a qualified selector. This is useful when you need a selector that needs to work across permutations of a specific page type.

## Algorithms

### Subset Evolution

This algorithm works in two parts:

1. Tries to identify the closest parent element with ID and uses that for the beginning of the selector. This results in a smaller sub-DOM where the target(s) reside. 
2. Evolves an optimized non-id sub-selector based on statistically-weighted markers (classes, attributes, tag names, relative positions)

Other then the case where the target's id can be used, this algorithm is not guaranteed to produce the most optimal selector. It will, however produce a fairly optimized one, because it mutates and evolves the selector, beginning from the simplest possible version, and gradually adding significance-weighted markers until it converges on a working version.  

If multiple examples are used, the algorithm will try to reconcile to a selector version that works across all of them, so make sure you pass same type of pages.


## Install

```
$ npm install selector-loom
```

## Usage

```typescript
import axios from "axios";
import { JSDOM } from "jsdom";
import { selectorLoom } from "selector-loom";

const npmProjectPages = [
    "https://www.npmjs.com/package/typescript",
    "https://www.npmjs.com/package/jsdom"
];

// scrape some example NPM product pages and identify the target element on each
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

// Pass the examples of document-target and get an optimized, reconciled selector 
const result = await selectorLoom({
    examples
});

console.info(result?.selector);
// #top p.fw6.black-80.f4.pr2
```

## Tests

This module has only been tested on NodeJS using virtual DOM ([jsdom](https://www.npmjs.com/package/jsdom)).

```
npm run test
```

## Contributing

Feel free to open issues, make suggestions or send PRs. This project adheres to the Contributor Covenant [code of conduct](http://contributor-covenant.org/). By participating, you are expected to uphold this code.

## License

MIT