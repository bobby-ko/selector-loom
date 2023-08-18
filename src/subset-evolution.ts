import bs from "binary-search";
import jquery from "jquery";
import natural from "natural";
import { differenceInMilliseconds, differenceInSeconds } from "date-fns";
import { readFile, writeFile } from "fs/promises";
import pLimit from "p-limit";
import NodeCache from "node-cache";
import { dirname, join as pathJoin } from 'path';
import { fileURLToPath } from 'url';
const { WordTokenizer, WordNet, NounInflector } = natural;
import _, { CollectionChain } from 'lodash';
const { chain, cloneDeep, last, takeWhile, sumBy } = _;

import { IElementMarker, IElementVolume, IInternalSelector, ISelector, IWeighted, MarkerType } from "./models.js";
import { ISelectorLoomOptions, IExclusionFilter, IInclusionFilter } from "./selector-loom-options.js";

// type ExcludedAttribute = string | { regex: string };

const warnExhaustedTimeBudget = `Exhausted time budget. Completing generation before processing all examples.`;

let moduleDirname!: string;
try {
    moduleDirname = __dirname;
}
catch (err: any) {
    // @ts-ignore
    moduleDirname = dirname(fileURLToPath(import.meta.url));
}

enum Strategy {
    AnchorAsCommonParent,
    LabelTargetNeighboringParents
}

interface ICombinationSpaceMutation {
    combinationSpace: IElementVolume[],
    matches: NodeListOf<Element>,
    mutationDepthDelta: number,
    mutationMarker: IElementMarker
}

interface IAnchor {
    element: HTMLElement;
    depthDelta: number;
}

class SubsetEvolution {

    private static excludedAttributes: readonly string[];
    private static excludedAttributesRegex: readonly RegExp[];
    private static excludedTags: readonly string[];

    private static readonly excludedWords = [
        "the"
    ] as readonly string[];

    private static readonly defaultLanguage = ["en"] as readonly string[];

    private static dictionaries: Record<string, Set<string>> = {};

    private static words: Record<string, boolean> | undefined;
    private static wordsUpdated = false;
    private static wordsLastSaved: Date | undefined;

    private static wordSplits: Record<string, string[] | null> | undefined;
    private static wordSplitsUpdated = false;
    private static wordSplitsLastSaved: Date | undefined;

    private static readonly tokenizer = new WordTokenizer();
    private static readonly nounInflector = new NounInflector();
    private static readonly wordnet = new WordNet();
    private static readonly maxWordnetLookupBudgetMs = Number.parseInt(process.env.SELECTOR_LOOM_MAX_WORDNET_LOOKUP_BUDGET_MS ?? "60000");

    private static readonly wordRatioCache = new NodeCache({
        stdTTL: 600,
        checkperiod: 60,
        useClones: false,
    });

    private chunks: Record<string, boolean> = {};
    private readonly computeWordRatioQueue = pLimit(1);
    private readonly classDistribution: Record<string, number> = {};
    private readonly attributeDistribution: Record<string, number> = {};
    private readonly tagDistribution: Record<string, number> = {};
    private readonly timeBudgetSec: number;
    private readonly startAt: Date;
    private overTimeBudget: Boolean = false;

    private dictionary!: Set<string>;
    private dictionaryLongerWords: string[] | undefined;
    private wordnetLookupBudgetMs: number = SubsetEvolution.maxWordnetLookupBudgetMs;
    private overWordnetLookupBudgetWarning: boolean = false;
    private logs: Record<string, any>[] = [];

    constructor(timeBudgetSec?: number) {
        this.timeBudgetSec = timeBudgetSec ?? 0;
        this.startAt = new Date();
    }

    private static async ensureExcluded() {
        if (SubsetEvolution.excludedAttributes === undefined) {
            const filename = pathJoin(moduleDirname, 'excluded/attributes.json');
            const excludedAttributesList = JSON.parse((await readFile(filename)).toString());

            SubsetEvolution.excludedAttributes = chain(excludedAttributesList)
                .filter(item => typeof item === "string")
                .map(item => item as string)
                .orderBy()
                .value() as readonly string[];

            SubsetEvolution.excludedAttributesRegex = chain(excludedAttributesList)
                .filter(item => typeof item === "object" && item.regex !== undefined)
                .map(regex => new RegExp((regex as { regex: string }).regex))
                .value() as readonly RegExp[];
        }

        if (SubsetEvolution.excludedTags === undefined) {
            const filename = pathJoin(moduleDirname, 'excluded/tags.json');
            SubsetEvolution.excludedTags = JSON.parse((await readFile(filename)).toString()) as readonly string[];
        }
    }

