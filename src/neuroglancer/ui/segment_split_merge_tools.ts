/**
 * @license
 * Copyright 2020 Google Inc.
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

import {augmentSegmentId, bindSegmentListWidth, makeSegmentWidget, registerCallbackWhenSegmentationDisplayStateChanged, resetTemporaryVisibleSegmentsState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {isBaseSegmentId, UNKNOWN_NEW_SEGMENT_ID} from 'neuroglancer/segmentation_graph/source';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {removeChildren} from 'neuroglancer/util/dom';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {Uint64} from 'neuroglancer/util/uint64';

const ANNOTATE_MERGE_SEGMENTS_TOOL_ID = 'mergeSegments';
const ANNOTATE_SPLIT_SEGMENTS_TOOL_ID = 'splitSegments';

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift+mousedown0': {action: 'annotate-merge-segments'},
  'at:shift+mousedown2': {action: 'annotate-set-anchor'},
});

export class MergeSegmentsTool extends Tool {
  layer: SegmentationUserLayer;
  lastAnchorBaseSegment = new WatchableValue<Uint64|undefined>(undefined);

  constructor(layer: SegmentationUserLayer) {
    super(layer);

    // Track the most recent base segment id within anchorSegment.
    const maybeUpdateLastAnchorBaseSegment = () => {
      const anchorSegment = layer.anchorSegment.value;
      if (anchorSegment === undefined) return;
      const {segmentSelectionState} = layer.displayState;
      if (!segmentSelectionState.hasSelectedSegment) return;
      const {segmentEquivalences} = layer.displayState.segmentationGroupState.value;
      const mappedAnchorSegment = segmentEquivalences.get(anchorSegment);
      if (!Uint64.equal(segmentSelectionState.selectedSegment, mappedAnchorSegment)) return;
      const base = segmentSelectionState.baseSelectedSegment;
      if (!isBaseSegmentId(base)) return;
      this.lastAnchorBaseSegment.value = base.clone();
    };
    this.registerDisposer(
        layer.displayState.segmentSelectionState.changed.add(maybeUpdateLastAnchorBaseSegment));
    this.registerDisposer(layer.anchorSegment.changed.add(maybeUpdateLastAnchorBaseSegment));
  }

  get inputEventMap() {
    return MERGE_SEGMENTS_INPUT_EVENT_MAP;
  }

  toJSON() {
    return ANNOTATE_MERGE_SEGMENTS_TOOL_ID;
  }

  private getAnchorSegment(): {anchorSegment: Uint64|undefined, error: string|undefined} {
    const {displayState} = this.layer;
    let anchorSegment = this.layer.anchorSegment.value;
    let baseAnchorSegment = this.lastAnchorBaseSegment.value;
    if (anchorSegment === undefined) {
      return {anchorSegment: undefined, error: 'Select anchor segment for merge'};
    }
    const anchorGraphSegment =
        displayState.segmentationGroupState.value.segmentEquivalences.get(anchorSegment);
    if (!displayState.segmentationGroupState.value.visibleSegments.has(anchorGraphSegment)) {
      return {anchorSegment, error: 'Anchor segment must be in visible set'};
    }
    if (baseAnchorSegment === undefined ||
        !Uint64.equal(
            displayState.segmentationGroupState.value.segmentEquivalences.get(baseAnchorSegment),
            anchorGraphSegment)) {
      return {
        anchorSegment,
        error: 'Hover over base segment within anchor segment that is closest to merge location'
      };
    }
    return {anchorSegment: baseAnchorSegment, error: undefined};
  }

  private getMergeRequest(): {
    anchorSegment: Uint64|undefined,
    otherSegment: Uint64|undefined,
    anchorSegmentValid: boolean,
    error: string|undefined
  } {
    let {anchorSegment, error} = this.getAnchorSegment();
    if (anchorSegment === undefined || error !== undefined) {
      return {anchorSegment, error, otherSegment: undefined, anchorSegmentValid: false};
    }
    const {displayState} = this.layer;
    const otherSegment = displayState.segmentSelectionState.baseValue;
    if (otherSegment === undefined ||
        Uint64.equal(
            displayState.segmentSelectionState.selectedSegment,
            displayState.segmentationGroupState.value.segmentEquivalences.get(anchorSegment))) {
      return {
        anchorSegment,
        otherSegment: undefined,
        error: 'Hover over segment to merge',
        anchorSegmentValid: true
      };
    }
    return {anchorSegment, otherSegment, error: undefined, anchorSegmentValid: true};
  }

  activate() {
    const activateContext = this.activateContext!;
    const message = activateContext.registerDisposer(new StatusMessage(false));
    const updateTempView = () => {
      const {anchorSegment, otherSegment, anchorSegmentValid} = this.getMergeRequest();
      const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;
      const {segmentEquivalences} = segmentationGroupState;
      if (!anchorSegmentValid) {
        resetTemporaryVisibleSegmentsState(segmentationGroupState);
        return;
      } else {
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
        tempVisibleSegments.clear();
        tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
        if (otherSegment !== undefined) {
          tempVisibleSegments.add(segmentEquivalences.get(otherSegment));
        }
      }
    };
    updateTempView();
    activateContext.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(this.layer.displayState.segmentationGroupState.value);
    });
    const updateStatus = () => {
      const {element} = message;
      element.classList.add('neuroglancer-merge-segments-status');
      const header = document.createElement('div');
      header.classList.add('neuroglancer-status-header');
      header.textContent = 'Merge segments';
      removeChildren(element);
      element.appendChild(header);
      const {displayState} = this.layer;
      let {anchorSegment, otherSegment, error} = this.getMergeRequest();
      const makeWidget = (id: Uint64MapEntry) => {
        const row = makeSegmentWidget(this.layer.displayState, id);
        row.classList.add('neuroglancer-segment-list-entry-double-line');
        return row;
      };
      if (anchorSegment !== undefined) {
        element.appendChild(makeWidget(augmentSegmentId(displayState, anchorSegment)));
      }
      if (error !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = error;
        element.appendChild(msg);
      }
      if (otherSegment !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = ' merge ';
        element.appendChild(msg);
        element.appendChild(makeWidget(augmentSegmentId(displayState, otherSegment)));
      }
      updateTempView();
    };
    updateStatus();
    activateContext.registerDisposer(
        bindSegmentListWidth(this.layer.displayState, message.element));
    const debouncedUpdateStatus =
        activateContext.registerCancellable(animationFrameDebounce(updateStatus));
    registerCallbackWhenSegmentationDisplayStateChanged(
        this.layer.displayState, activateContext, debouncedUpdateStatus);
    activateContext.registerDisposer(this.layer.anchorSegment.changed.add(debouncedUpdateStatus));
    activateContext.registerDisposer(this.lastAnchorBaseSegment.changed.add(debouncedUpdateStatus));
    activateContext.registerDisposer(
        registerActionListener(window, 'annotate-merge-segments', event => {
          event.stopPropagation();
          this.trigger();
        }, {capture: true}));
    activateContext.registerDisposer(
        registerActionListener(window, 'annotate-set-anchor', event => {
          event.stopPropagation();
          this.setAnchor();
        }, {capture: true}));
  }

  async trigger() {
    const {graph: {value: graph}} = this.layer.displayState.segmentationGroupState.value;
    if (graph === undefined) return;
    const {anchorSegment, otherSegment, error} = this.getMergeRequest();
    if (anchorSegment === undefined || otherSegment === undefined || error !== undefined) {
      return;
    }
    try {
      await graph.merge(anchorSegment, otherSegment);
      StatusMessage.showTemporaryMessage(`Merge performed`);
    } catch (e) {
      StatusMessage.showTemporaryMessage(`Merge failed: ${e}`);
    }
  }

  setAnchor() {
    const {segmentSelectionState} = this.layer.displayState;
    const other = segmentSelectionState.baseValue;
    if (other === undefined) return;
    const existingAnchor = this.layer.anchorSegment.value;
    this.layer.displayState.segmentationGroupState.value.visibleSegments.add(other);
    if (existingAnchor === undefined || !Uint64.equal(existingAnchor, other)) {
      this.layer.anchorSegment.value = other.clone();
      return;
    }
  }

  get description() {
    return 'merge';
  }
}

export class SplitSegmentsTool extends Tool {
  layer: SegmentationUserLayer;

  get inputEventMap() {
    return MERGE_SEGMENTS_INPUT_EVENT_MAP;
  }

  toJSON() {
    return ANNOTATE_SPLIT_SEGMENTS_TOOL_ID;
  }

  private getAnchorSegment(): {anchorSegment: Uint64|undefined, error: string|undefined} {
    const {displayState} = this.layer;
    let anchorSegment = this.layer.anchorSegment.value;
    if (anchorSegment === undefined) {
      return {anchorSegment: undefined, error: 'Select anchor segment for split'};
    }
    const anchorGraphSegment =
        displayState.segmentationGroupState.value.segmentEquivalences.get(anchorSegment);
    if (!displayState.segmentationGroupState.value.visibleSegments.has(anchorGraphSegment)) {
      return {anchorSegment, error: 'Anchor segment must be in visible set'};
    }
    return {anchorSegment, error: undefined};
  }

  private getSplitRequest(): {
    anchorSegment: Uint64|undefined,
    otherSegment: Uint64|undefined,
    anchorSegmentValid: boolean,
    error: string|undefined
  } {
    let {anchorSegment, error} = this.getAnchorSegment();
    if (anchorSegment === undefined || error !== undefined) {
      return {anchorSegment, error, otherSegment: undefined, anchorSegmentValid: false};
    }
    const {displayState} = this.layer;
    const otherSegment = displayState.segmentSelectionState.baseValue;
    if (otherSegment === undefined ||
        !Uint64.equal(
            displayState.segmentSelectionState.selectedSegment,
            displayState.segmentationGroupState.value.segmentEquivalences.get(anchorSegment)) ||
        Uint64.equal(otherSegment, anchorSegment)) {
      return {
        anchorSegment,
        otherSegment: undefined,
        anchorSegmentValid: true,
        error: 'Hover over base segment to seed split'
      };
    }
    return {anchorSegment, otherSegment, anchorSegmentValid: true, error: undefined};
  }

  activate() {
    const activateContext = this.activateContext!;
    const message = activateContext.registerDisposer(new StatusMessage(false));
    const updateTempView = () => {
      const {anchorSegment, otherSegment, anchorSegmentValid} = this.getSplitRequest();
      const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;
      const {segmentEquivalences} = segmentationGroupState;
      const {graphConnection} = this.layer;
      console.log('Split result', this.getSplitRequest());
      if (!anchorSegmentValid || graphConnection === undefined) {
        resetTemporaryVisibleSegmentsState(segmentationGroupState);
        return;
      } else {
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        if (otherSegment !== undefined) {
          const splitResult = graphConnection.computeSplit(anchorSegment!, otherSegment);
          if (splitResult !== undefined) {
            segmentationGroupState.useTemporarySegmentEquivalences.value = true;
            const retainedGraphSegment =
                segmentationGroupState.segmentEquivalences.get(anchorSegment!);
            const tempEquivalences = segmentationGroupState.temporarySegmentEquivalences;
            tempEquivalences.clear();
            for (const segment of splitResult.include) {
              tempEquivalences.link(segment, retainedGraphSegment);
            }
            for (const segment of splitResult.exclude) {
              tempEquivalences.link(segment, UNKNOWN_NEW_SEGMENT_ID);
            }
            const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
            tempVisibleSegments.clear();
            tempVisibleSegments.add(retainedGraphSegment);
            tempVisibleSegments.add(UNKNOWN_NEW_SEGMENT_ID);
            return;
          }
        }
        segmentationGroupState.useTemporarySegmentEquivalences.value = false;
        const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
        tempVisibleSegments.clear();
        tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
      }
    };
    updateTempView();
    activateContext.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(this.layer.displayState.segmentationGroupState.value);
    });
    const updateStatus = () => {
      const {element} = message;
      element.classList.add('neuroglancer-merge-segments-status');
      const header = document.createElement('div');
      header.classList.add('neuroglancer-status-header');
      header.textContent = 'Split segments';
      removeChildren(element);
      element.appendChild(header);
      const {displayState} = this.layer;
      let {anchorSegment, otherSegment, error} = this.getSplitRequest();
      const makeWidget = (id: Uint64MapEntry) => {
        const row = makeSegmentWidget(this.layer.displayState, id);
        row.classList.add('neuroglancer-segment-list-entry-double-line');
        return row;
      };
      if (anchorSegment !== undefined) {
        element.appendChild(makeWidget(augmentSegmentId(displayState, anchorSegment)));
      }
      if (error !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = error;
        element.appendChild(msg);
      }
      if (otherSegment !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = ' split ';
        element.appendChild(msg);
        element.appendChild(makeWidget(augmentSegmentId(displayState, otherSegment)));
      }
      updateTempView();
    };
    updateStatus();
    activateContext.registerDisposer(
        bindSegmentListWidth(this.layer.displayState, message.element));
    const debouncedUpdateStatus =
        activateContext.registerCancellable(animationFrameDebounce(updateStatus));
    registerCallbackWhenSegmentationDisplayStateChanged(
        this.layer.displayState, activateContext, debouncedUpdateStatus);
    activateContext.registerDisposer(this.layer.anchorSegment.changed.add(debouncedUpdateStatus));
    activateContext.registerDisposer(
        registerActionListener(window, 'annotate-merge-segments', event => {
          event.stopPropagation();
          this.trigger();
        }, {capture: true}));
    activateContext.registerDisposer(
        registerActionListener(window, 'annotate-set-anchor', event => {
          event.stopPropagation();
          this.setAnchor();
        }, {capture: true}));
  }

  async trigger() {
    const {graph: {value: graph}} = this.layer.displayState.segmentationGroupState.value;
    if (graph === undefined) return;
    const {anchorSegment, otherSegment, error} = this.getSplitRequest();
    if (anchorSegment === undefined || otherSegment === undefined || error !== undefined) {
      return;
    }
    try {
      await graph.split(anchorSegment, otherSegment);
      StatusMessage.showTemporaryMessage(`Split performed`);
    } catch (e) {
      StatusMessage.showTemporaryMessage(`Split failed: ${e}`);
    }
  }

  setAnchor() {
    const {segmentSelectionState} = this.layer.displayState;
    const other = segmentSelectionState.baseValue;
    if (other === undefined) return;
    this.layer.displayState.segmentationGroupState.value.visibleSegments.add(other);
    const existingAnchor = this.layer.anchorSegment.value;
    if (existingAnchor === undefined || !Uint64.equal(existingAnchor, other)) {
      this.layer.anchorSegment.value = other.clone();
      return;
    }
  }

  get description() {
    return `split`;
  }
}

registerTool(ANNOTATE_MERGE_SEGMENTS_TOOL_ID, layer => {
  if (!(layer instanceof SegmentationUserLayer)) return undefined;
  return new MergeSegmentsTool(layer);
});

registerTool(ANNOTATE_SPLIT_SEGMENTS_TOOL_ID, layer => {
  if (!(layer instanceof SegmentationUserLayer)) return undefined;
  return new SplitSegmentsTool(layer);
});
