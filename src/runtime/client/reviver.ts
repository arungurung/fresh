import {
  Component,
  type ComponentChildren,
  type ComponentType,
  Fragment,
  h,
  render,
  type VNode,
} from "preact";
import { type CustomParser, parse } from "../../jsonify/parse.ts";
import { signal } from "@preact/signals";
import { DATA_FRESH_KEY, PartialMode } from "../shared_internal.tsx";

const enum RootKind {
  Island,
  Partial,
}

interface IslandReq {
  kind: RootKind.Island;
  name: string;
  propsIdx: number;
  key: string | null;
  start: Comment;
  end: Comment | null;
}
interface PartialReq {
  kind: RootKind.Partial;
  name: string;
  key: string | null;
  start: Comment;
  end: Comment | null;
}

interface ReviveContext {
  roots: Array<IslandReq | PartialReq>;
  stack: Array<PartialReq | IslandReq>;
  slots: Map<number, { name: string; start: Comment; end: Comment | null }>;
  slotIdStack: number[];
}

interface SlotRef {
  kind: typeof SLOT_SYMBOL;
  name: string;
  id: number;
}
const SLOT_SYMBOL = Symbol.for("_FRESH_SLOT");
function isSlotRef(x: unknown): x is SlotRef {
  return x !== null && typeof x === "object" && "kind" in x &&
    x.kind === SLOT_SYMBOL;
}

export type DeserializedProps = {
  props: Record<string, unknown>;
  slots: SlotRef[];
}[];

export const ACTIVE_PARTIALS = new Map<string, PartialComp>();

export class PartialComp extends Component<
  { children?: ComponentChildren; mode: PartialMode; name: string }
> {
  componentDidMount() {
    ACTIVE_PARTIALS.set(this.props.name, this);
  }

  render() {
    return this.props.children;
  }
}
PartialComp.displayName = "Partial";

export function revive(
  props: Record<string, unknown>,
  component: ComponentType,
  container: HTMLElement,
  slots: ReviveContext["slots"],
  allProps: DeserializedProps,
) {
  const _render = () => {
    for (const propName in props) {
      const value = props[propName];
      if (isSlotRef(value)) {
        const markers = slots.get(value.id);
        if (markers !== undefined) {
          const root = h(Fragment, null);
          const slotContainer = createRootFragment(
            container,
            markers.start,
            markers.end!,
          );
          domToVNode(
            allProps,
            [root],
            [Marker.Slot],
            slotContainer,
          );
          props[propName] = root;
        } else {
          const template = document.querySelector(
            `#frsh-${value.id}-${value.name}`,
          ) as HTMLTemplateElement | null;
          if (template !== null) {
            const root = h(Fragment, null);
            domToVNode(allProps, [root], [Marker.Slot], template.content);
            props[propName] = root;
          }
        }
      }
    }

    // TODO: explore hydrate?
    render(h(component, props), container as unknown as HTMLElement);
  };

  // deno-lint-ignore no-window
  "scheduler" in window
    // `scheduler.postTask` is async but that can easily
    // fire in the background. We don't want waiting for
    // the hydration of an island block us.
    // @ts-ignore scheduler API is not in types yet
    ? scheduler!.postTask(_render)
    : setTimeout(_render, 0);
}

export const ISLAND_REGISTRY = new Map<string, ComponentType>();

export const CUSTOM_PARSER: CustomParser = {
  Signal: (value: unknown) => signal(value),
  Slot: (value: { name: string; id: number }): SlotRef => {
    return { kind: SLOT_SYMBOL, name: value.name, id: value.id };
  },
};

export function createReviveCtx(): ReviveContext {
  return {
    roots: [],
    stack: [],
    slots: new Map(),
    slotIdStack: [],
  };
}

export function boot(
  initialIslands: Record<string, ComponentType>,
  islandProps: string,
) {
  const ctx = createReviveCtx();
  _walkInner(ctx, document.body, false);

  const keys = Object.keys(initialIslands);
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    ISLAND_REGISTRY.set(name, initialIslands[name]);
  }

  const allProps = parse<DeserializedProps>(
    islandProps,
    CUSTOM_PARSER,
  );

  for (let i = 0; i < ctx.roots.length; i++) {
    const root = ctx.roots[i];

    const container = createRootFragment(
      // deno-lint-ignore no-explicit-any
      root.start.parentNode as any,
      root.start,
      root.end!,
    );

    if (root.kind === RootKind.Island) {
      const props = allProps[root.propsIdx].props;
      const component = ISLAND_REGISTRY.get(root.name)!;

      revive(props, component, container, ctx.slots, allProps);
    } else if (root.kind === RootKind.Partial) {
      const props: Record<string, unknown> = {
        name: root.name,
        children: null,
      };

      const domRoot = h(Fragment, null);
      domToVNode(allProps, [domRoot], [Marker.Partial], container);
      props.children = domRoot.props.children;

      // deno-lint-ignore no-explicit-any
      revive(props, PartialComp as any, container, ctx.slots, allProps);
    }
  }
}