    private async isWord(token: string, cache: Boolean = true): Promise<boolean> {
        // take some shortcuts first to reduce compute on words lookup

        // if a token is less than 3 char don't consider it a proper word
        if (token.length < 3)
            return false;

        const _token = token.toLowerCase();
        if (this.dictionary.has(_token))
            return true;

        let result = SubsetEvolution.words?.[_token];
        if (result !== undefined)
            return result;

        result = this.chunks[_token];
        if (result !== undefined)
            return result;

        let hasVowels = /[aeiouy]/i.test(token);

        // special case - y is not a vowel at beginning of words
        if (hasVowels && token[0] === "y")
            hasVowels = /[aeiouy]/i.test(token.substring(1));

        if (hasVowels
            && !/[^aeiouy]{5}/.test(token))     // don't lookup words with 5 or more consecutive consonants
        {
            if (this.wordnetLookupBudgetMs > 0 && !this.overTimeBudget) {
                const start = new Date();

                result = await new Promise((accept) =>
                    SubsetEvolution.wordnet.lookup(_token, results => {
                        if (results.length > 0)
                            accept(true);
                        else
                            // try to singularize it - sometimes that results in better lookups for some words
                            SubsetEvolution.wordnet.lookup(SubsetEvolution.nounInflector.singularize(_token), results => accept(results.length > 0));
                    }));

                this.wordnetLookupBudgetMs -= differenceInMilliseconds(new Date(), start);
            }
            else if (!this.overTimeBudget && !this.overWordnetLookupBudgetWarning) {
                const warn = `Exhausted Wordnet Lookup Budget. Continuing using only dictionary and already classified words.`;
                console.warn(`[selector-loom] ${warn}`);
                this.logs.push({
                    warn,
                    code: "timeout",
                    timestamp: new Date()
                });
                this.overWordnetLookupBudgetWarning = true;
            }
        }

        // console.assert(typeof result === "boolean");

        const l = _token.length;
        if (!result
            && l >= 6
            && hasVowels) {

            // It's possible the token is multiple valid words
            // Try to take make sense of it
            for (let chunkSize = 3; chunkSize <= l - 3; chunkSize++) {
                const chunk = _token.substring(0, chunkSize);
                const chunkIsWord = await this.isWord(chunk, false);

                if (chunkIsWord) {
                    const reminderAreWords = await this.isWord(_token.substring(chunkSize), false);

                    if (reminderAreWords) {
                        result = true;
                        break;
                    }
                }
            }
        }

        if (result === undefined)
            result = false;

        // this condition is to prevent caching of chuncks from the process of trying to parse out concatenated words
        if (cache) {
            (SubsetEvolution.words as Record<string, boolean>)[_token] = result;
            SubsetEvolution.wordsUpdated = true;
        }
        else
            this.chunks[_token] = result;

        return result;
    }

    private static splitCamelNotation(word: string): string | string[] {
        let result: string[] | undefined;
        let reminder = word;

        while (reminder.length > 0) {
            const camelCaseMatch = /[a-z][A-Z][a-z]{2}/.exec(reminder);

            if (camelCaseMatch) {
                if (!result)
                    result = [];
                result.push(reminder.substring(0, camelCaseMatch.index + 1));
                reminder = reminder.substring(camelCaseMatch.index + 1);
            }
            else {
                if ((result?.length ?? 0) > 0) {
                    (result as string[]).push(reminder);
                    break;
                }
                else
                    return word;    // optimization short circuit - return same instance
            }
        }

        return result as string[];
    }

    private splitLongWord(word: string): string | string[] {
        const l = word.length;
        if (l > 12) {
            // long word - try to recognize some 5+ letter word and see if we can split it

            const _word = word.toLowerCase();

            // check it is not a legit long single word
            if (this.dictionary.has(_word))
                return word;

            const cachedResult = (SubsetEvolution.wordSplits as Record<string, string[] | null>)[_word];
            if (cachedResult !== undefined)
                return cachedResult ?? word;    // could be null, which means it was previously processed but no split was found and set as null 

            const lengthThreshold = l - 3;
            let index = 0;
            const matches = chain(this.dictionaryLongerWords)
                .map(lookupWord => {
                    if (lookupWord.length > lengthThreshold)
                        return undefined;
                    const start = _word.indexOf(lookupWord);
                    return start >= 0
                        ? {
                            matched: lookupWord,
                            start,
                            end: start + lookupWord.length,
                            i: index++
                        }
                        : undefined;
                })
                .filter(match => match !== undefined)
                .map(match => match as {
                    matched: string,
                    start: number,
                    end: number,
                    i: number
                })
                .value();

            if (matches?.length) {
                let cutmarks = chain(matches)
                    .takeWhile(match => match.i === 0
                        || chain(matches)
                            .take(match.i)
                            .every(priorMatch =>
                                match.end <= priorMatch.start
                                || match.start >= priorMatch.end)
                            .value())
                    .map(match => [match.start, match.end])
                    .flatten()
                    .concat(0, word.length)
                    .orderBy()
                    .uniq()
                    .value();

                const result = chain(cutmarks)
                    .take(cutmarks.length - 1)
                    .map((cutmark, i) => word.substring(cutmark, cutmarks[i + 1]))
                    .value();

                if (sumBy(result, chunk => chunk.length) !== l
                    || result.some(chunk => !word.includes(chunk)))
                    throw new Error(`Long word breakdown error - split length or content doesn't match`);

                (SubsetEvolution.wordSplits as Record<string, string[] | null>)[_word] = result;
                SubsetEvolution.wordSplitsUpdated = true;

                return result;
            }

            (SubsetEvolution.wordSplits as Record<string, string[] | null>)[_word] = null;
            SubsetEvolution.wordSplitsUpdated = true;
        }

        return word;
    }

