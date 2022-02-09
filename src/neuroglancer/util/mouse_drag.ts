/**
 * @license
 * Copyright 2016 Google Inc.
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

import './dot_drag_drop.css';

export type RelativeDragHandler = (event: MouseEvent, deltaX: number, deltaY: number) => void;
export function startRelativeMouseDrag(
    initialEvent: MouseEvent, handler: RelativeDragHandler,
    finishDragHandler?: RelativeDragHandler) {
  const {document} = initialEvent.view!;
  let prevClientX = initialEvent.clientX, prevClientY = initialEvent.clientY;
  console.log(prevClientX)
  console.log(prevClientY)
  let dragCoordinates = new Array();
  const mouseMoveHandler = (e: PointerEvent) => {
    const deltaX = e.clientX - prevClientX;
    const deltaY = e.clientY - prevClientY;
    prevClientX = e.clientX;
    prevClientY = e.clientY;
    console.log("mouse location:", e.clientX, e.clientY);
    dragCoordinates.push(e.clientX, e.clientY);
    //console.log(dragCoordinates);
    var pos = e;
    const dot = document.createElement('div');
    dot.className = "dot";
    dot.style.left = pos.x + "px";
    dot.style.top = pos.y + "px";
    document.body.appendChild(dot);
    handler(e, deltaX, deltaY);
  };
  //console.log(dragCoordinates);
  const button = initialEvent.button;
  const cancel = (e: PointerEvent) => {
    document.removeEventListener('pointermove', mouseMoveHandler, true);ç
    document.removeEventListener('pointerup', mouseUpHandler, false);

    if (finishDragHandler !== undefined) {
      finishDragHandler(e, e.clientX - prevClientX, e.clientY - prevClientY);
    }
  };
  const mouseUpHandler = (e: PointerEvent) => {
    if (e.button === button) {
      console.log(dragCoordinates);
      cancel(e);
    }
  };
  document.addEventListener('pointermove', mouseMoveHandler, true);
  //document.addEventListener('pointerdrag', mouseDragHandler, true);
  document.addEventListener('pointerup', mouseUpHandler, false);
  document.addEventListener('pointercancel', cancel, false);
}
