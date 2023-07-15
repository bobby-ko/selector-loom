export enum MarkerType {
    "tag",
    "class",
    "attribute"
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
    combinationSpace?: IElementVolume[],
    selector: string,
    excludedMarkers?: IElementMarker[]
}