    private async getWordRatio(value: string, explicitInclusions: IInclusionFilter[]): Promise<number> {
        let result = SubsetEvolution.wordRatioCache.get<number>(value);

        if (result !== undefined)
            return result;

        return await this.computeWordRatioQueue(async () => {
            // try again - might have been cached by the time this instance gets to execute
            let result = SubsetEvolution.wordRatioCache.get<number>(value);

            if (result !== undefined)
                return result;

            let tokens = SubsetEvolution.tokenizer.tokenize(value.replace(/[_0-9]+/g, " "));

            if (!tokens || tokens.length === 0)
                return 0;

            for (const inclusion of explicitInclusions) {
                if (inclusion.requiredWordsRatio <= 0 || inclusion.requiredWordsRatio > 1)
                    throw new Error("Invalid requiredWordsRatio value");

                tokens = chain(tokens)
                    .filter(word =>
                        word.length >= (inclusion.minWordLength ?? 3)
                        && !SubsetEvolution.excludedWords.includes(word.toLowerCase()))
                    .map(SubsetEvolution.splitCamelNotation)
                    .flatten()
                    .map(word => this.splitLongWord(word))
                    .flatten()
                    .filter(word => !SubsetEvolution.excludedWords.includes(word.toLowerCase()))
                    .value();
            }

            const wordTokens: string[] = [];
            await Promise.all(tokens
                .map(async word => {
                    const _isWord = await this.isWord(word);
                    if (_isWord)
                        wordTokens.push(word);
                }));

            result = wordTokens.reduce((accum, word) => accum + word.length, 0) / value.replace(/[ \-_~:]+/g, "").length;
            SubsetEvolution.wordRatioCache.set(value, result);
            return result;
        });
    }

    private async isIncluded(value: string, explicitInclusions?: IInclusionFilter[]): Promise<boolean> {
        if (explicitInclusions) {
            const wordsRatio = await this.getWordRatio(value, explicitInclusions);

            for (const inclusion of explicitInclusions)
                if (wordsRatio < inclusion.requiredWordsRatio)
                    return false;
        }

        return true;
    }

    private async closestParentWithId(body: HTMLElement, target: HTMLElement, idExplicitInclusions?: IInclusionFilter[]): Promise<IAnchor> {
        let closestParentWithId = target;
        let depthDelta = 0;
        while (closestParentWithId !== body
            && (!closestParentWithId.id
                || !await this.isIncluded(closestParentWithId.id, idExplicitInclusions))) {
            if (closestParentWithId.parentElement) {
                closestParentWithId = closestParentWithId.parentElement;
                depthDelta++;
            }
            else
                throw new Error("Broken DOM hierarchy");
        }

        return {
            element: closestParentWithId,
            depthDelta
        };
    }

    private static isParent(target: HTMLElement, potentialParent: HTMLElement): Boolean {
        let parent = target.parentElement;
        while (parent) {
            if (parent === potentialParent)
                return true;
            parent = parent.parentElement
        }
        return false;
    }

    static weighted(list: string[] | IterableIterator<string>, distribution: Record<string, number>, type: MarkerType): IWeighted[] {
        return (
            Array.isArray(list)
                ? list
                : Array.from(list))
            .map(item => ({ type, item, weight: distribution[item] ?? -1 } as IWeighted));
    }

    static segmentedSelector(marker: IWeighted): (string | null)[] {
        switch (marker.type) {
            case MarkerType.class:
                return [null, `.${marker.item}`, null];

            case MarkerType.attribute:
                const pair = marker.item.split("=");
                return [null, null, `[${pair[0]}='${pair[1]}']`];

            case MarkerType.tag:
                return [marker.item.toLowerCase(), null, null];

            default:
                throw new Error("Marker not supported");
        }
    }

    static merge(target: (string | null)[], source: IWeighted): (string | null)[] {
        let i = 0;
        for (const newSegment of SubsetEvolution.segmentedSelector(source)) {
            if (newSegment) {
                const segment = target[i];
                target[i] = (segment ?? "") + newSegment;
            }
            i++;
        }

        return target;
    }

    private $markers(element: HTMLElement): CollectionChain<IWeighted> {
        return chain(SubsetEvolution.weighted(element.classList.values(), this.classDistribution, MarkerType.class))
            .concat(SubsetEvolution.weighted(
                chain(element.getAttributeNames())
                    .filter(attributeName =>
                        bs(SubsetEvolution.excludedAttributes, attributeName, (a, b) => a < b ? -1 : a > b ? 1 : 0) < 0
                        && !SubsetEvolution.excludedAttributesRegex.some(regex => regex.test(attributeName)))
                    .map(attributeName => `${attributeName}=${element.attributes.getNamedItem(attributeName)?.value}`)
                    .value(),
                this.attributeDistribution,
                MarkerType.attribute))
            .concat(SubsetEvolution.weighted([element.tagName], this.tagDistribution, MarkerType.tag))
            .filter(marker => marker.weight > 0);
    }

    private topMarker(element: HTMLElement, usedMarkers?: IWeighted[],
        excludedMarkers?: IElementMarker[], userExclusions?: IExclusionFilter[]): IWeighted {

        return this.$markers(element)

            .filter(marker =>

                usedMarkers?.some(usedMarker =>
                    usedMarker.type === marker.type
                    && usedMarker.item === marker.item) !== true

                && excludedMarkers?.some(excludedMarker =>
                    excludedMarker.element === element
                    && excludedMarker.type === marker.type
                    && excludedMarker.item === marker.item) !== true

                && userExclusions?.some(userExclusion =>
                    (!userExclusion.element || (userExclusion.element as HTMLElement[]).includes(element))
                    && (!userExclusion.type || userExclusion.type === marker.type)
                    && ((userExclusion.value instanceof String && userExclusion.value === marker.item)
                        || userExclusion.value instanceof RegExp && userExclusion.value.test(marker.item))) !== true)

            .reduce((max, marker) => !max || marker.weight > max.weight ? marker : max)
            .value();
    }

