import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { theme } from '../styles/themeDefault';
import {
  ChildPositionData,
  Miniature,
  ObjectOfVectors,
  SavedStateType,
  SavedThoughtStateType,
  THOUGHT_STATE,
  Vector,
} from '../types/baseTypes';
import { getTwoPointsDistance, getWindowInnerSize } from '../utils/get';
import { pointer } from './pointer';
import { Thought } from './Thought';
import { OverlapResult, TStore } from './types';
import { view } from './view';

const defaultRoot = new Thought(uuidv4(), { x: 0, y: 0 }, undefined, true, "What's on your mind?");

export const useMindMapStore = create(
  persist<TStore>(
    (set, get) => ({
      pointer,
      connectorsCurveDividerWidth: 2.2,
      defaultSpawnGap: { x: 25, y: 10 },
      isDrawingLocked: false,
      isGroupDragOn: false,
      isInitialized: false,
      initialThoughtWidth: 200,
      rootThought: defaultRoot,
      thoughts: [defaultRoot],
      savedMindMap: '',
      scale: 1,
      lastNewId: 0,
      selection: undefined,
      saveDebounceId: undefined,

      initialize(): void {
        const store = get();

        window.addEventListener('resize', store.updateWorkspaceSize.bind(store));

        view.setReferences();
        store.updateWorkspaceSize();
        view.setThoughtsContainerPosition();
        const root = store.rootThought;
        // if (root.x === 0 && root.y === 0) {
        //   store.setPositionAsync(root.id, view.getMapCenterCoordinates());
        // }

        store.setSelection(root.id);
        store.editSelection();

        store.initPositions();
        view.centerOnThought(store.rootThought);

        const drawLoop = (): void => {
          store.draw();
          requestAnimationFrame(drawLoop);
        };

        drawLoop();
      },

      getNewID(): string {
        return uuidv4();
      },

      addThought(
        position: Vector,
        isRoot?: boolean,
        parentId?: string,
        initText?: string,
        existingId?: string,
      ): Thought {
        const store = get();

        const thought = new Thought(existingId ?? store.getNewID(), position, parentId, isRoot, initText);
        store.updateSingleItem(thought);
        if (isRoot) {
          set(() => ({ rootThought: thought }));
        }

        store.setPositionAsync(thought.id, position);

        return thought;
      },

      postNewThoughActions(newItem: Thought): void {
        const store = get();

        const isFullyWithinViewport = !newItem.isFullyWithinViewport();
        if (!isFullyWithinViewport) {
          const offset = newItem.getViewportOffset();
          view.setMapPosition(-offset.x + Math.sign(-offset.x) * 20, -offset.y + Math.sign(-offset.y) * 20);
        }
        store.editSelection();
        store.saveCurrentMindMapAsJSON();
      },

      getThoughtById(id: string): Thought | undefined {
        const store = get();

        return store.thoughts.find((t) => t.id === id);
      },

      addChildThought(newParentId: string, childId: string): void {
        const store = get();

        const newParent = store.getThoughtById(newParentId);
        if (!newParent) return;

        const child = store.getThoughtById(childId);
        if (!child) return;

        if (newParent.children.every((existingChildId) => existingChildId !== child.id)) {
          newParent.children.push(child.id);
          child.setParent(newParent.id);
        }
      },

      saveChildrenRelativePosition(id: string): void {
        const store = get();

        const thought = store.getThoughtById(id);

        if (!thought || thought.children.length < 1) return;

        const myPosition = thought.getPosition();
        thought.childrenRelativePosition = store
          .getChildren(thought.id, true)
          .map((child: Thought): ChildPositionData => {
            let { x, y } = child.getPosition();
            x -= myPosition.x;
            y -= myPosition.y;

            return { position: { x, y }, id: child.id };
          });
      },

      restoreChildrenRelativePosition(id: string): void {
        const store = get();
        const thought = store.getThoughtById(id);
        if (!thought || thought.children.length < 1) return;

        const myPosition = thought.getPosition();
        const allChildren = store.getChildren(thought.id, true);
        thought.childrenRelativePosition.forEach((positionData): void => {
          const actionedChild = allChildren.find((child) => child.id === positionData.id);
          if (actionedChild) {
            actionedChild.setPosition({
              x: myPosition.x + positionData.position.x,
              y: myPosition.y + positionData.position.y,
            });
          }
        });
      },

      createChildThought(parent: Thought): void {
        const store = get();
        store.stopEditing();

        if (store.selectionId === undefined) return;

        const targetPosition: Vector = parent.getPosition();
        const sideMod = parent.hasParent() && !store.isParentOnLeft(parent.id) ? -1 : 1;
        targetPosition.x +=
          (parent.getOuterWidth() * 0.5 + store.initialThoughtWidth * 0.5 + store.defaultSpawnGap.x) * sideMod;

        const newChild: Thought = store.addThought(targetPosition, false, parent.id);
        parent.children.push(newChild.id);

        store.setSelection(newChild.id);
        store.resolveOverlaps(newChild);
        newChild.refreshPosition();
        store.saveChildrenRelativePosition(parent.id);

        setTimeout(() => {
          store.postNewThoughActions(newChild);
        }, 100);
      },

      createSiblingThought(sibling: Thought): void {
        const store = get();
        store.stopEditing();

        if (store.selectionId === undefined) return;

        const targetPosition: Vector = sibling.getPosition();
        targetPosition.y += sibling.getOuterHeight() * 0.5 + 30 + store.defaultSpawnGap.y;
        const newSibling: Thought = store.addThought(targetPosition, false, sibling.parentId);

        if (sibling.parentId !== undefined) store.addChildThought(sibling.parentId, newSibling.id);

        store.setSelection(newSibling.id);
        store.resolveOverlaps(newSibling);
        newSibling.refreshPosition();

        if (sibling.parentId !== undefined) store.saveChildrenRelativePosition(sibling.parentId);

        setTimeout(() => {
          store.postNewThoughActions(newSibling);
        }, 100);
      },

      removeThought(thoughtId: string): void {
        const store = get();
        const thought = store.getThoughtById(thoughtId);
        if (!thought) return;

        thought.markForRemoval();

        if (thought.parentId !== undefined) {
          store.removeChildThought(thought.parentId, thoughtId);
        }
        if (store.highlightId === thoughtId) {
          set(() => ({ highlightId: undefined }));
        }
        if (store.selectionId === thoughtId) {
          set(() => ({ selectionId: undefined }));
        }

        set((state) => ({
          thoughts: [...state.thoughts.filter((item: Thought) => item.id !== thoughtId)],
        }));
        thought.children.forEach((childId) => {
          store.removeThought(childId);
        });

        store.saveCurrentMindMapAsJSON();
      },

      removeChildThought(parentId: string, childToBeRemovedId: string): void {
        const store = get();
        const parent = store.getThoughtById(parentId);
        if (!parent) return;

        parent.children = parent.children.filter((childId) => childId !== childToBeRemovedId);
        parent.childrenRelativePosition = parent.childrenRelativePosition.filter(
          (position) => position.id !== childToBeRemovedId,
        );

        const child = store.getThoughtById(childToBeRemovedId);
        if (!child) return;
        child.clearParent();
      },

      isParentOf(parentId: string, unknownChildId: string, includeGrandChildren = false): boolean {
        const store = get();
        const child = store.getThoughtById(unknownChildId);
        if (!child) return false;

        const parent = store.getThoughtById(parentId);
        if (!parent) return false;

        if (includeGrandChildren) {
          return store.getChildren(parent.id, true).some((existingChild) => existingChild.id === unknownChildId);
        }

        return parent.children.some((existingChildId) => existingChildId === unknownChildId);
      },

      isChildOf(childId: string, potentialParentId: string): boolean {
        const store = get();
        const child = store.getThoughtById(childId);
        if (!child) return false;

        const parent = store.getThoughtById(potentialParentId);
        if (!parent) return false;

        return parent.children.some((existingChildId) => existingChildId === child.id);
      },

      getChildrenIds(parentId: string, includeGrandChildren?: boolean): string[] {
        const store = get();
        const parent = store.getThoughtById(parentId);
        if (!parent || parent.children.length < 1) return [];

        if (includeGrandChildren) {
          return parent.children.reduce((acc: string[], id: string) => {
            acc.push(id);

            return acc.concat(store.getChildrenIds(id, true));
          }, []);
        }

        return parent.children;
      },

      getChildren(parentId: string, includeGrandChildren = false): Thought[] {
        const store = get();
        const parent = store.getThoughtById(parentId);
        if (!parent || parent.children.length < 1) return [];

        const childrenIds = store.getChildrenIds(parentId, includeGrandChildren);
        const children = childrenIds.map((childId) => store.getThoughtById(childId));
        const filtered = children.filter(Boolean) as Thought[];

        return filtered;
      },

      setHighlight(thoughtId: string): void {
        set(() => ({ highlightId: thoughtId }));
      },

      clearHighlight(): void {
        set(() => ({ highlightId: undefined }));
      },

      setSelection(newSelectionId: string): void {
        const store = get();
        if (store.selectionId !== undefined) {
          const selection = store.getSelectedThought();
          if (selection) {
            selection.setState(THOUGHT_STATE.IDLE);
            store.updateSingleItem(selection);
          }
        }
        set(() => ({ selectionId: newSelectionId }));
        const newlySelected = store.getThoughtById(newSelectionId);
        if (!newlySelected) {
          return;
          //   throw new Error('Could not find newly selected item');
        }
        newlySelected.setState(THOUGHT_STATE.SELECTED);
        store.updateSingleItem(newlySelected);
      },

      clearSelection(): void {
        const store = get();
        if (store.selectionId === undefined) return;
        const selection = store.getSelectedThought();
        if (!selection) return;

        if (!selection.hasValue() && !selection.hasDefaultValue() && !selection.isRootThought) {
          store.removeThought(selection.id);

          return;
        }
        selection.setState(THOUGHT_STATE.IDLE);
        store.updateSingleItem(selection);
        set(() => ({ selectionId: undefined }));
      },

      stopEditing(checkDefaultValue = false): void {
        const store = get();
        if (store.selectionId === undefined) return;
        const selection = store.getSelectedThought();
        if (!selection) return;

        const isEmpty = !selection.hasValue();
        const isntRootThought = selection.id !== store.rootThought.id;
        const hasDefaultValue = checkDefaultValue && !selection.hasDefaultValue();
        if ((isEmpty && isntRootThought) || hasDefaultValue) {
          store.removeThought(selection.id);

          return;
        }

        selection.setState(THOUGHT_STATE.SELECTED);
        store.updateSingleItem(selection);
        store.resolveOverlaps(selection);
        selection.refreshPosition();

        setTimeout(() => {
          store.saveCurrentMindMapAsJSON();
        }, 200);
      },

      setIsGroupDragOn(isOn: boolean): void {
        set(() => ({ isGroupDragOn: isOn }));
      },

      /* Remove thought and return true if was removed and false if it wasn't. */
      removeIfEmpty(thought: Thought): boolean {
        const store = get();

        if (!thought.hasValue() && !thought.hasDefaultValue()) {
          store.removeThought(thought.id);

          return true;
        }

        return false;
      },

      getHighlightedThought(): Thought | undefined {
        const store = get();
        return store.highlightId ? store.getThoughtById(store.highlightId) : undefined;
      },

      getSelectedThought(): Thought | undefined {
        const store = get();
        return store.selectionId ? store.getThoughtById(store.selectionId) : undefined;
      },

      editSelection(): void {
        const store = get();
        const selection = store.getSelectedThought();
        if (!selection) return;

        selection.setState(THOUGHT_STATE.EDITED);
        selection.refreshPosition();
        store.updateSingleItem(selection);
      },

      updateSingleItem(item: Thought): void {
        set((state) => ({ thoughts: [item, ...state.thoughts.filter((i) => i.id !== item.id)] }));
      },

      updateSelectionContent(value: string): void {
        const store = get();
        const selection = store.getSelectedThought();
        if (!selection) return;

        selection.updateContent(value);

        store.updateSingleItem(selection);
      },

      isOverlappingWith(thought: Thought, other: Thought): OverlapResult {
        const { width, height, x, y } = thought.getBoundingBox();
        const { x: a, y: b, width: otherWidth, height: otherHeight } = other.getBoundingBox();
        const isColliding = x + width >= a && y + height >= b && y <= b + otherHeight && x <= a + otherWidth;
        const result = {
          amount: { x: 0, y: 0 },
          isColliding,
          other,
        };
        if (isColliding) {
          result.amount = {
            x: -x + a + width,
            y: -y + b + height,
          };
        }

        return result;
      },

      findOverlapsFor(thought: Thought): OverlapResult[] {
        const store = get();
        const overlaps: OverlapResult[] = [];
        store.thoughts.forEach((otherThought: Thought) => {
          if (otherThought.id !== thought.id) {
            const result = store.isOverlappingWith(thought, otherThought);

            if (result.isColliding) {
              overlaps.push(result);
            }
          }
        });

        return overlaps;
      },

      resolveOverlaps(thought: Thought, axis = 'y'): Thought {
        const store = get();
        const overlaps: OverlapResult[] = store.findOverlapsFor(thought);
        if (overlaps.length < 1) return thought;

        const { amount } = overlaps[0];
        if (amount.x > 0 || amount.y > 0) {
          const targetPosition: Vector = thought.getPosition();
          if (axis === 'y') {
            targetPosition.x += amount[axis] + Math.sign(amount[axis]) * store.defaultSpawnGap[axis];
          } else if (axis === 'x') {
            targetPosition.y += amount[axis] + Math.sign(amount[axis]) * store.defaultSpawnGap[axis];
          }
          thought.setPosition(targetPosition);
          store.resolveOverlaps(thought, 'y');
        }

        return thought;
      },

      findClosestOverlapFor(thought: Thought): void {
        const store = get();
        const myPosition = thought.getPosition();
        const overlaps: OverlapResult[] = store.findOverlapsFor(thought);
        let closestIndex = 0;
        let closestDistance = 0;

        if (overlaps.length > 0) {
          overlaps.forEach((overlap: OverlapResult, index: number) => {
            const distance = getTwoPointsDistance(myPosition, overlap.other.getPosition());
            if (distance < closestDistance) {
              closestDistance = distance;
              closestIndex = index;
            }
          });
          thought.setClosestOverlap(overlaps[closestIndex].other.id);

          return;
        }

        thought.clearClosestOverlap();
      },

      isParentOnLeft(thoughtId: string): boolean {
        const store = get();
        const thought = store.getThoughtById(thoughtId);
        if (!thought) return false;

        const parent = store.getThoughtById(thought.parentId ?? '');
        if (!parent) return false;

        return parent.x < thought.x;
      },

      getConnectorPoints(thoughtId: string): ObjectOfVectors {
        const store = get();
        const thought = store.getThoughtById(thoughtId);
        if (!thought) return {};

        const parent = store.getThoughtById(thought.parentId ?? '');
        if (!parent) return {};

        const isParentsOnLeft = parent ? parent.x < thought.x : false;
        const grandParent = store.getThoughtById(parent.parentId ?? '');
        const isParentsOutOnLeft = parent && grandParent ? grandParent.x < parent.x : isParentsOnLeft;

        const myCorners = thought.getCorners();
        const parentCorners = parent.getCorners() ?? myCorners;

        return {
          me: isParentsOnLeft ? myCorners.bottom.left : myCorners.bottom.right,
          parent: isParentsOutOnLeft ? parentCorners.bottom.right : parentCorners.bottom.left,
        };
      },

      setPositionAsync(thoughtId: string, newPosition: Vector, callback?: () => void): void {
        const store = get();
        const thought = store.getThoughtById(thoughtId);
        if (!thought) return;

        setTimeout(() => {
          if (thought.getElement()) {
            thought.setPosition(newPosition);
            if (thought.parentId !== undefined) thought.prevIsParentOnLeft = store.isParentOnLeft(thought.id);
            if (callback) {
              callback();
            }
            return;
          }

          setTimeout(() => store.setPositionAsync(thought.id, newPosition), 20);
        }, 0);
      },

      initPositions(): void {
        get().thoughts.forEach((t: Thought) => {
          if (t.isRootThought && t.x === 0 && t.y === 0) {
            t.setPosition(view.getMapCenterCoordinates());
          }
          t.refreshPosition();
        });
      },

      updateWorkspaceSize(): void {
        const { x, y } = getWindowInnerSize();
        const { canvas } = view;
        if (!canvas) throw new Error('Canas not avilable.');

        canvas.setAttribute('width', `${x}`);
        canvas.setAttribute('height', `${y}`);
        view.setMiniMapViewportProportionalSize();
      },

      getCurrentMindMapState(): SavedStateType {
        const store = get();

        return {
          thoughts: store.thoughts.map((t: Thought): SavedThoughtStateType => {
            const { content, id, isRootThought, prevIsParentOnLeft, x, y, parentId, children } = t;

            return {
              content,
              id,
              isRootThought,
              prevIsParentOnLeft,
              x,
              y,
              parentId,
              children,
            };
          }),
        };
      },

      saveCurrentMindMapAsJSON(): void {
        const store = get();

        if (store.saveDebounceId) clearTimeout(store.saveDebounceId);

        set(() => ({
          saveDebounceId: setTimeout(() => {
            const data = JSON.stringify(store.getCurrentMindMapState());
            set(() => ({ savedMindMap: `text/json;charset=utf-8,${encodeURIComponent(data)}` }));
          }, 500),
        }));
      },

      deserializeMindMap(saved: SavedStateType): void {
        const store = get();

        store.clearHighlight();
        store.clearSelection();
        set(() => ({ thoughts: [] }));

        // recreate saved nodes
        const uploadedThoughts: Thought[] = saved.thoughts.map((t: SavedThoughtStateType): Thought => {
          const { id, x, y, isRootThought, content, parentId } = t;
          const restored: Thought = store.addThought({ x, y }, isRootThought, parentId, content, id);
          restored.children = t.children;
          store.saveChildrenRelativePosition(restored.id);
          return restored;
        });

        const postSetup = () => {
          set(() => ({ thoughts: uploadedThoughts }));
          set(() => ({ isDrawingLocked: false }));
          store.setSelection(store.rootThought.id);
          store.editSelection();
          store.initPositions();
          view.centerOnThought(store.rootThought);
        };
        setTimeout(postSetup, 0);
      },

      setDrawLock(isDrawingLocked: boolean): void {
        set(() => ({ isDrawingLocked }));
      },

      draw(): void {
        if (!view) {
          throw new Error('View object reference not avilable');
        }

        const store = get();
        if (store.isDrawingLocked) return;

        const { canvas, context } = view;
        if (!canvas) {
          throw new Error('canvas object reference not avilable');
        }
        if (!context) {
          throw new Error('context object reference not avilable');
        }

        const { connectorsCurveDividerWidth, rootThought, thoughts } = store;

        context.clearRect(0, 0, canvas.width, canvas.height);

        if (thoughts.length < 1 || rootThought === undefined) return;

        const miniatures: Miniature[] = [];
        thoughts.forEach((thought) => {
          const miniature = view.getMiniMapMiniature(thought.getPosition(), thought.getSize(), thought.id);
          miniatures.push(miniature);
          view.drawMiniature(miniature);
        });

        const rootsChildren: Thought[] = store.getChildren(rootThought.id, true);
        const offset: Vector = view.getThoughtsContainerPosition();
        if (rootsChildren.length < 1) return;

        rootsChildren.forEach((child: Thought) => {
          const { me, parent } = store.getConnectorPoints(child.id);
          me.x += offset.x;
          me.y += offset.y - 1;
          parent.x += offset.x;
          parent.y += offset.y - 1;
          me.x += 1;
          parent.x -= 1;
          const { x } = me;
          const { x: a } = parent;
          const mod = (x - a) / connectorsCurveDividerWidth;
          const bezierControlPointA = { x: -mod, y: 0 };
          const bezierControlPointB = { x: mod, y: 0 };
          view.drawBezierCurve(
            me,
            parent,
            bezierControlPointA,
            bezierControlPointB,
            theme.connectorsWidth,
            theme.colors.connectors(),
          );

          // draw miniatures connectors
          const myMiniature = miniatures.filter((mini) => mini.id === child.id)[0];
          const parentMiniature = miniatures.filter((mini) => mini.id === (child.parentId ?? -1))[0];
          const xStart = myMiniature.x > parentMiniature.x ? myMiniature.x : myMiniature.x + myMiniature.width;
          const yStart = myMiniature.y + myMiniature.height * 0.5;
          const xEnd =
            myMiniature.x > parentMiniature.x ? parentMiniature.x + parentMiniature.width : parentMiniature.x;
          const yEnd = parentMiniature.y + parentMiniature.height * 0.5;
          const miniatureMod = (xStart - xEnd) / connectorsCurveDividerWidth;
          const miniatureControlPointA = { x: -miniatureMod, y: 0 };
          const miniatureControlPointB = { x: miniatureMod, y: 0 };

          view.drawBezierCurve(
            { x: xStart, y: yStart },
            { x: xEnd, y: yEnd },
            miniatureControlPointA,
            miniatureControlPointB,
            1,
            theme.colors.miniatureConnector(),
          );
        });
      },

      onMouseMove(event: MouseEvent): void {
        const store = get();
        const { pointer: mouse } = store;
        const selection = store.getSelectedThought();

        mouse.lastPosition.x = mouse.position.x;
        mouse.lastPosition.y = mouse.position.y;
        mouse.position.x =
          event.pageX || event.clientX + document.body.scrollLeft + document.documentElement.scrollLeft;
        mouse.position.y = event.pageY || event.clientY + document.body.scrollTop + document.documentElement.scrollTop;

        const selectionCanBeDragged = mouse.isLeftButtonDown && selection && selection.id === mouse.draggedItemId;
        if (!selectionCanBeDragged) return;

        const { x, y } = mouse.position;
        store.findClosestOverlapFor(selection);
        selection.setState(THOUGHT_STATE.DRAGGED);
        selection.setOnTop();
        selection.setPosition({
          x: x + selection.diffX,
          y: y + selection.diffY,
        });

        const canDragSelectionChildren = store.isGroupDragOn && selection.hasChildren();
        if (!canDragSelectionChildren) return;

        const isParentOnLeft = store.isParentOnLeft(selection.id);
        if (!selection.isRootThought && isParentOnLeft !== selection.prevIsParentOnLeft) {
          selection.childrenRelativePosition.forEach((_: ChildPositionData, index: number): void => {
            const positionData = selection.childrenRelativePosition[index];
            positionData.position.x *= -1; // eslint-disable-line no-param-reassign
          });
        }
        store.restoreChildrenRelativePosition(selection.id);
        selection.setPrevIsParentOnLeft(isParentOnLeft);
      },

      customOnFinishHydration(): void {
        const store = get();
        const hydratedThoughts = store.thoughts.map((thought) => Thought.clone(thought));
        const root = hydratedThoughts.find(({ isRootThought }) => !!isRootThought);

        set(() => ({
          thoughts: hydratedThoughts,
          rootThought: root,
        }));
      },
    }),
    {
      // local storage id, change to abandon current storage and use new local storage
      name: 'c913d614-da17-4383-809f-fa6d6314535491',
      merge: (persistedState: unknown, currentState: TStore): TStore => {
        const retrivedState = persistedState as TStore;
        const retrivedThoughts = retrivedState.thoughts.map((thought) => Thought.clone(thought));

        return {
          ...retrivedState,
          ...currentState,
          thoughts: retrivedThoughts,
          rootThought: retrivedThoughts.find(({ isRootThought }) => !!isRootThought),
        } as TStore;
      },
    },
  ),
);

export const useSelection = (): [Thought | undefined, (id: string) => void, () => void] =>
  useMindMapStore(
    (state) => [state.getSelectedThought(), state.setSelection.bind(state), state.editSelection.bind(state)],
    shallow,
  );
