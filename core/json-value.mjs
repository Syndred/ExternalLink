// PostgreSQL jsonb changes object key order. Array order and actual values
// still matter when confirming an original write or immutable media version.
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const jsonValueEqual=(left,right)=>JSON.stringify(stable(left))===JSON.stringify(stable(right));