    private volume(element: HTMLElement, depthDelta: number): IElementVolume {
        const markers = this.$markers(element)
            .orderBy(marker => marker.weight, "desc")
            .value();

        return {
            depthDelta,
            element,
            markers,
            selectorSegments: SubsetEvolution.segmentedSelector(markers[0]),
            usedMarkers: markers.slice(0, 1)
        }
    }

    private static selector(combinationSpace: IElementVolume[]): string {
        const subSelectors = chain(combinationSpace)
            .orderBy(elementSpace => elementSpace.depthDelta, "desc")
            .reduce(
                (accum, elementSpace) => {
                    accum.push({
                        distance: elementSpace.depthDelta,
                        selector: chain(elementSpace.selectorSegments)
                            .map(selectorPart => selectorPart ?? "")
                            .join("")
                            .value()
                    });
                    return accum;
                },
                [] as { distance: number, selector: string }[])
            .value();

        return chain(subSelectors)
            .reduce(
                (accum, subSelector, i) => {
                    if (i > 0)
                        accum.push(subSelectors[i - 1].distance === subSelector.distance + 1 ? " > " : " ");
                    accum.push(subSelector.selector);
                    return accum;
                },
                [] as string[])
            .join("")
            .value();
    }

    public static validateSelector(selector: string, anchor: HTMLElement, targets: HTMLElement[]) {
        const matches = anchor.querySelectorAll(selector);

        return {
            valid: matches.length === targets.length
                && [...matches].every(match => targets.includes(match as HTMLElement)),
            matches
        };
    }

    private static anchorSelector(idElement: HTMLElement, anchorElement: HTMLElement, label: HTMLElement | undefined, strategy: Strategy) {
        if (!label)
            return "";

        const neighboringParents = strategy === Strategy.LabelTargetNeighboringParents;

        let anchorSelector: string;
        const textContent = label.textContent?.trim();

        while (!label.tagName) {
            const newLabel = (label as HTMLElement).parentElement;
            if (!newLabel)
                throw new Error(`Failed to get label's parent`);

            label = newLabel as HTMLElement;
        }

        const labelSelector = (label?.id ?? "") != ""
            ? `#${label.id}`
            : `${label.tagName.toLowerCase()}:contains('${textContent}')`;

        anchorSelector = `${(neighboringParents ? anchorElement.previousElementSibling as HTMLElement : anchorElement).tagName.toLowerCase()}:has(${labelSelector}) ${(neighboringParents ? "+ " + anchorElement.tagName.toLowerCase() + " " : "")}`;

        const $ = jquery(idElement.ownerDocument.defaultView as Window);

        if (($ as any)(`#${idElement.id} ${anchorSelector}`).length > 1) {
            const anchorParent = anchorElement.parentElement;
            if (anchorParent !== idElement)
                anchorSelector = `${anchorParent?.tagName.toLocaleLowerCase()} > ${anchorSelector}`
        }

        return anchorSelector;
    }

    private static hasParentOfTag(element: HTMLElement, tagNames: readonly string[], stopAtParent: HTMLElement) {
        let parent = element.parentElement;

        while (parent && parent != stopAtParent) {
            if (tagNames.includes(parent.tagName.toLowerCase()))
                return true;

            parent = parent.parentElement
        }

        return false;
    }