function _walkInner(
  ctx: ReviveContext,
  node: Node | Comment,
  insideRoot: boolean,
) {
  if (isElementNode(node)) {
    // No need to traverse into <script> or <style> tags.
    // No need to traverse deeper if we found a slotStart marker.
    // We'll parse slots later when the island is revived.
    if (
      node.nodeName === "SCRIPT" || node.nodeName === "STYLE" ||
      ctx.slotIdStack.length > 0
    ) {
      return;
    }

    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      _walkInner(ctx, child, insideRoot);
    }
  } else if (isCommentNode(node)) {
    const comment = node.data;
    if (comment.startsWith("frsh:")) {
      const parts = comment.split(":");
      const kind = parts[1];
      if (kind === "island") {
        const name = parts[2];
        const propsIdx = parts[3];
        const key = parts[4];
        const found: IslandReq = {
          kind: RootKind.Island,
          name,
          propsIdx: Number(propsIdx),
          key: key === "" ? null : key,
          start: node,
          end: null,
        };
        if (ctx.stack.length === 0) {
          ctx.roots.push(found);
        }
        ctx.stack.push(found);
      } else if (kind === "slot") {
        const id = +parts[2];
        const slotName = parts[3];
        ctx.slotIdStack.push(id);
        ctx.slots.set(id, {
          name: slotName,
          start: node,
          end: null,
        });
      } else if (kind === "partial") {
        const name = parts[2];
        const key = parts[3];
        const found: PartialReq = {
          kind: RootKind.Partial,
          name,
          key,
          start: node,
          end: null,
        };
        if (ctx.stack.length === 0) {
          ctx.roots.push(found);
        }
        ctx.stack.push(found);
      }
    } else if (comment === "/frsh:island" || comment === "/frsh:partial") {
      const item = ctx.stack.pop();
      if (item !== undefined) {
        item.end = node;
      }
    } else if (comment === "/frsh:slot") {
      const item = ctx.slotIdStack.pop();
      if (item !== undefined) {
        ctx.slots.get(item)!.end = node;
      }
    }
  }
}

export const enum Marker {
  Island,
  Partial,
  Slot,
}

interface ServerSlotProps {
  name: string;
  id: number;
  children?: ComponentChildren;
}

// deno-lint-ignore no-explicit-any
function ServerSlot(props: ServerSlotProps): any {
  return props.children;
}

