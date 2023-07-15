import { ISelector } from "./models.js";
import { Algorithm, ISelectorLoomOptions } from "./selector-loom-options.js";
import { subsetEvolution } from "./subset-evolution.js";

export { Algorithm, ISelectorLoomOptions, IExample, IExclusionFilter } from "./selector-loom-options.js";
export { ISelector, MarkerType, IElementVolume, IElementMarker } from "./models.js";

/**
 * Tries to constructs a unique and optimized CSS selector for all the target elements, and only the target elements, across all the provided examples.
 * 
 * Note! It is important to provide consistent targets across the examples 
 * 
 * @param options input options as defined by ISelectorLoomOptions
 * @returns An ISelector result or null if a selector could not be constructed. The selector is guaranteed to match all the targets, and only the targets
 * @exceptions Exceptions can be thrown for the following cases:
 * - example targets have highly divergent parent chains
 * - invalid/missing input
 * - broken DOMs
 */
export function selectorLoom(options: ISelectorLoomOptions): Promise<ISelector | null> {
    if (!options.examples)
        throw new Error(`examples is expected`);

    if (Array.isArray(options.exclusions)
        && options.exclusions.some(exclusion => !exclusion.elements && !exclusion.type && !exclusion.value) === true)
        throw new Error(`Exclusions cannot have all blank criteria.`);

    switch (options.algorithm ?? Algorithm.SubsetEvolution)
    {
        case Algorithm.SubsetEvolution:
            return subsetEvolution(options);
    }
}