    public static async generate(document: Document, label: "auto" | HTMLElement | undefined, targets: HTMLElement[], maxRecursion: number, excludedMarkers: IElementMarker[], userInclusions?: IInclusionFilter[], userExclusions?: IExclusionFilter[], timeBudgetSec?: number): Promise<IInternalSelector | null> {
        if (!document)
            throw new Error(`document is required`);

        if (!targets?.length)
            throw new Error(`At least one target is required`);

        if (label && label !== "auto" && (label.textContent?.trim() ?? "") === "")
            throw new Error(`Label needs to contain text`);

        if (targets.every(target => target.id !== undefined && target.id !== null && target.id.trim() !== ""))
            return {
                selector: `#${targets[0].id}`,
                example: {
                    document,
                    target: targets
                }
            };

        await SubsetEvolution.ensureExcluded();

        const languages = userInclusions?.length
            ? chain(userInclusions)
                .map(inclusion => inclusion.languages ?? SubsetEvolution.defaultLanguage)
                .flatten()
                .map(language => language.toLowerCase())
                .uniq()
                .value()
            : SubsetEvolution.defaultLanguage;

        const se = new SubsetEvolution(timeBudgetSec);

        for (const language of languages) {
            if (language !== SubsetEvolution.defaultLanguage[0])
                throw new Error("Only english is currently supported");

            const cachedDictionary = SubsetEvolution.dictionaries[language];
            if (cachedDictionary) {
                if (se.dictionary) {
                    for (const word of cachedDictionary)
                        se.dictionary.add(word);
                }
                else
                    se.dictionary = new Set<string>(cachedDictionary);
            }
            else {
                const filename = pathJoin(moduleDirname, `dictionaries/${language}.txt`);
                let _dictionary: string[] | undefined;
                try {
                    _dictionary = (await readFile(filename)).toString().split("\n");
                }
                catch (err) {
                    // could not exists
                }

                if (_dictionary) {
                    SubsetEvolution.dictionaries[language] = new Set<string>(_dictionary);
                    if (se.dictionary) {
                        for (const word of _dictionary)
                            se.dictionary.add(word);
                    }
                    else
                        se.dictionary = new Set<string>(_dictionary);
                }
            }

            se.dictionaryLongerWords = chain(Array.from(se.dictionary))
                .filter(word => word.length >= 5)
                .orderBy(word => word.length, "desc")
                .value();
        }

        if (!SubsetEvolution.words) {
            try {
                SubsetEvolution.words = process.env.SELECTOR_LOOM_TMP
                    ? JSON.parse((await readFile(`${process.env.SELECTOR_LOOM_TMP}/subset-evolution-words.json`)).toString())
                    : {}
            }
            catch (err) {
                SubsetEvolution.words = {};
            }
        }

        if (!SubsetEvolution.wordSplits) {
            try {
                SubsetEvolution.wordSplits = process.env.SELECTOR_LOOM_TMP
                    ? JSON.parse((await readFile(`${process.env.SELECTOR_LOOM_TMP}/subset-evolution-word-splits.json`)).toString())
                    : {}
            }
            catch (err) {
                SubsetEvolution.wordSplits = {};
            }
        }

        const allAnchors = await Promise.all(targets
            .concat(label && label !== "auto" ? [label] : [])
            .map(target => se.closestParentWithId(
                document.body,
                target,
                userInclusions?.filter(userInclusion => userInclusion.type === MarkerType.id || !userInclusion?.type))));

        const idParent = allAnchors.every(anchor => anchor.element === allAnchors[0].element)

            ? allAnchors[0]

            : (() => {
                const body = document.body.querySelector("main") ?? document.body;
                let depthDelta = 0;
                let currentElement = targets[0];
                while (currentElement !== body) {
                    currentElement = currentElement.parentElement as HTMLElement;
                    depthDelta++;
                }

                return {
                    element: body,
                    depthDelta
                };
            })();

        let anchorParent: IAnchor | undefined;

        const classListImplicitInclusions = userInclusions?.filter(inclusion => inclusion.type === MarkerType.class || !inclusion.type);
        const attributeValueImplicitInclusions = userInclusions?.filter(inclusion => inclusion.type === MarkerType.attribute || !inclusion.type);

        let retry = false;
        let strategy = Strategy.AnchorAsCommonParent;
        do {
            retry = false;

            if (!anchorParent) {
                if (!label || label === "auto")
                    anchorParent = idParent
                else {
                    let commonParent = (label as HTMLElement).parentElement;
                    let depthDelta = 1;
                    while (commonParent) {
                        if (targets.every(target => SubsetEvolution.isParent(target, commonParent as HTMLElement)))
                            break;

                        commonParent = commonParent.parentElement;
                        depthDelta++;
                    }

                    if (commonParent === idParent.element)
                        anchorParent = idParent
                    else {
                        if (!commonParent)
                            throw new Error("Could not find common parent for label and target(s)");

                        if (!SubsetEvolution.isParent(commonParent, idParent.element))
                            throw new Error("Common parent between label and target(s) is expected to be under idParent");

                        anchorParent = {
                            element: commonParent,
                            depthDelta
                        }
                    }
                }
            }

            if (!anchorParent)
                throw new Error("Failed to identify anchor element");

            const elements = anchorParent.element.querySelectorAll(`*:not(script)${SubsetEvolution.excludedTags.map(excludedTag => `:not(${excludedTag})`).join("")}`);
            const distanceWeightReductionFactor = 1.0 / anchorParent.depthDelta;

            for (const element of elements) {
                // exclude all nested elements in <svg>, <iframe>, <picture>
                if (SubsetEvolution.hasParentOfTag(element as HTMLElement, SubsetEvolution.excludedTags, anchorParent.element))
                    continue;

                if (se.timeBudgetSec > 0 && !se.overTimeBudget && differenceInSeconds(new Date(), se.startAt) > se.timeBudgetSec) {
                    const warn = `Exhausted time budget. Ignoring further Wordnet Lookups and continuing using only dictionary and already classified words.`;
                    console.warn(`[selector-loom] ${warn}`);
                    se.logs.push({
                        warn,
                        code: "timeout",
                        timestamp: new Date()
                    })
                    se.overTimeBudget = true;
                }

                for (const className of element.classList) {
                    if (userExclusions?.some(exclusion =>
                        (!exclusion.element || (exclusion.element as HTMLElement[]).includes(element as HTMLElement))
                        && (!exclusion.type || exclusion.type === MarkerType.class)
                        && (exclusion.value === undefined || exclusion.value === className))
                        || !await se.isIncluded(className, classListImplicitInclusions))
                        continue;

                    const count = se.classDistribution[className];
                    se.classDistribution[className] = (count ?? 0) + 1;
                }

                for (const attribute of element.attributes) {
                    const attributeName = attribute.name;
                    if (bs(SubsetEvolution.excludedAttributes, attributeName, (a, b) => a < b ? -1 : a > b ? 1 : 0) >= 0
                        || SubsetEvolution.excludedAttributesRegex.some(regex => regex.test(attributeName)))
                        continue;

                    if (userExclusions?.some(exclusion =>
                        (!exclusion.element || (exclusion.element as HTMLElement[]).includes(element as HTMLElement))
                        && (!exclusion.type || exclusion.type === MarkerType.attribute)
                        && (exclusion.value === undefined || exclusion.value === attributeName))
                        || !await se.isIncluded(attribute.value, attributeValueImplicitInclusions))
                        continue;

                    const attributeLabel = `${attributeName}=${attribute.value}`;
                    const count = se.attributeDistribution[attributeLabel];
                    se.attributeDistribution[attributeLabel] = (count ?? 0) + 1;
                }

                if (userExclusions?.some(exclusion =>
                    (!exclusion.element || (exclusion.element as HTMLElement[]).includes(element as HTMLElement))
                    && (!exclusion.type || exclusion.type === MarkerType.tag)
                    && (exclusion.value === undefined || exclusion.value === element.tagName)))
                    continue;

                const count = se.tagDistribution[element.tagName];
                se.tagDistribution[element.tagName] = (count ?? 0) + 1;
            }

            let combinationSpace: IElementVolume[] = [se.volume(
                targets[0],
                0)];

            let lastCombinationSpace: IElementVolume[] | undefined;
            let mutationMarker: IElementMarker | undefined;
            excludedMarkers = excludedMarkers ?? [];

            // mutation loop
            do {
                const selectorCandidate = SubsetEvolution.selector(combinationSpace);
                const validationResult =

                    // check for specific cornercase where the target is the element right after the label (rather then nested within it)
                    (strategy === Strategy.LabelTargetNeighboringParents
                        && targets.length === 1
                        && (anchorParent as IAnchor).element === targets[0])

                        ? { valid: true, matches: [anchorParent] }

                        : SubsetEvolution.validateSelector(selectorCandidate, (anchorParent as IAnchor).element, targets);

                if (validationResult.valid) {

                    const anchorSelectorVal = SubsetEvolution.anchorSelector(
                        idParent.element,
                        (anchorParent as IAnchor).element,
                        label !== "auto" ? label : undefined,
                        strategy);

                    return {
                        combinationSpace,
                        selector: idParent.element.id
                            ? `#${idParent.element.id} ${anchorSelectorVal}${(anchorParent.element === targets[0] ? " " : selectorCandidate)}`.trim()
                            : selectorCandidate,
                        ...(excludedMarkers.length ? { excludedMarkers } : undefined),
                        example: {
                            document,
                            target: targets
                        },
                        ...(se.logs.length ? { logs: se.logs } : undefined)
                    }
                }

                if (targets.length > 1
                    && validationResult.matches.length > 1
                    && validationResult.matches.length < targets.length) {
                    // This is multiple targets corner-case - we've matched on something thats unique to only one of the targets but not others
                    // We need to rollback the last mutation and identify that particular marker as excluded
                    if (!lastCombinationSpace || !mutationMarker)
                        throw new Error(`Unexpected missing lastCombinationSpace or mutationMarker`);

                    combinationSpace = lastCombinationSpace;
                    excludedMarkers.push(mutationMarker);

                    continue;
                }

                // Explore two possibilities (mutations):
                // 1. Use another marker on any existing element already in the volume
                // 2. Add a new element to the volume from the parent chain with a top marker
                // Pick the best fitted mutation

                const mutation = chain(combinationSpace)

                    // generate a set of combinationSpaces, each exploring a new mutation for an elementVolume
                    .map(elementVolume => {

                        const newMarker = se.topMarker(
                            elementVolume.element,
                            elementVolume.usedMarkers,
                            excludedMarkers,
                            userExclusions);

                        if (newMarker) {
                            const mutatedElementVolume = {
                                depthDelta: elementVolume.depthDelta,
                                element: elementVolume.element,
                                selectorSegments: SubsetEvolution.merge(cloneDeep(elementVolume.selectorSegments), newMarker),
                                markers: elementVolume.markers,
                                usedMarkers: elementVolume.usedMarkers.concat(newMarker)
                            } as IElementVolume;

                            const mutatedCombinationSpace = combinationSpace.map(eVol => eVol === elementVolume ? mutatedElementVolume : eVol);
                            const mutatedSelectorCandidate = SubsetEvolution.selector(combinationSpace);
                            const matches = (anchorParent as IAnchor).element.querySelectorAll(mutatedSelectorCandidate);

                            return {
                                combinationSpace: mutatedCombinationSpace,
                                matches,
                                mutationDepthDelta: elementVolume.depthDelta,
                                mutationMarker: {
                                    element: elementVolume.element,
                                    item: newMarker.item,
                                    type: newMarker.type
                                }
                            } as ICombinationSpaceMutation;
                        }

                        return null;
                    })

                    // some elementVolumes might have exhausted all markers so there won't be any new mutations from those 
                    .filter(mutation => mutation != null)

                    .concat((() => {
                        const lastCombinationSpace = last(combinationSpace) as IElementVolume;
                        const nextParentElement = lastCombinationSpace.element.parentElement as HTMLElement;
                        if (nextParentElement === (anchorParent as IAnchor).element)
                            return [];

                        const depthDelta = lastCombinationSpace.depthDelta + 1;

                        const newElementVolume = se.volume(
                            nextParentElement,
                            depthDelta
                        );
                        const mutatedCombinationSpace = combinationSpace.concat(newElementVolume);

                        const mutatedSelectorCandidate = SubsetEvolution.selector(combinationSpace);
                        const matches = (anchorParent as IAnchor).element.querySelectorAll(mutatedSelectorCandidate);

                        return [{
                            combinationSpace: mutatedCombinationSpace,
                            matches,
                            mutationDepthDelta: depthDelta,
                            mutationMarker: {
                                element: nextParentElement,
                                item: newElementVolume.usedMarkers[0].item,
                                type: newElementVolume.usedMarkers[0].type
                            }
                        } as ICombinationSpaceMutation];
                    })())

                    // Find the best fitted mutation
                    // Ranking is a formula reversely proportionate to number of matches and proportionate to mutations closer to the target element:
                    // - The less number of matches the better
                    // - The closer (mutated element sub-selector's position) relative to target element the better
                    .reduce((bestFit, mutation) =>
                        !bestFit
                            || ((mutation as ICombinationSpaceMutation).matches.length / (1.0 - distanceWeightReductionFactor * (mutation as ICombinationSpaceMutation).mutationDepthDelta))
                            < ((bestFit.matches.length ?? elements.length) / (1.0 - distanceWeightReductionFactor * bestFit.mutationDepthDelta))

                            ? mutation

                            : bestFit)

                    .value();

                // could not find a solution 
                if (!mutation) {
                    if (label === "auto") {
                        label = await se.findLabel(
                            (anchorParent as IAnchor).element,
                            targets,
                            userInclusions?.filter(inclusion => !inclusion.type || inclusion.type === MarkerType.id),
                            userExclusions?.filter(exclusion => !exclusion.type || exclusion.type === MarkerType.id));

                        if (label) {
                            anchorParent = undefined;
                            retry = true;
                        }
                    }
                    else if (label && strategy === Strategy.AnchorAsCommonParent) {
                        strategy = Strategy.LabelTargetNeighboringParents;
                        const newAnchorParentElement = [...(anchorParent as IAnchor).element.children]
                            .find(closerParent => targets.every(target => target === closerParent || SubsetEvolution.isParent(target, closerParent as HTMLElement))) as HTMLElement | undefined;

                        if (!newAnchorParentElement)
                            throw new Error("Could not find nested parent for the sibling relationship strategy");

                        anchorParent = {
                            element: newAnchorParentElement,
                            depthDelta: (anchorParent as IAnchor).depthDelta - 1
                        };
                        retry = true;
                    }

                    break;  // out of the mutation loop
                }

                lastCombinationSpace = combinationSpace;
                mutationMarker = mutation.mutationMarker;
                combinationSpace = mutation.combinationSpace;
            }
            while (maxRecursion--);
        }
        while (retry)

        return se.logs.length 
            ? {
                example: {
                    document,
                    target: targets
                },
                logs: se.logs 
            }
            : null;
    }

