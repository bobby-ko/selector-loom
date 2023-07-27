import { IExample } from "./selector-loom-options"

export enum MarkerType {
    id = 1,
    tag,
    class,
    attribute
}

export interface IMarker {
    type: MarkerType,
    item: string
}

export interface IWeighted extends IMarker {
    weight: number
}

export interface IElementVolume {
    depthDelta: number,
    element: HTMLElement,
    selectorSegments: (string | null)[],
    markers: IWeighted[],
    usedMarkers: IWeighted[]
}

export interface IElementMarker extends IMarker {
    element: HTMLElement
}

export interface ISelector {
    selector?: string,
    logs?: Record<string, any>[]
}

export interface IInternalSelector extends ISelector {
    combinationSpace?: IElementVolume[],
    excludedMarkers?: IElementMarker[],
    example: IExample
}
