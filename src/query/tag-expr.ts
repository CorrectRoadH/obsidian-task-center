// US-109d4: tag boolean expressions. Parse a free-form string like
// "(#a or #b) and not #c" into an AST, evaluate it against a task's tags, and
// convert between the AST and the three-state selection (US-109d3) so the
// visual ⇄ expression handoff is lossless where it fits.
//
// Grammar (precedence not > and > or):
//   or    := and ('or' and)*
//   and   := unary ('and' unary)*
//   unary := 'not' unary | atom
//   atom  := TAG | '(' or ')'
// Keywords and/or/not are case-insensitive and only recognized as bare words;
// a `#and` token (with the hash) is a tag. Tags are normalized to lowercase
// with a leading `#`. Pure logic — no DOM, no i18n.

export type TagExprNode =
  | { type: "tag"; tag: string }
  | { type: "not"; operand: TagExprNode }
  | { type: "and"; left: TagExprNode; right: TagExprNode }
  | { type: "or"; left: TagExprNode; right: TagExprNode };

export interface TagExprParseResult {
  ast: TagExprNode | null;
  error: string | null;
  /** One-based character position in the original input (EOF = length + 1). */
  position?: number;
}

type Token = { start: number } & (
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "not" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "tag"; tag: string });

function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return withHash.toLowerCase();
}

function tokenize(input: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", start: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", start: i });
      i++;
      continue;
    }
    // A word: run of non-space, non-paren characters.
    let j = i;
    while (j < input.length && !" \t\n\r()".includes(input[j])) j++;
    const word = input.slice(i, j);
    const start = i;
    i = j;
    const lower = word.toLowerCase();
    // Bare keywords (no leading #) are operators; anything else is a tag.
    if (!word.startsWith("#") && (lower === "and" || lower === "or" || lower === "not")) {
      tokens.push({ kind: lower, start });
    } else {
      tokens.push({ kind: "tag", tag: normalizeTag(word), start });
    }
  }
  return { tokens, error: null };
}

export function parseTagExpr(input: string): TagExprParseResult {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return { ast: null, error: "empty", position: 1 };
  const { tokens } = tokenize(input);
  if (tokens.length === 0) return { ast: null, error: "empty", position: 1 };

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  // Forward declarations via function hoisting.
  function parseOr(): TagExprNode {
    let node = parseAnd();
    while (peek()?.kind === "or") {
      pos++;
      const right = parseAnd();
      node = { type: "or", left: node, right };
    }
    return node;
  }
  function parseAnd(): TagExprNode {
    let node = parseUnary();
    while (peek()?.kind === "and") {
      pos++;
      const right = parseUnary();
      node = { type: "and", left: node, right };
    }
    return node;
  }
  function parseUnary(): TagExprNode {
    if (peek()?.kind === "not") {
      pos++;
      return { type: "not", operand: parseUnary() };
    }
    return parseAtom();
  }
  function parseAtom(): TagExprNode {
    const tok = peek();
    if (!tok) throw new Error("unexpected end of expression");
    if (tok.kind === "tag") {
      pos++;
      return { type: "tag", tag: tok.tag };
    }
    if (tok.kind === "lparen") {
      pos++;
      const inner = parseOr();
      if (peek()?.kind !== "rparen") throw new Error("missing closing parenthesis");
      pos++;
      return inner;
    }
    throw new Error(`unexpected token "${tok.kind}"`);
  }

  try {
    const ast = parseOr();
    if (pos !== tokens.length) {
      return { ast: null, error: "unexpected token", position: (peek()?.start ?? input.length) + 1 };
    }
    return { ast, error: null };
  } catch (e) {
    return { ast: null, error: e instanceof Error ? e.message : "parse error", position: (peek()?.start ?? input.length) + 1 };
  }
}

export function evalTagExpr(node: TagExprNode, taskTags: string[]): boolean {
  const lower = new Set(taskTags.map((t) => t.toLowerCase()));
  const ev = (n: TagExprNode): boolean => {
    switch (n.type) {
      case "tag":
        return lower.has(n.tag);
      case "not":
        return !ev(n.operand);
      case "and":
        return ev(n.left) && ev(n.right);
      case "or":
        return ev(n.left) || ev(n.right);
    }
  };
  return ev(node);
}

// US-109d4: build an equivalent expression string from a legacy three-state
// selection. Used to (a) keep old `tags` shapes working through the unified
// expression evaluator, and (b) prefill the expression input when a user opens a
// tag filter that was saved in the old shape.
export function tagSelectionToExpr(
  include: string[],
  mode: "and" | "or",
  exclude: string[],
): string {
  const inc = [...new Set(include.map(normalizeTag))];
  // Exclude is deduped and made mutually exclusive with include (include wins).
  const exc = [...new Set(exclude.map(normalizeTag))].filter((t) => !inc.includes(t));
  const segs: string[] = [];
  if (inc.length > 0) {
    const joined = inc.join(mode === "or" ? " or " : " and ");
    // Parenthesize an OR include group when other AND-conjuncts (excludes) follow,
    // to preserve `not` > `and` > `or` precedence.
    segs.push(mode === "or" && inc.length > 1 && exc.length > 0 ? `(${joined})` : joined);
  }
  for (const ex of exc) segs.push(`not ${ex}`);
  return segs.join(" and ");
}

// US-109d4: append a tag to an existing expression (the "click a tag to insert"
// affordance). First tag goes in bare; subsequent tags are AND-appended. The
// tag is normalized (#-prefixed, lowercased) to match the evaluator.
export function appendTagToExpr(expr: string, tag: string): string {
  const t = normalizeTag(tag);
  const trimmed = expr.trim();
  if (!trimmed) return t;
  const { tokens } = tokenize(trimmed);
  const last = tokens[tokens.length - 1];
  if (last && ["and", "or", "not", "lparen"].includes(last.kind)) return `${trimmed} ${t}`;
  const { ast } = parseTagExpr(trimmed);
  return `${ast?.type === "or" ? `(${trimmed})` : trimmed} and ${t}`;
}

export { normalizeTag };
