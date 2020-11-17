/**
 * @license
 * Copyright 2018 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Support for defining user-selectable annotation tools.
 */

import debounce from 'lodash/debounce';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {TrackableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {EventActionMap} from 'neuroglancer/util/event_action_map';
import {verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';

const TOOL_KEY_PATTERN = /^[A-Z]$/;

export abstract class Tool extends RefCounted {
  changed = new Signal();
  constructor(public layer: UserLayer) {
    super();
  }
  get mouseState() {
    return this.layer.manager.root.layerSelectedValues.mouseState;
  }
  activate(): void {}
  abstract trigger(mouseState: MouseSelectionState): void;
  abstract toJSON(): any;
  deactivate(): void {}
  abstract description: string;
  activateContext: RefCounted|undefined;
}

export interface Tool {
  inputEventMap: EventActionMap|undefined;
}

export function restoreTool(layer: UserLayer, obj: any) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'string') {
    obj = {'type': obj};
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', verifyString);
  const getter = tools.get(type);
  if (getter === undefined) {
    throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
  }
  return getter(layer, obj);
}

export type ToolGetter = (layer: UserLayer, options: any) => Owned<Tool>|undefined;

const tools = new Map<string, ToolGetter>();

export function registerTool(type: string, getter: ToolGetter) {
  tools.set(type, getter);
}

export class SelectedTool extends RefCounted implements TrackableValueInterface<Tool|undefined> {
  changed = new Signal();
  private value_: Owned<Tool>|undefined;

  get value() {
    return this.value_;
  }

  set value(newValue: Owned<Tool>|undefined) {
    if (newValue === this.value_) return;
    this.unregister();
    if (newValue !== undefined) {
      newValue.changed.add(this.changed.dispatch);
      this.value_ = newValue;
    }
    this.changed.dispatch();
  }

  private unregister() {
    const existingValue = this.value_;
    if (existingValue !== undefined) {
      existingValue.changed.remove(this.changed.dispatch);
      existingValue.dispose();
      this.value_ = undefined;
    }
  }

  disposed() {
    this.unregister();
    super.disposed();
  }

  restoreState(obj: unknown) {
    this.value = restoreTool(this.layer, obj);
  }

  reset() {
    this.value = undefined;
  }

  toJSON() {
    const value = this.value_;
    if (value === undefined) return undefined;
    return value.toJSON();
  }
  constructor(public layer: UserLayer) {
    super();
  }
}

export class ToolBinder extends RefCounted {
  bindings = new Map<string, Borrowed<Tool>>();
  changed = new Signal();
  private activeTool: Borrowed<Tool>|undefined;
  private debounceDeactivate = this.registerCancellable(debounce(() => this.deactivate(), 1));

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    const {bindings} = this;
    const existingTool = bindings.get(key);
    if (existingTool !== undefined) {
      bindings.delete(key);
      const layerToolBinder = existingTool.layer.toolBinder;
      const layerBindings = layerToolBinder.bindings;
      layerBindings.delete(key);
      this.destroyTool(existingTool);
      layerToolBinder.changed.dispatch();
    }
    if (tool !== undefined) {
      tool.layer.toolBinder.bindings.set(key, tool);
      bindings.set(key, tool);
      tool.layer.toolBinder.changed.dispatch();
    }
    this.changed.dispatch();
  }

  activate(key: string): Borrowed<Tool>|undefined {
    const tool = this.get(key);
    if (tool === undefined) {
      this.deactivate();
      return;
    }
    this.debounceDeactivate.cancel();
    if (tool === this.activeTool) {
      return;
    }
    const activateContext = tool.activateContext = new RefCounted();
    this.activeTool = tool;
    const expectedCode = `Key${key}`;
    activateContext.registerEventListener(window, 'keyup', (event: KeyboardEvent) => {
      if (event.code === expectedCode) {
        this.debounceDeactivate();
      }
    });
    activateContext.registerEventListener(window, 'blur', () => {
      this.debounceDeactivate();
    });
    return tool;
  }

  destroyTool(tool: Owned<Tool>) {
    if (this.activeTool === tool) {
      this.deactivate();
    }
    tool.dispose();
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  private deactivate() {
    this.debounceDeactivate.cancel();
    const tool = this.activeTool;
    if (tool === undefined) return;
    this.activeTool = undefined;
    tool.activateContext!.dispose();
    tool.activateContext = undefined;
  }
}

export class LayerToolBinder {
  bindings = new Map<string, Owned<Tool>>();
  changed = new Signal();

  private get globalBinder() {
    return this.layer.manager.root.toolBinder;
  }
  constructor(public layer: UserLayer) {
    layer.registerDisposer(() => this.clear());
  }

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    this.globalBinder.set(key, tool);
  }

  toJSON(): any {
    const {bindings} = this;
    if (bindings.size === 0) return undefined;
    const obj: any = {};
    for (const [key, value] of bindings) {
      obj[key] = value.toJSON();
    }
    return obj;
  }

  clear() {
    const {globalBinder, bindings} = this;
    if (bindings.size !== 0) {
      for (const [key, tool] of bindings) {
        globalBinder.bindings.delete(key);
        globalBinder.destroyTool(tool);
      }
      bindings.clear();
      globalBinder.changed.dispatch();
      this.changed.dispatch();
    }
  }

  reset() {
    this.clear();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    verifyObject(obj);
    for (const [key, value] of Object.entries(obj)) {
      if (!key.match(TOOL_KEY_PATTERN)) {
        throw new Error(`Invalid tool key: ${JSON.stringify(key)}`);
      }
      const tool = restoreTool(this.layer, value);
      if (tool === undefined) return;
      this.set(key, tool);
    }
  }
}

export function makeToolButton<E extends HTMLElement, T extends UserLayer>(
  element: E, layer: T, toolFactory: (layer: T) => Owned<Tool>): E {
  let context: RefCounted|undefined;
  element.addEventListener('mouseenter', () => {
    if (context !== undefined) {
      context.dispose();
    }
    context = new RefCounted();
    context.registerEventListener(window, 'keydown', (event: KeyboardEvent) => {
      const {code} = event;
      const m = code.match(/^Key([A-Z])$/);
      if (m === null) return;
      const key = m[1];
      layer.toolBinder.set(key, toolFactory(layer));
    }, {capture: true});
  });
  element.addEventListener('mouseleave', () => {
    if (context !== undefined) {
      context.dispose();
      context = undefined;
    }
  });
  return element;
}