    public static async saveWords() {
        try {
            if (process.env.SELECTOR_LOOM_TMP) {
                await Promise.all([
                    (async () => {
                        if (SubsetEvolution.wordsUpdated) {
                            const now = new Date();

                            if (!SubsetEvolution.wordsLastSaved
                                || differenceInSeconds(now, SubsetEvolution.wordsLastSaved) > 10) {
                                SubsetEvolution.wordsUpdated = false;
                                await writeFile(`${process.env.SELECTOR_LOOM_TMP}/subset-evolution-words.json`, JSON.stringify(SubsetEvolution.words, null, " "));
                                SubsetEvolution.wordsLastSaved = now;
                            }
                        }
                    })(),

                    (async () => {
                        if (SubsetEvolution.wordSplitsUpdated) {
                            const now = new Date();

                            if (!SubsetEvolution.wordSplitsLastSaved
                                || differenceInSeconds(now, SubsetEvolution.wordSplitsLastSaved) > 10) {
                                SubsetEvolution.wordSplitsUpdated = false;
                                await writeFile(`${process.env.SELECTOR_LOOM_TMP}/subset-evolution-word-splits.json`, JSON.stringify(SubsetEvolution.wordSplits, null, " "));
                                SubsetEvolution.wordSplitsLastSaved = now;
                            }
                        }
                    })()
                ]);
            }
        }
        catch (err: any) {
            console.error(`error while saving words to temp: ${err.message}`);
        }
    }

