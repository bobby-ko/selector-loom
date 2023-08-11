# selector-loom

### Better CSS selector generator for modern websites.

Modern webpages are web-framework generated, DOMs are pruned and optimized, they change all the time, and can have permutations for same type of page-type.

**Selector Loom** helps you generate simplified and optimized CSS selectors to target elements of interest. It goes beyond stiff xpath-style selectors or referencing transient (web-framework generated) class names and attributes. It generates high-quality selectors based on language-confirmed tokens and/or content label anchors that would survive more page permutations and iterations.

Usage is simple - the `selectorLoom` function accepts one or more examples of a Document & element target(s) and returns a qualified selector.


## Algorithms

### Subset Evolution

This algorithm works in two parts:

1. Tries to identify the closest parent element with ID and uses that for the beginning of the selector. This results in a smaller sub-DOM where the target(s) reside. 
2. Evolves an optimized non-id sub-selector based on statistically-weighted markers (classes, attributes, tag names, relative positions)
3. If it cant find a suitable selector it will try to use a content text (aka a label) as an anchor for the target.

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
                    '//*[@id="top"]/div[3]/div[3]/div/div/p',       // downloads number xpath
                    document,
                    null,
                    window.XPathResult.FIRST_ORDERED_NODE_TYPE)
                    .singleNodeValue as HTMLElement
        };
    }));

// Pass the examples of document-target and get an optimized, reconciled selector 
const result = await selectorLoom({
    examples,
    inclusions: {
        // Use tokens only if containing at least 67% real language words
        requiredWordsRatio: 0.67
    }
});

console.info(result?.selector);
// #top p.black-80.flex-auto
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