// node:path for the browser bundle (only join/dirname, as make-fixtures.mjs uses them to name the files it reads).
export const join = (...parts) => parts.join('/');
export const dirname = p => String(p).replace(/\/[^/]*$/, '');
export const extname = p => (/\.[^./]*$/.exec(String(p))?.[0] ?? '');
export const normalize = p => String(p);
export const sep = '/';
export default { join, dirname, extname, normalize, sep };
