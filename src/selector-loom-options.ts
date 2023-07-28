import { MarkerType } from "./models.js"

export interface IExample {
    document: Document,
    label?: "auto" | HTMLElement,
    target: HTMLElement | HTMLElement[]

    /** User metadata/reference records. These are not intended to by the algorithm, but rather for tracing & debugging purposes */
    metadata?: Record<string, any>;
}

export interface IExclusionFilter {
    element?: HTMLElement | HTMLElement[],
    type?: MarkerType,
    value?: string | RegExp
}

export interface IInclusionFilter {
    type?: MarkerType.id | MarkerType.class | MarkerType.attribute,
    /** Minimum ratio of recognizable english words in value to be considered for use. Ratio is calculated as sum of all recognizable words' lengths relative to token's size */
    requiredWordsRatio: number,
    /** Minimum number of letters for a token to be considered a word. Defaults is 3 */
    minWordLength?: number,
    /** Defaults is 'en' */
    languages?: string[]
}

export enum Algorithm {
    /**
     * This algorithm works in two parts:
     * 1. Tries to identify the closest parent element with ID and uses that for the beginning section of the final selector. This results in a smaller sub-DOM where the targets reside. 
     * 2. Evolves an optimized non-id sub-selector based on statistically-weighted markers (classes, attributes, tag names, relative positions) 
     * 
     * Other then the case where the target's id can be used, this algorithm is not guaranteed to produce the most optimal selector. It will, however produce a fairly optimized one,
     * because it mutates and evolves the selector, beginning from the simplest possible version, and gradually adding significance-weighted markers until it converges on a working version.
     */
    SubsetEvolution
}

export interface ISelectorLoomOptions {
    /** The algorithm used to generate the selector. Defaults to SubsetEvolution if not specified */
    algorithm?: Algorithm,

    examples: IExample[] | AsyncIterableIterator<IExample>,

    /** Specifies acceptable examples selector generation failure. Value is fraction between 0 and 1. 
     * Default is 0 which means all examples need to successfully generate a selector to consider, otherwise the whole operation is considered a failure */
    examplesFailureTolerance?: number,

    maxRecursion?: number,

    /** If set, restricts classNames and/or attribute values only to the ones that are composed of number of english words that make up a certain ratio of the total selector */
    inclusions?: IInclusionFilter | IInclusionFilter[],

    /** One or more marker exclusion filters. Can be as broad or as narrow as:
     * - (exclude) "all class names that begin with 'cz-'" 
     * - (exclude) "attribute "data-custom" for specific element X"
     * */
    exclusions?: IExclusionFilter | IExclusionFilter[],

    progress?: (processed: number) => Promise<void> | void
}