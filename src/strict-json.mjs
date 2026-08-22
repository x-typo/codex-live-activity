export const MAX_STRICT_JSON_DEPTH = 64;

const JSON_WHITESPACE = new Set(["\u0009", "\u000a", "\u000d", "\u0020"]);
const HEX_DIGIT = /^[0-9A-Fa-f]$/u;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;

function syntaxError() {
  return new SyntaxError("invalid JSON");
}

function duplicateMemberError() {
  return new SyntaxError("duplicate JSON member");
}

export function parseJsonRejectingDuplicateMembers(raw, {
  maxDepth = MAX_STRICT_JSON_DEPTH,
} = {}) {
  if (typeof raw !== "string") throw new TypeError("raw JSON must be a string");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError("maxDepth must be a positive safe integer");
  }

  let index = 0;

  const skipWhitespace = () => {
    while (index < raw.length && JSON_WHITESPACE.has(raw[index])) index += 1;
  };

  const scanString = () => {
    if (raw[index] !== '"') throw syntaxError();
    const start = index;
    index += 1;
    while (index < raw.length) {
      const character = raw[index];
      if (character === '"') {
        index += 1;
        return raw.slice(start, index);
      }
      if (character.charCodeAt(0) <= 0x1f) throw syntaxError();
      if (character !== "\\") {
        index += 1;
        continue;
      }

      index += 1;
      if (index >= raw.length) throw syntaxError();
      if ('"\\/bfnrt'.includes(raw[index])) {
        index += 1;
        continue;
      }
      if (raw[index] !== "u") throw syntaxError();
      index += 1;
      for (let offset = 0; offset < 4; offset += 1) {
        if (index >= raw.length || !HEX_DIGIT.test(raw[index])) {
          throw syntaxError();
        }
        index += 1;
      }
    }
    throw syntaxError();
  };

  const scanNumber = () => {
    JSON_NUMBER.lastIndex = index;
    const match = JSON_NUMBER.exec(raw);
    if (match === null) throw syntaxError();
    index = JSON_NUMBER.lastIndex;
  };

  const scanLiteral = (literal) => {
    if (!raw.startsWith(literal, index)) throw syntaxError();
    index += literal.length;
  };

  const scanValue = (depth) => {
    skipWhitespace();
    const character = raw[index];
    if (character === '"') {
      scanString();
      return;
    }
    if (character === "{") {
      scanObject(depth + 1);
      return;
    }
    if (character === "[") {
      scanArray(depth + 1);
      return;
    }
    if (character === "t") {
      scanLiteral("true");
      return;
    }
    if (character === "f") {
      scanLiteral("false");
      return;
    }
    if (character === "n") {
      scanLiteral("null");
      return;
    }
    scanNumber();
  };

  const assertDepth = (depth) => {
    if (depth > maxDepth) throw syntaxError();
  };

  const scanObject = (depth) => {
    assertDepth(depth);
    index += 1;
    skipWhitespace();
    if (raw[index] === "}") {
      index += 1;
      return;
    }

    const names = new Set();
    while (index < raw.length) {
      skipWhitespace();
      const encodedName = scanString();
      const name = JSON.parse(encodedName);
      if (names.has(name)) throw duplicateMemberError();
      names.add(name);

      skipWhitespace();
      if (raw[index] !== ":") throw syntaxError();
      index += 1;
      scanValue(depth);
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      if (raw[index] !== ",") throw syntaxError();
      index += 1;
    }
    throw syntaxError();
  };

  const scanArray = (depth) => {
    assertDepth(depth);
    index += 1;
    skipWhitespace();
    if (raw[index] === "]") {
      index += 1;
      return;
    }

    while (index < raw.length) {
      scanValue(depth);
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      if (raw[index] !== ",") throw syntaxError();
      index += 1;
    }
    throw syntaxError();
  };

  scanValue(0);
  skipWhitespace();
  if (index !== raw.length) throw syntaxError();
  return JSON.parse(raw);
}
