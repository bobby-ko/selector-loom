import { MarkerType } from "./models.js"

export interface IExample { 
    document: Document,
    target: HTMLElement | HTMLElement[]
}

export interface IExclusionFilter {
    elements?: Element,
    type?: MarkerType,
    value?: string | RegExp
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

    maxRecursion?: number,

    /** One or more marker exclusion filters. Can be as broad or as narrow as:
     * - (exclude) "all class names that begin with 'cz-'" 
     * - (exclude) "attribute "data-custom" for specific element X"
     * */
    exclusions?: IExclusionFilter | IExclusionFilter[]
}