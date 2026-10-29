// The ONLY path from untrusted input (spec, overlay, config) into generated source text.
// Every emitter builds identifiers, string literals and comments through these helpers.

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield await".split(" "),
);
const LINE_TERMINATORS = /\r\n|[\r\n\u2028\u2029]/;

/** Control characters and the two Unicode line separators would break or end a string literal. */
function needsUnicodeEscape(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
}

/** A string literal in single quotes (dist3 style); every character that could end or alter it is escaped. */
export function quote(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character === "\\" || character === "'") {
      escaped += `\\${character}`;
    } else if (needsUnicodeEscape(code)) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return `'${escaped}'`;
}

/** A literal for any JSON scalar value. */
export function literal(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return quote(value);
  }
  return String(value);
}

/** An object key or member name: bare when it is a plain identifier, quoted otherwise. */
export function propertyKey(name: string): string {
  if (IDENTIFIER_PATTERN.test(name)) {
    return name;
  }
  return quote(name);
}

/** Asserts that Stage 1 handed over a usable type or class name; a violation is an intermediate format bug, not user input to escape. */
export function identifier(name: string): string {
  if (!IDENTIFIER_PATTERN.test(name) || RESERVED_WORDS.has(name)) {
    throw new Error(`intermediate format contract: "${name}" is not a valid TypeScript identifier`);
  }
  return name;
}

/** A `/** … *\/` block. Lines are split on every line terminator, and `*\/` cannot close the comment early. */
export function docComment(lines: string[], indentation = ""): string {
  const commentLines: string[] = [];
  for (const line of lines) {
    for (const part of line.split(LINE_TERMINATORS)) {
      const safePart = part.replaceAll("*/", "*\\/");
      if (safePart === "") {
        commentLines.push(`${indentation} *`);
      } else {
        commentLines.push(`${indentation} * ${safePart}`);
      }
    }
  }
  if (commentLines.length === 0) {
    return "";
  }
  return `${indentation}/**\n${commentLines.join("\n")}\n${indentation} */\n`;
}
