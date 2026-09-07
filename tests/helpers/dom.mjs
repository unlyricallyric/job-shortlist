import assert from "node:assert/strict";

// A test double for the DOM operations used by this page, not a layout engine.
class NodeDouble extends EventTarget {
  constructor(tagName, attributes = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.nodes = [];
    this.parentElement = null;
    this.validity = { badInput: false };
    this.defaultValue = attributes.value ?? "";
    this.defaultChecked = Object.hasOwn(attributes, "checked");
    this.checked = this.defaultChecked;
    if (this.tagName === "TEMPLATE") this.content = new NodeDouble("#fragment");
  }

  get children() { return this.nodes.filter((node) => node instanceof NodeDouble); }
  get firstElementChild() { return this.children[0] ?? null; }
  get textContent() { return this.nodes.map((node) => typeof node === "string" ? node : node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get id() { return this.getAttribute("id"); }
  set id(value) { this.setAttribute("id", value); }
  get href() { return this.getAttribute("href"); }
  set href(value) { this.setAttribute("href", value); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) { this.toggleAttribute("hidden", value); }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value) { this.toggleAttribute("disabled", value); }
  get open() { return this.attributes.has("open"); }
  set open(value) { this.toggleAttribute("open", value); }
  get value() {
    return this.inputValue ?? (this.tagName === "SELECT"
      ? this.firstElementChild?.value ?? "" : this.getAttribute("value") ?? "");
  }
  set value(value) { this.inputValue = String(value); }
  get classList() {
    return {
      toggle: (name, enabled) => {
        const names = new Set((this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.setAttribute("class", [...names].join(" "));
      },
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, enabled) {
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof NodeDouble && node.tagName === "#FRAGMENT") this.append(...node.nodes);
      else {
        if (node instanceof NodeDouble) node.parentElement = this;
        this.nodes.push(node);
      }
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.nodes = [];
    this.append(...nodes);
  }
  add(option) { this.append(option); }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelector(selector) {
    const field = /^\[data-field="([^"]+)"\]$/.exec(selector);
    return [...this.descendants()].find((node) => field
      ? node.getAttribute("data-field") === field[1] : node.tagName === selector.toUpperCase()) ?? null;
  }
  cloneNode(deep) {
    const copy = new NodeDouble(this.tagName, Object.fromEntries(this.attributes));
    if (deep) copy.append(...this.nodes.map((node) => typeof node === "string" ? node : node.cloneNode(true)));
    return copy;
  }
  reset() {
    assert.equal(this.tagName, "FORM");
    this.dispatchEvent(new Event("reset"));
    for (const node of this.descendants()) {
      if (node.tagName === "INPUT") {
        node.value = node.defaultValue;
        node.checked = node.defaultChecked;
        node.validity.badInput = false;
      } else if (node.tagName === "SELECT") node.inputValue = undefined;
    }
  }
}

export class OptionDouble extends NodeDouble {
  constructor(label, value) {
    super("option", { value });
    this.textContent = label;
  }
}

export function pageDocument(html) {
  const document = new NodeDouble("#document");
  document.getElementById = (id) => [...document.descendants()].find((node) => node.id === id) ?? null;
  document.createElement = (tag) => new NodeDouble(tag);
  document.createDocumentFragment = () => new NodeDouble("#fragment");
  const stack = [{ tag: "#document", node: document }];
  const voidTags = new Set(["meta", "link", "img", "input", "br", "hr"]);
  for (const [token] of html.matchAll(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = token.slice(2, -1).trim();
      assert.equal(stack.pop().tag, tag, `Unbalanced closing tag: ${tag}`);
    } else if (token.startsWith("<")) {
      const [, tag, rest] = /^<([a-z][\w-]*)([\s\S]*?)>$/i.exec(token);
      const attributes = Object.fromEntries([...rest.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)]
        .map(([, key, value]) => [key, value ?? ""]));
      const node = new NodeDouble(tag, attributes);
      stack.at(-1).node.append(node);
      if (!voidTags.has(tag)) stack.push({ tag, node: node.content ?? node });
    } else stack.at(-1).node.append(token);
  }
  assert.equal(stack.length, 1);
  return document;
}
