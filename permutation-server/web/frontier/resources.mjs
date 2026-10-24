// The eight resources of a holding's stores, in the kernel's order (the
// rules' `Resource`: a store's index, a production queue record's `arg`).
// The one list the page reads; names and icons are keyed by these names
// (fi18n.RESOURCES, hud/icons.mjs). No imports, so any module may use it.
export const RESOURCE_ORDER = Object.freeze(['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence']);