export function domToVNode(
  allProps: DeserializedProps,
  // deno-lint-ignore no-explicit-any
  vnodeStack: VNode<any>[],
  markerStack: Marker[],
  node: Node | DocumentFragment,
): void {
  let sib: Node | ChildNode | null = node;
  while (sib !== null) {
    // deno-lint-ignore no-explicit-any
    if ((sib as any)._frshRootFrag || sib instanceof DocumentFragment) {
      const firstChild = sib.firstChild;
      if (firstChild !== null) {
        domToVNode(allProps, vnodeStack, markerStack, firstChild);
      }
    } else if (isElementNode(sib)) {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < sib.attributes.length; i++) {
        const attr = sib.attributes[i];

        if (attr.nodeName === DATA_FRESH_KEY) {
          props.key = attr.nodeValue;
          continue;
        }

        // Boolean attributes are always `true` when present.
        // See: https://developer.mozilla.org/en-US/docs/Glossary/Boolean/HTML
        props[attr.nodeName] =
          // deno-lint-ignore no-explicit-any
          typeof (sib as any)[attr.nodeName] === "boolean"
            ? true
            : attr.nodeValue;
      }

      const vnode = h(sib.localName, props);
      const marker = markerStack.at(-1);
      const appendVNode = marker === Marker.Slot || marker === Marker.Partial;
      if (appendVNode) {
        addVNodeChild(vnodeStack.at(-1)!, vnode);
        vnodeStack.push(vnode);
      }

      const firstChild = sib.firstChild;
      if (firstChild !== null) {
        domToVNode(allProps, vnodeStack, markerStack, firstChild);
      }

      if (appendVNode) {
        vnodeStack.pop();
      }
    } else if (isCommentNode(sib)) {
      const comment = sib.data;
      if (comment.startsWith("frsh:")) {
        const parts = comment.split(":");

        const kind = parts[1];
        if (kind === "island") {
          markerStack.push(Marker.Island);

          const name = parts[2];
          const propsIdx = parts[3];
          const key = parts[4];
          const island = ISLAND_REGISTRY.get(name);
          if (island === undefined) {
            throw new Error(`Encountered unknown island: ${name}`);
          }

          const props = allProps[+propsIdx].props;
          props.key = key;

          // deno-lint-ignore no-explicit-any
          const islandVNode = h<any>(island, props);
          addVNodeChild(vnodeStack.at(-1)!, islandVNode);
          vnodeStack.push(islandVNode);
        } else if (kind === "slot") {
          markerStack.push(Marker.Slot);

          const id = +parts[2];
          const slotName = parts[3];
          const key = parts[4];
          const vnode = h(ServerSlot, {
            key,
            id,
            name: slotName,
            children: [],
          });

          const parentVNode = vnodeStack.at(-1)!;
          if (slotName === "children") {
            addVNodeChild(parentVNode, vnode);
          } else {
            parentVNode.props[slotName] = vnode;
          }
          vnodeStack.push(vnode);
        } else if (kind === "partial") {
          markerStack.push(Marker.Partial);

          const name = parts[2];
          const mode = +parts[3] as PartialMode;
          const key = parts[4];
          // deno-lint-ignore no-explicit-any
          let vnode: VNode<any> = h(PartialComp, { name, key, mode });
          const parentVNode = vnodeStack.at(-1);
          if (parentVNode !== undefined) {
            addVNodeChild(parentVNode, vnode);
          }

          if (mode === PartialMode.Append) {
            const active = ACTIVE_PARTIALS.get(name);
            if (active !== undefined) {
              copyOldChildren(vnode.props, active.props.children);
              const wrapper = h(Fragment, null);
              addVNodeChild(vnode, wrapper);
              vnode = wrapper;
            }
          } else if (mode === PartialMode.Prepend) {
            const active = ACTIVE_PARTIALS.get(name);
            if (active !== undefined) {
              copyOldChildren(vnode.props, active.props.children);
              const wrapper = h(Fragment, null);
              if (!vnode.props.children) {
                vnode.props.children = [];
              }
              // deno-lint-ignore no-explicit-any
              (vnode.props.children as Array<VNode<any> | string>).unshift(
                wrapper,
              );
              vnode = wrapper;
            }
          }

          vnodeStack.push(vnode);
        } else if (kind === "key") {
          const vnode = h(Fragment, { key: parts[2] });
          addVNodeChild(vnodeStack.at(-1)!, vnode);
          vnodeStack.push(vnode);
        }
      } else if (
        comment === "/frsh:island" || comment === "/frsh:slot" ||
        comment === "/frsh:partial"
      ) {
        vnodeStack.pop();
        markerStack.pop();
      } else if (comment === "/frsh:key") {
        vnodeStack.pop();
      }
    } else if (isTextNode(sib)) {
      const marker = markerStack.at(-1);
      if (marker === Marker.Slot || marker === Marker.Partial) {
        addVNodeChild(vnodeStack.at(-1)!, sib.data);
      }
    }

    sib = sib.nextSibling;
  }
}

// deno-lint-ignore no-explicit-any
function addVNodeChild(parent: VNode<any>, child: VNode<any> | string) {
  if (!parent.props.children) {
    parent.props.children = [];
  }
  // deno-lint-ignore no-explicit-any
  (parent.props.children as Array<VNode<any> | string>).push(child);
}

export function copyOldChildren(
  props: Record<string, unknown>,
  oldChildren: ComponentChildren,
) {
  props.children = oldChildren !== undefined && oldChildren !== null
    ? Array.isArray(oldChildren) ? oldChildren : [oldChildren]
    : [];
}

export function isCommentNode(node: Node): node is Comment {
  return node.nodeType === Node.COMMENT_NODE;
}
export function isTextNode(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}
export function isElementNode(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && !("_frshRootFrag" in node);
}

export function createRootFragment(
  parent: Element,
  startMarker: Text | Comment,
  // We need an end marker for islands because multiple
  // islands can share the same parent node. Since
  // islands are root-level render calls any calls to
  // `.appendChild` would lead to a wrong result.
  endMarker: Text | Comment,
): HTMLElement & { _frshRootFrag: boolean } {
  // @ts-ignore this is fine
  return parent.__k = {
    _frshRootFrag: true,
    nodeType: 1,
    parentNode: parent,
    nextSibling: null,
    get firstChild() {
      const child = startMarker.nextSibling;
      if (child === endMarker) return null;
      return child;
    },
    get childNodes() {
      const children: ChildNode[] = [];

      let child = startMarker.nextSibling;
      while (child !== null && child !== endMarker) {
        children.push(child);
        child = child.nextSibling;
      }

      return children;
    },
    insertBefore(node: Node, child: Node | null) {
      parent.insertBefore(node, child ?? endMarker);
    },
    appendChild(child: Node) {
      // We cannot blindly call `.append()` as that would add
      // the new child to the very end of the parent node. This
      // leads to ordering issues when the multiple islands
      // share the same parent node.
      parent.insertBefore(child, endMarker);
    },
    removeChild(child: Node) {
      parent.removeChild(child);
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}
