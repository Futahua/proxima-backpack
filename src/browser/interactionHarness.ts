export const MACHINE_KEY_ATTRIBUTE = 'data-papers-visual-key' as const;

export interface InteractionPoint {
  clientX: number;
  clientY: number;
}

export interface InteractionModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface PointerGesture {
  move(targetKey: string, point: InteractionPoint, modifiers?: InteractionModifiers): Event;
  release(targetKey: string, point: InteractionPoint, modifiers?: InteractionModifiers): Event;
}

export interface DragGesture {
  readonly dataTransfer: DataTransfer;
  move(targetKey: string, point: InteractionPoint, modifiers?: InteractionModifiers): Event;
  drop(targetKey: string, point: InteractionPoint, modifiers?: InteractionModifiers): Event;
}

export interface InteractionHarness {
  target(key: string): HTMLElement;
  click(key: string, modifiers?: InteractionModifiers): MouseEvent;
  hover(key: string, point?: InteractionPoint, modifiers?: InteractionModifiers): Event[];
  contextMenu(key: string, point?: InteractionPoint, modifiers?: InteractionModifiers): MouseEvent;
  pointerDown(key: string, point: InteractionPoint, modifiers?: InteractionModifiers): PointerGesture;
  beginResize(key: string, point: InteractionPoint, modifiers?: InteractionModifiers): PointerGesture;
  beginDrag(key: string, point: InteractionPoint, modifiers?: InteractionModifiers): DragGesture;
  pressKey(key: string, keyboardKey: string, modifiers?: InteractionModifiers): KeyboardEvent;
  escape(key: string): KeyboardEvent;
  typeText(key: string, text: string): void;
}

const ORIGIN: InteractionPoint = { clientX: 0, clientY: 0 };

type PointerEventConstructor = new (type: string, init?: PointerEventInit) => PointerEvent;
type InputEventConstructor = new (type: string, init?: InputEventInit) => InputEvent;

class HarnessDataTransfer implements DataTransfer {
  dropEffect: DataTransfer['dropEffect'] = 'none';
  effectAllowed: DataTransfer['effectAllowed'] = 'all';
  readonly files = [] as unknown as FileList;
  readonly items = [] as unknown as DataTransferItemList;

  private readonly values = new Map<string, string>();

  get types(): readonly string[] {
    return [...this.values.keys()];
  }

  clearData(format?: string): void {
    if (format === undefined) {
      this.values.clear();
      return;
    }
    this.values.delete(format);
  }

  getData(format: string): string {
    return this.values.get(format) ?? '';
  }

  setData(format: string, data: string): void {
    this.values.set(format, data);
  }

  setDragImage(_image: Element, _x: number, _y: number): void {}
}

function eventView(target: Element): Window & typeof globalThis {
  const view = target.ownerDocument.defaultView;
  if (!view) throw new Error('interaction target has no window');
  return view;
}

function machineTarget(root: ParentNode, key: string): HTMLElement {
  const matches = Array.from(root.querySelectorAll<HTMLElement>(`[${MACHINE_KEY_ATTRIBUTE}]`))
    .filter((element) => element.getAttribute(MACHINE_KEY_ATTRIBUTE) === key);

  if (matches.length !== 1) {
    throw new Error(`machine key "${key}" matched ${matches.length} elements`);
  }

  return matches[0]!;
}

function pointerEvent(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointerover' | 'pointerenter',
  point: InteractionPoint,
  modifiers: InteractionModifiers,
  buttons: number,
): Event {
  const view = eventView(target);
  const init: PointerEventInit = {
    bubbles: type !== 'pointerenter',
    cancelable: true,
    composed: true,
    clientX: point.clientX,
    clientY: point.clientY,
    button: 0,
    buttons,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...modifiers,
  };

  const PointerCtor = (view as unknown as { PointerEvent?: PointerEventConstructor }).PointerEvent;
  const event = PointerCtor
    ? new PointerCtor(type, init)
    : new view.MouseEvent(type, init);

  target.dispatchEvent(event);
  return event;
}

function mouseEvent(
  target: HTMLElement,
  type: 'click' | 'mouseover' | 'mouseenter' | 'contextmenu',
  point: InteractionPoint,
  modifiers: InteractionModifiers,
  button: number,
): MouseEvent {
  const view = eventView(target);
  const event = new view.MouseEvent(type, {
    bubbles: type !== 'mouseenter',
    cancelable: true,
    composed: true,
    clientX: point.clientX,
    clientY: point.clientY,
    button,
    buttons: button === 2 ? 2 : 0,
    ...modifiers,
  });

  target.dispatchEvent(event);
  return event;
}

function keyboardEvent(
  target: HTMLElement,
  type: 'keydown' | 'keyup',
  key: string,
  modifiers: InteractionModifiers,
): KeyboardEvent {
  const view = eventView(target);
  const event = new view.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    ...modifiers,
  });

  target.dispatchEvent(event);
  return event;
}

function textInputEvent(target: HTMLElement, type: 'beforeinput' | 'input', data: string): Event {
  const view = eventView(target);
  const InputCtor = (view as unknown as { InputEvent?: InputEventConstructor }).InputEvent;

  if (InputCtor) {
    return new InputCtor(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      composed: true,
      data,
      inputType: 'insertText',
    });
  }

  const event = new view.Event(type, {
    bubbles: true,
    cancelable: type === 'beforeinput',
    composed: true,
  });
  Object.defineProperty(event, 'data', { value: data });
  Object.defineProperty(event, 'inputType', { value: 'insertText' });
  return event;
}

