// Painted citizen busts. The atlas is local presentation data; neither a
// name nor an on-chain identity depends on this artwork.
export const PORTRAIT_ART_URL = new URL('../art/people/wylls-citizens-v2.png', import.meta.url).href;
export const PORTRAIT_COLUMNS = 4;
export const PORTRAIT_ROWS = 3;

/** Two tabletop characters per faction, with a stable citizen-tag choice. */
export function portraitCell(identity, faction) {
  const pair = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : 0;
  const variant = (Number.parseInt(String(identity?.tag ?? '0').slice(-1), 16) || 0) & 1;
  const index = pair * 2 + variant;
  return { index, column: index % PORTRAIT_COLUMNS, row: Math.floor(index / PORTRAIT_COLUMNS) };
}

let atlas = null;
/** One same-origin decode shared by all map portraits, including failed loads. */
export function portraitAtlas(onSettled = () => {}) {
  if (atlas) {
    if (atlas.status === 'loading') atlas.listeners.add(onSettled);
    return atlas;
  }
  atlas = { status: 'loading', image: null, listeners: new Set([onSettled]) };
  const settle = (status, image = null) => {
    atlas.status = status;
    atlas.image = image;
    const listeners = [...atlas.listeners];
    atlas.listeners.clear();
    for (const listener of listeners) listener();
  };
  if (typeof globalThis.Image !== 'function') {
    settle('failed');
    return atlas;
  }
  const image = new globalThis.Image();
  image.onload = () => image.naturalWidth >= PORTRAIT_COLUMNS && image.naturalHeight >= PORTRAIT_ROWS
    ? settle('ready', image) : settle('failed');
  image.onerror = () => settle('failed');
  image.src = PORTRAIT_ART_URL;
  return atlas;
}
