import bs from "binary-search";
import jquery from "jquery";
import natural, { DataRecord } from "natural";
const { WordTokenizer, WordNet, NounInflector } = natural;
import _, { CollectionChain } from 'lodash';
const { chain, cloneDeep, last, orderBy } = _;

import { IElementMarker, IElementVolume, IInternalSelector, ISelector, IWeighted, MarkerType } from "./models.js";
import { ISelectorLoomOptions, IExclusionFilter, IInclusionFilter } from "./selector-loom-options.js";

const excludedAttributes = orderBy([
    "alt",
    "class",
    "style",
    "id",
    "src",
    "href",
    "background",
    "bgcolor",
    "border",
    "color",
    "disabled",
    "height",
    "hidden",
    "hreflang",
    "loading",
    "muted",
    "preload",
    "width"
]) as readonly string[];

const excludedWords = [
    "the"
]

const tokenizer = new WordTokenizer();
const nounInflector = new NounInflector();
const wordnet = new WordNet();

// const wordnetLookup

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

async function getWordRatio(value: string, explicitInclusions: IInclusionFilter[]): Promise<number> {
    let tokens = tokenizer.tokenize(value.replace(/[_0-9]+/g, " "));

    if (!tokens || tokens.length === 0)
        return 0;

    for (const inclusion of explicitInclusions) {
        if (inclusion.requiredWordsRatio <= 0 || inclusion.requiredWordsRatio > 1)
            throw new Error("Invalid requiredWordsRatio value");


        tokens = chain(tokens)
            .filter(word =>
                word.length >= (inclusion.minWordLength ?? 3)
                && !excludedWords.includes(word.toLowerCase()))
            .map(word => {
                // split camel-notation tokens
                const result: string[] = [];
                const camelCaseMatch = /[a-z][A-Z][a-z]{2}/g.exec(word);

                if (camelCaseMatch) {
                    for (const match of camelCaseMatch) {
                        const i = word.indexOf(match) + 1;
                        result.push(word.substring(0, i));
                        word = word.substring(i);
                    }
                    result.push(word);
                }
                else
                    result.push(word);

                return result;
            })
            .flatten()
            .filter(word => !excludedWords.includes(word.toLowerCase()))
            .value();
    }

    const wordTokens: string[] = [];
    await Promise.all(tokens
        .map(async word => {
            const result: DataRecord[] = await new Promise((accept, reject) =>
                wordnet.lookup(word, results => {
                    if (results.length > 0)
                        accept(results);
                    else
                        // try to singularize it - sometimes that results in better lookups for some words
                        wordnet.lookup(nounInflector.singularize(word), results => accept(results));
                }));

            if (result.length >= 1)
                wordTokens.push(word);
        }));

    return wordTokens.reduce((accum, word) => accum + word.length, 0) / value.replace(/[ \-_~:]+/g, "").length;
}

async function isIncluded(value: string, explicitInclusions?: IInclusionFilter[]): Promise<boolean> {
    if (explicitInclusions) {
        const wordsRatio = await getWordRatio(value, explicitInclusions);

        for (const inclusion of explicitInclusions)
            if (wordsRatio < inclusion.requiredWordsRatio)
                return false;
    }

    return true;
}