    private async traverseForId(elements: HTMLElement[], idExplicitInclusions?: IInclusionFilter[], idExplicitExclusions?: IExclusionFilter[]): Promise<HTMLElement | undefined> {
        for (const element of elements) {
            if ((element.id?.length ?? 0) > 0
                && await this.isIncluded(element.id, idExplicitInclusions)
                && !idExplicitExclusions?.some(exclusion =>
                    (!exclusion.type || exclusion.type === MarkerType.id)
                    && (!exclusion.element || (exclusion.element as HTMLElement[]).includes(element)
                        && ((exclusion.value instanceof String && exclusion.value === element.id)
                            || exclusion.value instanceof RegExp && exclusion.value.test(element.id)))))

                return element;

            if (element.childElementCount) {
                const result = await this.traverseForId([...element.children as any], idExplicitInclusions, idExplicitExclusions);
                if (result)
                    return result;
            }
        }
    }

    private async findLabel(topAnchor: HTMLElement, targets: HTMLElement[], idExplicitInclusions?: IInclusionFilter[], idExplicitExclusions?: IExclusionFilter[]): Promise<HTMLElement | undefined> {
        let anchor = chain(targets)
            .minBy(target => target.parentElement?.children
                ? [...target.parentElement?.children ?? null].indexOf(target)
                : Number.MAX_VALUE)
            .value();

        // try to find label with id first, those would make for stronger selector
        while (anchor != topAnchor) {
            const previousSibling = anchor.previousElementSibling as HTMLElement;

            let result: HTMLElement | undefined;

            // first try with the previous element
            if (previousSibling) {
                result = await this.traverseForId([previousSibling], idExplicitInclusions, idExplicitExclusions);

                if (result)
                    return result;
            }

            const stopAtElement = anchor;
            anchor = anchor.parentElement as HTMLElement;
            const precedingSiblings = takeWhile(anchor.children, child => child !== stopAtElement) as HTMLElement[];

            if (precedingSiblings?.length)
                result = await this.traverseForId(
                    precedingSiblings,
                    idExplicitInclusions,
                    idExplicitExclusions);

            if (result)
                return result;
        }
    }
}

