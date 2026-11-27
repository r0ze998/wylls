// node:url for the browser bundle.
export const fileURLToPath = u => String(u?.href ?? u);
export const pathToFileURL = p => new URL(String(p), 'file:///');
export default { fileURLToPath, pathToFileURL };
