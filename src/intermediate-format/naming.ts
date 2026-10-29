// Name decisions live in Stage 1; Stage 2 only escapes what it is given.

function splitWords(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function lowercaseFirst(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1);
}

/** `get-systems` → `GetSystems`, `Issue custom field values (apps)` → `IssueCustomFieldValuesApps`; inner capitals are kept. */
export function pascal(text: string): string {
  const joined = splitWords(text).map(capitalize).join("");
  if (joined === "") {
    return "_";
  }
  // An identifier cannot start with a digit.
  if (/^[0-9]/.test(joined)) {
    return `_${joined}`;
  }
  return joined;
}

/** `get-systems` → `getSystems`, `GetPet` → `getPet`. */
export function camel(text: string): string {
  const pascalName = pascal(text);
  if (pascalName.startsWith("_")) {
    return pascalName;
  }
  return lowercaseFirst(pascalName);
}

/** `Issue custom field values (apps)` → `issue-custom-field-values-apps`. */
export function kebab(text: string): string {
  const joined = splitWords(text).join("-").toLowerCase();
  if (joined === "") {
    return "_";
  }
  return joined;
}

// Words (starting with a letter) joined by `-`, `_`, `.` or spaces, after optional leading `_`/`$`.
const RENAMEABLE_PROPERTY = /^[_$]*[A-Za-z][A-Za-z0-9_\-. ]*$/;

/**
 * Naming transform for properties: `first_name` → `firstName`, `last-login` → `lastLogin`.
 * Leading `_` and `$` are kept (`_id` stays `_id`), and names that are already camelCase do not change.
 * Names that are not words and separators (`+1`, `-1`, `16x16`, `a+b`) keep their spelling: dropping their
 * symbols would lose meaning and make names collide.
 */
export function camelProperty(name: string): string {
  if (!RENAMEABLE_PROPERTY.test(name)) {
    return name;
  }
  const prefix = /^[_$]*/.exec(name)![0];
  const words = splitWords(name.slice(prefix.length));
  if (words.length === 0) {
    return name;
  }
  const [firstWord, ...otherWords] = words;
  return prefix + lowercaseFirst(firstWord!) + otherWords.map(capitalize).join("");
}