export async function subsetEvolution(options: ISelectorLoomOptions): Promise<ISelector | null> {

    try {
        const results: IInternalSelector[] = [];
        const excludedMarkers: IElementMarker[] = [];
        let failureCount = 0;

        let processed = 0;

        if (!Array.isArray(options.examples))
            throw new Error("AsyncIterableIterator type example source is not supported yet");

        if (options.inclusions && !Array.isArray(options.inclusions))
            options.inclusions = [options.inclusions];

        if (options.exclusions && !Array.isArray(options.exclusions)) {
            options.exclusions = [options.exclusions];
            if (options.exclusions.some(exclusion => exclusion.element && !Array.isArray(exclusion.element)))
                for (const exclusion of options.exclusions)
                    if (exclusion.element && !Array.isArray(exclusion.element))
                        exclusion.element = [exclusion.element];
        }

        let examplesLeft = options.examples.length;
        const observeTimeBudget = (options.timeBudgetSec ?? 0) > 0;
        let timeBudgetSec = options.timeBudgetSec ?? 0;
        let i = 20;
        for (const example of options.examples) {
            const startAt = new Date();

            const result = await SubsetEvolution.generate(
                example.document,
                example.label,
                Array.isArray(example.target)
                    ? example.target
                    : [example.target],
                options.maxRecursion ?? 100,
                excludedMarkers,
                options.inclusions,
                options.exclusions,
                observeTimeBudget
                    ? Math.max(
                        1,
                        Math.round((timeBudgetSec / examplesLeft--) * i--))
                    : 0);

            if (!result) {
                failureCount++;

                if ((failureCount / options.examples.length) > (options.examplesFailureTolerance ?? 0))
                    return {
                        logs: [{
                            warn: `Failed to generate selector for example`,
                            code: "failed",
                            example,
                            timestamp: new Date()
                        }]
                    };
            }
            else
                results.push(result);

            if (options.progress)
                await options.progress(++processed);

            if (observeTimeBudget) {
                timeBudgetSec -= differenceInSeconds(new Date, startAt);
                if (timeBudgetSec <= 0) {
                    console.warn(`[selector-loom] ${warnExhaustedTimeBudget}`);
                    break;
                }
            }
        }

        const groups = chain(results)
            .groupBy(result => result?.selector)
            .orderBy(group => group.length, "desc")
            .value();

        if (groups.length > 1) {
            // Multiple versions of selectors were generated. Try to reconcile - start with the most common one and see if it would work for the rest of the examples which resulted in different selectors
            for (const currentGroup of groups) {
                const selectorCandidate = currentGroup[0]?.selector as string;
                if (chain(groups)
                    .filter(group => group !== currentGroup)
                    .flatten()
                    .every(internalSelector =>
                        SubsetEvolution.validateSelector(
                            selectorCandidate,
                            internalSelector.example.document.body,
                            Array.isArray(internalSelector.example.target)
                                ? internalSelector.example.target
                                : [internalSelector.example.target])
                            .valid)
                    .value()) {
                    return {
                        selector: selectorCandidate,
                        logs: (currentGroup[0]?.logs ?? [])
                            .concat({
                                info: `Example set resulted in ${groups.length} selector versions. A common version was found and successfully validated across the full set.`,
                                details: groups
                                    .map(group => ({
                                        selector: group[0].selector,
                                        count: group.length,
                                        examples: group.map(selector => selector.example)
                                    })),
                                timestamp: new Date()
                            })
                    }
                }
            }
        }

        let logs = results[0].logs;
        if (observeTimeBudget && timeBudgetSec < 0)
            logs = [...logs ?? [], {
                warn: warnExhaustedTimeBudget,
                code: "timeout",
                details: {
                    examples: options.examples.length,
                    processed: results.length
                },
                timestamp: new Date()
            }]

        return {
            selector: results[0].selector,
            logs,
        };
    }
    finally {
        await SubsetEvolution.saveWords();
    }
}