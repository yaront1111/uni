/**
 * A keyboard-only user, for the accessibility suite (CRT-UX-14-A).
 *
 * There is no pointer here at all: the only ways to act are Tab and Shift+Tab
 * through the sequential focus order a browser computes, typing into the
 * focused field, and pressing Enter or Space on the focused element, with the
 * default action HTML gives that key on that element. An element that only a
 * mouse could reach -- a click handler on a `div`, a control removed from the tab
 * order, a disclosure that is not a native `summary` -- cannot be reached or
 * activated by this user, so a task that needs one fails.
 *
 * Navigation (a followed link, a submitted GET form) is recorded rather than
 * performed: the next page is its own walkthrough.
 */

export interface Step {
  readonly key: string;
  readonly target: string;
  readonly outcome: string;
}

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]';

function hiddenByAncestor(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert')) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    // Content of a closed disclosure is not rendered, except its own summary.
    const parent: HTMLElement | null = node.parentElement;
    if (parent && parent.tagName === 'DETAILS' && !(parent as HTMLDetailsElement).open
      && !(node.tagName === 'SUMMARY' && parent.querySelector(':scope > summary') === node)) return true;
  }
  return false;
}

function inTabOrder(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled) return false;
  if (element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'hidden') return false;
  if (element.tagName === 'A' && !element.hasAttribute('href')) return false;
  if (element.tagName === 'SUMMARY' && element.parentElement?.querySelector(':scope > summary') !== element) return false;
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  return !hiddenByAncestor(element);
}

/** The sequential focus navigation order: positive tabindex first, then DOM order. */
export function tabOrder(document: Document): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(inTabOrder);
  const positive = all.filter(element => Number(element.getAttribute('tabindex') ?? 0) > 0)
    .sort((a, b) => Number(a.getAttribute('tabindex')) - Number(b.getAttribute('tabindex')));
  return [...positive, ...all.filter(element => !positive.includes(element))];
}

/** The name a screen reader announces, from the same sources a browser uses. */
export function accessibleName(element: Element): string {
  const document = element.ownerDocument;
  const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) return labelledBy.split(/\s+/).map(ref => text(document.getElementById(ref))).join(' ').trim();
  const label = element.getAttribute('aria-label');
  if (label) return label.trim();
  if (element.id) {
    const forLabel = document.querySelector('label[for="' + element.id + '"]');
    if (forLabel) return text(forLabel);
  }
  const wrapping = element.closest('label');
  if (wrapping) return text(wrapping);
  return text(element);
}

function roleOf(element: Element): string {
  const role = element.getAttribute('role');
  if (role) return role;
  switch (element.tagName) {
    case 'A': return 'link';
    case 'BUTTON': return 'button';
    case 'SELECT': return 'combobox';
    case 'TEXTAREA': return 'textbox';
    case 'SUMMARY': return 'disclosure';
    case 'INPUT': {
      const type = (element as HTMLInputElement).type;
      return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : type === 'search' ? 'searchbox' : 'textbox';
    }
    default: return element.tagName.toLowerCase();
  }
}
export function describe(element: Element): string { return roleOf(element) + ' "' + accessibleName(element) + '"'; }

export class KeyboardUser {
  readonly steps: Step[] = [];
  readonly navigations: string[] = [];
  private focused: HTMLElement | null = null;