async function closestParentWithId(body: HTMLElement, target: HTMLElement, idExplicitInclusions?: IInclusionFilter[]): Promise<{ element: HTMLElement, depthDelta: number }> {
    let closestParentWithId = target;
    let depthDelta = 0;
    while (closestParentWithId !== body
        && (!closestParentWithId.id
            || !await isIncluded(closestParentWithId.id, idExplicitInclusions))) {
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

function isParent(target: HTMLElement, potentialParent: HTMLElement): Boolean {
    let parent = target.parentElement;
    while (parent) {
        if (parent === potentialParent)
            return true;
        parent = parent.parentElement
    }
    return false;
}

function weighted(list: string[] | IterableIterator<string>, distribution: Record<string, number>, type: MarkerType): IWeighted[] {
    return (
        Array.isArray(list)
            ? list
            : Array.from(list))
        .map(item => ({ type, item, weight: distribution[item] ?? -1 } as IWeighted));
}

function segmentedSelector(marker: IWeighted): (string | null)[] {
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

function merge(target: (string | null)[], source: IWeighted): (string | null)[] {
    let i = 0;
    for (const newSegment of segmentedSelector(source)) {
        if (newSegment) {
            const segment = target[i];
            target[i] = (segment ?? "") + newSegment;
        }
        i++;
    }

    return target;
}

function $markers(element: HTMLElement, classDistribution: Record<string, number>, attributeDistribution: Record<string, number>, tagDistribution: Record<string, number>): CollectionChain<IWeighted> {
    return chain(weighted(element.classList.values(), classDistribution, MarkerType.class))
        .concat(weighted(
            chain(element.getAttributeNames())
                .filter(attributeName => bs(excludedAttributes, attributeName, (a, b) => a < b ? -1 : a > b ? 1 : 0) < 0)
                .map(attributeName => `${attributeName}=${element.attributes.getNamedItem(attributeName)?.value}`)
                .value(),
            attributeDistribution,
            MarkerType.attribute))
        .concat(weighted([element.tagName], tagDistribution, MarkerType.tag))
        .filter(marker => marker.weight > 0);
}

function topMarker(element: HTMLElement, classDistribution: Record<string, number>, attributeDistribution: Record<string, number>, tagDistribution: Record<string, number>, usedMarkers?: IWeighted[],
    excludedMarkers?: IElementMarker[], userExclusions?: IExclusionFilter[]): IWeighted {

    return $markers(element, classDistribution, attributeDistribution, tagDistribution)

        .filter(marker =>

            usedMarkers?.some(usedMarker =>
                usedMarker.type === marker.type
                && usedMarker.item === marker.item) !== true

            && excludedMarkers?.some(excludedMarker =>
                excludedMarker.element === element
                && excludedMarker.type === marker.type
                && excludedMarker.item === marker.item) !== true

            && userExclusions?.some(userExclusion =>
                (!userExclusion.elements || userExclusion.elements === element)
                && (!userExclusion.type || userExclusion.type === marker.type)
                && ((userExclusion.value instanceof String && userExclusion.value === marker.item)
                    || userExclusion.value instanceof RegExp && userExclusion.value.test(marker.item))) !== true)

        .reduce((max, marker) => !max || marker.weight > max.weight ? marker : max)
        .value();
}

function volume(element: HTMLElement, depthDelta: number, classDistribution: Record<string, number>, attributeDistribution: Record<string, number>, tagDistribution: Record<string, number>): IElementVolume {
    const markers = $markers(element, classDistribution, attributeDistribution, tagDistribution)
        .orderBy(marker => marker.weight, "desc")
        .value();

    return {
        depthDelta,
        element,
        markers,
        selectorSegments: segmentedSelector(markers[0]),
        usedMarkers: markers.slice(0, 1)
    }
}

function selector(combinationSpace: IElementVolume[]): string {
    const subSelectors = chain(combinationSpace)
        .orderBy(elementSpace => elementSpace.depthDelta, "desc")
        .reduce(
            (accum, elementSpace, i) => {
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

function validateSelector(selector: string, anchor: HTMLElement, targets: HTMLElement[]) {
    const matches = anchor.querySelectorAll(selector);

    return {
        valid: matches.length === targets.length
            && [...matches].every(match => targets.includes(match as HTMLElement)),
        matches
    };
}

function anchorSelector(idElement: HTMLElement, anchorElement: HTMLElement, label: HTMLElement | undefined, strategy: Strategy) {
    if (!label)
        return "";

    const neighboringParents = strategy === Strategy.LabelTargetNeighboringParents;
    if (neighboringParents)
        anchorElement = anchorElement.previousElementSibling as HTMLElement;

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

async function subsetEvolutionInternal(document: Document, label: HTMLElement | undefined, targets: HTMLElement[], maxRecursion: number, excludedMarkers: IElementMarker[], userInclusions?: IInclusionFilter[], userExclusions?: IExclusionFilter[]): Promise<IInternalSelector | null> {
    if (!document)
        throw new Error(`document is required`);

    if (!targets?.length)
        throw new Error(`At least one target is required`);

    if (label && (label.textContent?.trim() ?? "") === "")
        throw new Error(`Label needs to contain text`);

    if (targets.every(target => target.id !== undefined && target.id !== null && target.id.trim() !== ""))
        return {
            selector: `#${targets[0].id}`,
            example: {
                document,
                target: targets
            }
        };

    const allAnchors = await Promise.all(targets
        .concat(label ? [label] : [])
        .map(target => closestParentWithId(
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

    let anchorParent!: {
        element: HTMLElement;
        depthDelta: number;
    };

    if (!label)
        anchorParent = idParent
    else {
        let commonParent = label.parentElement;
        let depthDelta = 1;
        while (commonParent) {
            if (targets.every(target => isParent(target, commonParent as HTMLElement)))
                break;

            commonParent = commonParent.parentElement;
            depthDelta++;
        }

        if (commonParent === idParent.element)
            anchorParent = idParent
        else {
            if (!commonParent)
                throw new Error("Could not find common parent for label and target(s)");

            if (!isParent(commonParent, idParent.element))
                throw new Error("Common parent between label and target(s) is expected to be under idParent");

            anchorParent = {
                element: commonParent,
                depthDelta
            }
        }
    }

    let retry = false;
    let strategy = Strategy.AnchorAsCommonParent;
    do {
        retry = false;

        const classDistribution: Record<string, number> = {};
        const attributeDistribution: Record<string, number> = {};
        const tagDistribution: Record<string, number> = {};

        const elements = anchorParent.element.querySelectorAll("*");
        const distanceWeightReductionFactor = 1.0 / anchorParent.depthDelta;
        const classListImplicitInclusions = userInclusions?.filter(inclusion => inclusion.type === MarkerType.class || !inclusion.type);
        const attributeValueImplicitInclusions = userInclusions?.filter(inclusion => inclusion.type === MarkerType.attribute || !inclusion.type);

        for (const element of elements) {
            for (const className of element.classList) {
                if (userExclusions?.some(exclusion =>
                    (!exclusion.elements || exclusion.elements === element)
                    && (!exclusion.type || exclusion.type === MarkerType.class)
                    && (exclusion.value === undefined || exclusion.value === className))
                    || !await isIncluded(className, classListImplicitInclusions))
                    continue;

                const count = classDistribution[className];
                classDistribution[className] = (count ?? 0) + 1;
            }

            for (const attribute of element.attributes) {
                const attributeName = attribute.name;
                if (excludedAttributes.includes(attributeName)
                    || attributeName.startsWith("aria"))
                    continue;

                if (userExclusions?.some(exclusion =>
                    (!exclusion.elements || exclusion.elements === element)
                    && (!exclusion.type || exclusion.type === MarkerType.attribute)
                    && (exclusion.value === undefined || exclusion.value === attributeName))
                    || !await isIncluded(attribute.value, attributeValueImplicitInclusions))
                    continue;

                const attributeLabel = `${attributeName}=${attribute.value}`;
                const count = attributeDistribution[attributeLabel];
                attributeDistribution[attributeLabel] = (count ?? 0) + 1;
            }

            if (userExclusions?.some(exclusion =>
                (!exclusion.elements || exclusion.elements === element)
                && (!exclusion.type || exclusion.type === MarkerType.tag)
                && (exclusion.value === undefined || exclusion.value === element.tagName)))
                continue;

            const count = tagDistribution[element.tagName];
            tagDistribution[element.tagName] = (count ?? 0) + 1;
        }

        let combinationSpace: IElementVolume[] = [volume(
            targets[0],
            0,
            classDistribution,
            attributeDistribution,
            tagDistribution)];

        let lastCombinationSpace: IElementVolume[] | undefined;
        let mutationMarker: IElementMarker | undefined;
        excludedMarkers = excludedMarkers ?? [];

        do {
            const selectorCandidate = selector(combinationSpace);
            const validationResult = validateSelector(selectorCandidate, anchorParent.element, targets);

            if (validationResult.valid) {

                const anchorSelectorVal = anchorSelector(
                    idParent.element,
                    anchorParent.element,
                    label,
                    strategy);

                return {
                    combinationSpace,
                    selector: idParent.element.id
                        ? `#${idParent.element.id} ${anchorSelectorVal}${selectorCandidate}`
                        : selectorCandidate,
                    ...(excludedMarkers.length ? { excludedMarkers } : undefined),
                    example: {
                        document,
                        target: targets
                    }
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

                    const newMarker = topMarker(
                        elementVolume.element,
                        classDistribution,
                        attributeDistribution,
                        tagDistribution,
                        elementVolume.usedMarkers,
                        excludedMarkers,
                        userExclusions);

                    if (newMarker) {
                        const mutatedElementVolume = {
                            depthDelta: elementVolume.depthDelta,
                            element: elementVolume.element,
                            selectorSegments: merge(cloneDeep(elementVolume.selectorSegments), newMarker),
                            markers: elementVolume.markers,
                            usedMarkers: elementVolume.usedMarkers.concat(newMarker)
                        } as IElementVolume;

                        const mutatedCombinationSpace = combinationSpace.map(eVol => eVol === elementVolume ? mutatedElementVolume : eVol);
                        const mutatedSelectorCandidate = selector(combinationSpace);
                        const matches = anchorParent.element.querySelectorAll(mutatedSelectorCandidate);

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
                    if (nextParentElement === anchorParent.element)
                        return [];

                    const depthDelta = lastCombinationSpace.depthDelta + 1;

                    const newElementVolume = volume(
                        nextParentElement,
                        depthDelta,
                        classDistribution,
                        attributeDistribution,
                        tagDistribution
                    );
                    const mutatedCombinationSpace = combinationSpace.concat(newElementVolume);

                    const mutatedSelectorCandidate = selector(combinationSpace);
                    const matches = anchorParent.element.querySelectorAll(mutatedSelectorCandidate);

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

            // cant 
            if (!mutation) {
                if (label && strategy === Strategy.AnchorAsCommonParent) {
                    strategy = Strategy.LabelTargetNeighboringParents;
                    const newAnchorParentElement = [...anchorParent.element.children]
                        .find(closerParent => targets.every(target => isParent(target, closerParent as HTMLElement))) as HTMLElement | undefined;

                    if (!newAnchorParentElement)
                        throw new Error("Could not find nested parent for the sibling relationship strategy");

                    anchorParent = {
                        element: newAnchorParentElement,
                        depthDelta: anchorParent.depthDelta - 1
                    };
                    retry = true;
                }

                break;
            }

            lastCombinationSpace = combinationSpace;
            mutationMarker = mutation.mutationMarker;
            combinationSpace = mutation.combinationSpace;
        }
        while (maxRecursion--);
    }
    while (retry)

    return null;
}

export async function subsetEvolution(options: ISelectorLoomOptions): Promise<ISelector | null> {

    const results: IInternalSelector[] = [];
    const excludedMarkers: IElementMarker[] = [];

    for await (const example of options.examples) {
        const result = await subsetEvolutionInternal(
            example.document,
            example.label,
            Array.isArray(example.target)
                ? example.target
                : [example.target],
            options.maxRecursion ?? 100,
            excludedMarkers,
            !options.inclusions || Array.isArray(options.inclusions) ? options.inclusions : [options.inclusions],
            !options.exclusions || Array.isArray(options.exclusions) ? options.exclusions : [options.exclusions]);

        if (!result)
            return null;

        results.push(result);
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
                    validateSelector(
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
                            "info": `Example set resulted in ${groups.length} selector versions. A common version was found and successfully validated across the full set.`,
                            "details": groups
                                .map(group => ({
                                    selector: group[0].selector,
                                    count: group.length,
                                    examples: group.map(selector => selector.example)
                                }))
                        })
                }
            }
        }
    }

    return {
        selector: results[0].selector,
        logs: results[0].logs
    };
}