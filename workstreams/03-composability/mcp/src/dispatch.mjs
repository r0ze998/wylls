// tools/call's lookup of a tool by name (server.mjs handle). Pure: no imports, no I/O.
//
// The tools are a plain object, so `tools[name]` also finds what every object inherits: `constructor` (Object, which
// returned the caller's own principal as a result), `__proto__`, `hasOwnProperty`, `toString`, … Only the tools'
// own names are tools; anything else — an inherited name, a name that is not a string (JSON gives null, numbers,
// booleans, arrays, objects), or none — is the existing "unknown tool" answer (-32602), and the name is echoed only
// when it is a string (String() of a JSON object whose own toString is not a function throws).

/** The tool `name` names among `tools`' own properties, or null. */
export const toolNamed = (tools, name) => (typeof name === 'string' && Object.hasOwn(tools, name) && typeof tools[name] === 'function' ? tools[name] : null);

/** The text of the -32602 answer: the name (at most 40 characters) when it is a string, else what kind of value it was. */
export const unknownToolText = name => `unknown tool ${typeof name === 'string' ? name.slice(0, 40) : name === null ? 'null' : Array.isArray(name) ? 'array' : typeof name}`;