function dragEvent(
  target: HTMLElement,
  type: 'dragstart' | 'dragenter' | 'dragover' | 'drop' | 'dragend',
  dataTransfer: DataTransfer,
  point: InteractionPoint,
  modifiers: InteractionModifiers,
): Event {
  const view = eventView(target);
  const event = new view.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.clientX,
    clientY: point.clientY,
    ...modifiers,
  });

  Object.defineProperty(event, 'dataTransfer', {
    configurable: false,
    enumerable: true,
    value: dataTransfer,
  });

  target.dispatchEvent(event);
  return event;
}

function controlForTextEntry(target: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return target as HTMLInputElement | HTMLTextAreaElement;
  }

  throw new Error(`machine key "${target.getAttribute(MACHINE_KEY_ATTRIBUTE) ?? ''}" is not a text control`);
}

export function createInteractionHarness(root: ParentNode): InteractionHarness {
  const target = (key: string): HTMLElement => machineTarget(root, key);

  const beginPointerGesture = (
    sourceKey: string,
    point: InteractionPoint,
    modifiers: InteractionModifiers = {},
  ): PointerGesture => {
    const source = target(sourceKey);
    pointerEvent(source, 'pointerdown', point, modifiers, 1);

    let active = true;

    const requireActive = (): void => {
      if (!active) throw new Error('pointer gesture is already released');
    };

    return {
      move(targetKey, nextPoint, nextModifiers = {}) {
        requireActive();
        return pointerEvent(target(targetKey), 'pointermove', nextPoint, nextModifiers, 1);
      },

      release(targetKey, nextPoint, nextModifiers = {}) {
        requireActive();
        active = false;
        return pointerEvent(target(targetKey), 'pointerup', nextPoint, nextModifiers, 0);
      },
    };
  };

  return {
    target,

    click(key, modifiers = {}) {
      return mouseEvent(target(key), 'click', ORIGIN, modifiers, 0);
    },

    hover(key, point = ORIGIN, modifiers = {}) {
      const element = target(key);
      return [
        pointerEvent(element, 'pointerover', point, modifiers, 0),
        pointerEvent(element, 'pointerenter', point, modifiers, 0),
        mouseEvent(element, 'mouseover', point, modifiers, 0),
        mouseEvent(element, 'mouseenter', point, modifiers, 0),
      ];
    },

    contextMenu(key, point = ORIGIN, modifiers = {}) {
      return mouseEvent(target(key), 'contextmenu', point, modifiers, 2);
    },

    pointerDown(key, point, modifiers = {}) {
      return beginPointerGesture(key, point, modifiers);
    },

    beginResize(key, point, modifiers = {}) {
      return beginPointerGesture(key, point, modifiers);
    },

    beginDrag(key, point, modifiers = {}) {
      const source = target(key);
      const dataTransfer = new HarnessDataTransfer();

      pointerEvent(source, 'pointerdown', point, modifiers, 1);
      dragEvent(source, 'dragstart', dataTransfer, point, modifiers);

      let active = true;

      const requireActive = (): void => {
        if (!active) throw new Error('drag gesture is already dropped');
      };

      return {
        dataTransfer,

        move(targetKey, nextPoint, nextModifiers = {}) {
          requireActive();
          const destination = target(targetKey);
          pointerEvent(destination, 'pointermove', nextPoint, nextModifiers, 1);
          dragEvent(destination, 'dragenter', dataTransfer, nextPoint, nextModifiers);
          return dragEvent(destination, 'dragover', dataTransfer, nextPoint, nextModifiers);
        },

        drop(targetKey, nextPoint, nextModifiers = {}) {
          requireActive();
          active = false;
          const destination = target(targetKey);
          const dropped = dragEvent(destination, 'drop', dataTransfer, nextPoint, nextModifiers);
          pointerEvent(destination, 'pointerup', nextPoint, nextModifiers, 0);
          dragEvent(source, 'dragend', dataTransfer, nextPoint, nextModifiers);
          return dropped;
        },
      };
    },

    pressKey(key, keyboardKey, modifiers = {}) {
      const element = target(key);
      element.focus();
      const down = keyboardEvent(element, 'keydown', keyboardKey, modifiers);
      keyboardEvent(element, 'keyup', keyboardKey, modifiers);
      return down;
    },

    escape(key) {
      return this.pressKey(key, 'Escape');
    },

    typeText(key, text) {
      const element = target(key);
      const control = controlForTextEntry(element);
      control.focus();

      for (const character of text) {
        const down = keyboardEvent(control, 'keydown', character, {});
        if (!down.defaultPrevented) {
          const beforeInput = textInputEvent(control, 'beforeinput', character);

          if (control.dispatchEvent(beforeInput)) {
            const start = control.selectionStart ?? control.value.length;
            const end = control.selectionEnd ?? start;
            control.value = `${control.value.slice(0, start)}${character}${control.value.slice(end)}`;

            const caret = start + character.length;
            control.setSelectionRange(caret, caret);
            control.dispatchEvent(textInputEvent(control, 'input', character));
          }
        }

        keyboardEvent(control, 'keyup', character, {});
      }
    },
  };
}