  constructor(private readonly document: Document) {
    // A submitted form is a navigation the browser would perform; record it.
    document.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement;
      event.preventDefault();
      if ((form.method || 'get').toLowerCase() !== 'get') { this.navigations.push('POST ' + form.action); return; }
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form)) query.append(name, String(value));
      const action = new URL(form.getAttribute('action') ?? '', 'https://uai.test/');
      this.navigations.push(action.pathname + '?' + query.toString());
    }, true);
  }

  get current(): HTMLElement | null { return this.focused; }

  private record(key: string, outcome: string) {
    this.steps.push({ key, target: this.focused ? describe(this.focused) : '(document)', outcome });
  }

  private move(to: HTMLElement | null, key: string) {
    this.focused = to;
    to?.focus();
    this.record(key, to ? 'focus' : 'focus left the page');
  }

  /** Tab once. */
  tab(): HTMLElement | null {
    const order = tabOrder(this.document);
    const index = this.focused ? order.indexOf(this.focused) : -1;
    this.move(order[index + 1] ?? null, 'Tab');
    return this.focused;
  }
  shiftTab(): HTMLElement | null {
    const order = tabOrder(this.document);
    const index = this.focused ? order.indexOf(this.focused) : order.length;
    this.move(order[index - 1] ?? null, 'Shift+Tab');
    return this.focused;
  }

  /** Tab until the focused element matches, as a user reading the page would.
   * Fails -- returns null -- when the page's tab order never reaches it. */
  tabTo(matches: (element: HTMLElement) => boolean): HTMLElement | null {
    const limit = tabOrder(this.document).length + 1;
    for (let presses = 0; presses < limit; presses++) {
      const element = this.tab();
      if (!element) return null;
      if (matches(element)) return element;
    }
    return null;
  }

  /** Type into the focused text field, replacing its value, as keystrokes do. */
  type(text: string) {
    const field = this.focused as HTMLInputElement | null;
    if (!field || !('value' in field)) throw new Error('KEYBOARD_NOTHING_TO_TYPE_INTO');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter ? setter.call(field, text) : (field.value = text);
    field.dispatchEvent(new (this.document.defaultView!.Event)('input', { bubbles: true }));
    field.dispatchEvent(new (this.document.defaultView!.Event)('change', { bubbles: true }));
    this.record('type "' + text + '"', 'value ' + JSON.stringify(field.value));
  }

  /** Arrow Down on a focused select chooses the next option. */
  arrowDown() {
    const select = this.focused as HTMLSelectElement | null;
    if (!select || select.tagName !== 'SELECT') throw new Error('KEYBOARD_NOT_A_SELECT');
    select.selectedIndex = Math.min(select.selectedIndex + 1, select.options.length - 1);
    select.dispatchEvent(new (this.document.defaultView!.Event)('change', { bubbles: true }));
    this.record('ArrowDown', 'selected "' + (select.selectedOptions[0]?.textContent ?? '') + '"');
  }

  /** Enter or Space on the focused element, with its native default action. */
  press(key: 'Enter' | ' ') {
    const element = this.focused;
    if (!element) throw new Error('KEYBOARD_NOTHING_FOCUSED');
    const view = this.document.defaultView!;
    const notCancelled = element.dispatchEvent(new view.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const name = key === 'Enter' ? 'Enter' : 'Space';
    if (!notCancelled) { this.record(name, 'handled by the page'); return; }
    const tag = element.tagName;
    if (tag === 'A' && key === 'Enter') {
      const href = element.getAttribute('href')!;
      if (href.startsWith('#')) {
        const target = this.document.getElementById(href.slice(1));
        target?.focus();
        this.focused = target;
        this.record(name, 'moved to ' + (target ? describe(target) : 'nothing'));
      } else { this.navigations.push(href); this.record(name, 'navigate ' + href); }
      return;
    }
    if (tag === 'SUMMARY') {
      const details = element.parentElement as HTMLDetailsElement;
      const before = details.open;
      element.click();
      if (details.open === before) details.open = !before;
      this.record(name, details.open ? 'expanded' : 'collapsed');
      return;
    }
    if (tag === 'BUTTON' || (tag === 'INPUT' && ['checkbox', 'radio', 'submit', 'button'].includes((element as HTMLInputElement).type))) {
      if (tag === 'INPUT' && key === 'Enter' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)) {
        this.record(name, 'nothing'); return;
      }
      element.click();
      this.record(name, 'activated');
      return;
    }
    if (tag === 'INPUT' && key === 'Enter') {
      // Implicit submission: Enter in a single-line field submits its form.
      const form = (element as HTMLInputElement).form;
      const submitter = form?.querySelector<HTMLElement>('button:not([type]),button[type=submit],input[type=submit]');
      if (form && submitter) { submitter.click(); this.record(name, 'submitted the form'); return; }
    }
    this.record(name, 'nothing');
  }
}
