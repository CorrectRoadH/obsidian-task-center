// ARCHITECTURE.md §1.3.1 / US-109p11: pure, immutable editing operators for the
// `view.layout` tree. The视图层 (drag handlers, buttons) never hand-mutates the
// tree; it calls these and writes the result back into the tab draft. Inputs and
// outputs are LayoutNode; operators never throw — a bad path returns the tree
// unchanged. `normalizeQueryPreset` re-validates on write-back, so callers don't
// have to defend against illegal shapes here.

import type {
  AreaBase,
  AreaConfig,
  AreaType,
  GridAreaConfig,
  LayoutNode,
  ListAreaConfig,
  StackConfig,
} from "./types";
import { isStackNode } from "./types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A path from the root: a sequence of `children` indices. `[]` is the root. */
export type LayoutPath = number[];

/** Resolve the node at `path`, or null when the path doesn't exist. */
export function nodeAt(layout: LayoutNode, path: LayoutPath): LayoutNode | null {
  let cur: LayoutNode = layout;
  for (const idx of path) {
    if (!isStackNode(cur)) return null;
    const next = cur.children[idx];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/**
 * Replace the node at `path` with `replacer(node)`. When `replacer` returns
 * null the node is removed (and an emptied stack collapses). Returns a new tree.
 */
function editAt(
  layout: LayoutNode,
  path: LayoutPath,
  replacer: (node: LayoutNode) => LayoutNode | null,
): LayoutNode {
  if (path.length === 0) {
    return replacer(clone(layout)) ?? defaultLayout();
  }
  const root = clone(layout);
  const [head, ...rest] = path;
  if (!isStackNode(root)) return layout; // path points past a leaf — no-op
  const child = root.children[head];
  if (!child) return layout;
  if (rest.length === 0) {
    const replaced = replacer(child);
    if (replaced === null) {
      root.children.splice(head, 1);
    } else {
      root.children[head] = replaced;
    }
  } else {
    root.children[head] = editAt(child, rest, replacer);
  }
  return collapse(root);
}

/** Drop stacks that ended up with 0 children; unwrap single-child? — kept as-is
 *  so users can keep an intentional 1-child container. Empty root → default. */
function collapse(node: LayoutNode): LayoutNode {
  if (!isStackNode(node)) return node;
  if (node.children.length === 0) return defaultLayout();
  return node;
}

function defaultLayout(): LayoutNode {
  return { type: "list" };
}

// ── Area-leaf addressing by DFS index (matches collectAreas order) ──

/** DFS path to the Nth area leaf, or null. Mirrors collectAreas() ordering. */
export function pathToAreaIndex(layout: LayoutNode, areaIndex: number): LayoutPath | null {
  let seen = 0;
  let found: LayoutPath | null = null;
  const walk = (node: LayoutNode, path: LayoutPath): void => {
    if (found) return;
    if (isStackNode(node)) {
      node.children.forEach((c, i) => walk(c, [...path, i]));
      return;
    }
    if (seen === areaIndex) found = path;
    seen += 1;
  };
  walk(layout, []);
  return found;
}

/** Replace the Nth area leaf with `fn(area)`. */
export function mapAreaAt(
  layout: LayoutNode,
  areaIndex: number,
  fn: (area: AreaConfig) => AreaConfig,
): LayoutNode {
  const path = pathToAreaIndex(layout, areaIndex);
  if (!path) return layout;
  return editAt(layout, path, (node) => (isStackNode(node) ? node : fn(node)));
}

/**
 * Change the Nth area's `type`, preserving the AreaBase fields (id / title /
 * weight / onDrop) and dropping type-incompatible fields. This replaces the old
 * buildLayoutForAreaType, which rebuilt the WHOLE tree (US-109p11 bug fix): here
 * only this one leaf changes; siblings and structure are untouched.
 */
export function setAreaType(layout: LayoutNode, areaIndex: number, type: AreaType): LayoutNode {
  return mapAreaAt(layout, areaIndex, (area) => {
    const base: AreaBase = {};
    if (area.id !== undefined) base.id = area.id;
    if (area.title !== undefined) base.title = area.title;
    if (area.weight !== undefined) base.weight = area.weight;
    switch (type) {
      case "list":
      case "grid": {
        const next: ListAreaConfig | GridAreaConfig = { ...base, type };
        // Carry over list/grid-only fields when converting between the two.
        if (area.type === "list" || area.type === "grid") {
          if (area.when) next.when = area.when;
          if (area.orderBy) next.orderBy = area.orderBy;
          if (area.limit !== undefined) next.limit = area.limit;
          if (area.emptyText) next.emptyText = area.emptyText;
        }
        return next;
      }
      case "week":
        return { ...base, type: "week" };
      case "month":
        return { ...base, type: "month" };
      case "drop":
        return { ...base, type: "drop", onDrop: { setStatus: "dropped" } };
      default:
        return area;
    }
  });
}

// ── Structural operators (addressed by container path) ──

/** Insert `area` as a child of the stack at `parentPath`, at `index`. When the
 *  root is a single area, it's first wrapped into a `col` so the new area has a
 *  home. */
export function insertNode(
  layout: LayoutNode,
  parentPath: LayoutPath,
  index: number,
  node: LayoutNode,
): LayoutNode {
  // Root is a bare area: wrap into a col, then the parentPath [] targets it.
  if (parentPath.length === 0 && !isStackNode(layout)) {
    const wrapped: StackConfig = { dir: "col", children: [clone(layout)] };
    const at = Math.max(0, Math.min(index, wrapped.children.length));
    wrapped.children.splice(at, 0, clone(node));
    return wrapped;
  }
  return editAt(layout, parentPath, (parent) => {
    if (!isStackNode(parent)) return parent;
    const at = Math.max(0, Math.min(index, parent.children.length));
    parent.children.splice(at, 0, clone(node));
    return parent;
  });
}

/** Append a new default list area to the root container (US-109p11 「＋添加区域」). */
export function appendArea(layout: LayoutNode, area: LayoutNode = defaultLayout()): LayoutNode {
  if (!isStackNode(layout)) {
    return { dir: "col", children: [clone(layout), clone(area)] };
  }
  return insertNode(layout, [], layout.children.length, area);
}

/** Remove the node at `path`. Emptied stacks collapse; an empty root falls back
 *  to a single default list. */
export function removeNode(layout: LayoutNode, path: LayoutPath): LayoutNode {
  if (path.length === 0) return defaultLayout();
  return editAt(layout, path, () => null);
}

/** Wrap the node at `path` in a fresh `row`/`col` container (the atom for
 *  building a four-quadrant: wrap a row, wrap again). */
export function wrapInStack(layout: LayoutNode, path: LayoutPath, dir: "row" | "col"): LayoutNode {
  return editAt(layout, path, (node) => ({ dir, children: [node] }));
}

/** Switch a container's arrangement direction. No-op on area leaves. */
export function setStackDir(layout: LayoutNode, path: LayoutPath, dir: "row" | "col"): LayoutNode {
  return editAt(layout, path, (node) => {
    if (!isStackNode(node)) return node;
    return { ...node, dir };
  });
}

/** Set a node's flex weight (relative size in its parent). `undefined`/≤0 clears it. */
export function setWeight(layout: LayoutNode, path: LayoutPath, weight: number | undefined): LayoutNode {
  return editAt(layout, path, (node) => {
    const next = clone(node);
    if (typeof weight === "number" && weight > 0) next.weight = weight;
    else delete next.weight;
    return next;
  });
}

/** Reorder a child within the same container (the primary drag interaction). */
export function reorderChild(
  layout: LayoutNode,
  parentPath: LayoutPath,
  fromIndex: number,
  toIndex: number,
): LayoutNode {
  return editAt(layout, parentPath, (parent) => {
    if (!isStackNode(parent)) return parent;
    const n = parent.children.length;
    if (fromIndex < 0 || fromIndex >= n) return parent;
    const next = { ...parent, children: [...parent.children] };
    const [item] = next.children.splice(fromIndex, 1);
    const at = Math.max(0, Math.min(toIndex, next.children.length));
    next.children.splice(at, 0, item);
    return next;
  });
}
