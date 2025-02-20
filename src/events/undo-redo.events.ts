import {caretPosition, debounce} from '@deckdeckgo/utils';
import configStore from '../stores/config.store';
import containerStore from '../stores/container.store';
import undoRedoStore from '../stores/undo-redo.store';
import {
  UndoRedoAddRemoveParagraph,
  UndoRedoInput,
  UndoRedoSelection,
  UndoRedoUpdateParagraph
} from '../types/undo-redo';
import {elementIndex, nodeDepths, toHTMLElement} from '../utils/node.utils';
import {findParagraph} from '../utils/paragraph.utils';
import {
  filterAttributesMutations,
  findAddedNodesParagraphs,
  findAddedParagraphs,
  findRemovedNodesParagraphs,
  findRemovedParagraphs,
  findSelectionParagraphs,
  findUpdatedParagraphs,
  RemovedParagraph
} from '../utils/paragraphs.utils';
import {getSelection} from '../utils/selection.utils';
import {toUndoRedoSelection} from '../utils/undo-redo-selection.utils';
import {
  nextRedoChanges,
  nextUndoChanges,
  redo,
  stackUndoInput,
  stackUndoParagraphs,
  undo
} from '../utils/undo-redo.utils';

interface UndoUpdateParagraphs extends UndoRedoUpdateParagraph {
  paragraph: HTMLElement;
}

export class UndoRedoEvents {
  private observer: MutationObserver | undefined;

  private undoInputs: UndoRedoInput[] | undefined = undefined;
  private undoUpdateParagraphs: UndoUpdateParagraphs[] = [];
  private undoSelection: UndoRedoSelection | undefined = undefined;

  private readonly debounceUpdateInputs: () => void = debounce(() => this.stackUndoInputs(), 350);

  private unsubscribe;

  init() {
    this.undoInputs = undefined;
    this.undoUpdateParagraphs = [];

    this.observer = new MutationObserver(this.onMutation);

    this.observe();

    containerStore.state.ref?.addEventListener('keydown', this.onKeydown);

    containerStore.state.ref?.addEventListener('keyup', this.onKeyup);
    containerStore.state.ref?.addEventListener('mousedown', this.onMouseTouchDown);
    containerStore.state.ref?.addEventListener('touchstart', this.onMouseTouchDown);
    containerStore.state.ref?.addEventListener('snapshotParagraph', this.onSnapshotParagraph);

    document.addEventListener('selectionchange', this.onSelectionChange);

    document.addEventListener('toolbarActivated', this.onToolbarActivated);
    document.addEventListener('menuActivated', this.onMenuActivated);

    this.unsubscribe = undoRedoStore.onChange('observe', (observe: boolean) => {
      if (observe) {
        // We re-active the selection as if we would have selected a paragraphs because we might need to record next update
        this.copySelectedParagraphs({filterEmptySelection: false});
        this.undoInputs = undefined;

        this.observe();
        return;
      }

      this.disconnect();
    });
  }

  destroy() {
    this.disconnect();

    containerStore.state.ref?.removeEventListener('keydown', this.onKeydown);

    containerStore.state.ref?.removeEventListener('keyup', this.onKeyup);
    containerStore.state.ref?.removeEventListener('mousedown', this.onMouseTouchDown);
    containerStore.state.ref?.removeEventListener('touchstart', this.onMouseTouchDown);
    containerStore.state.ref?.removeEventListener('snapshotParagraph', this.onSnapshotParagraph);

    document.removeEventListener('selectionchange', this.onSelectionChange);

    document.removeEventListener('toolbarActivated', this.onToolbarActivated);
    document.removeEventListener('menuActivated', this.onMenuActivated);

    this.unsubscribe?.();
  }

  private onKeydown = async ($event: KeyboardEvent) => {
    const {key, ctrlKey, metaKey, shiftKey} = $event;

    if (key === 'Enter') {
      this.stackUndoInputs();
      return;
    }

    if (key === 'z' && (ctrlKey || metaKey) && !shiftKey) {
      await this.undo($event);
      return;
    }

    if (key === 'z' && (ctrlKey || metaKey) && shiftKey) {
      await this.redo($event);
      return;
    }
  };

  private onKeyup = () => {
    this.onEventUpdateParagraphs(getSelection(containerStore.state.ref)?.anchorNode);
  };

  private onSelectionChange = () =>
    (this.undoSelection = toUndoRedoSelection(containerStore.state.ref));

  private async undo($event: KeyboardEvent) {
    $event.preventDefault();

    if (nextUndoChanges() === undefined) {
      return;
    }

    await this.undoRedo({undoRedo: undo});
  }

  private async redo($event: KeyboardEvent) {
    $event.preventDefault();

    if (nextRedoChanges() === undefined) {
      return;
    }

    await this.undoRedo({undoRedo: redo});
  }

  private stackUndoInputs() {
    this.copySelectedParagraphs({filterEmptySelection: false});

    if (!this.undoInputs) {
      return;
    }

    stackUndoInput({
      data: this.undoInputs,
      container: containerStore.state.ref
    });

    this.undoInputs = undefined;
  }

  private async undoRedo({undoRedo}: {undoRedo: () => Promise<void>}) {
    // We skip mutations when we process undo redo
    this.disconnect();

    await undoRedo();

    this.observe();
  }

  private observe() {
    this.observer.observe(containerStore.state.ref, {
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      subtree: true
    });
  }

  private disconnect() {
    this.observer?.disconnect();
  }

  private onToolbarActivated = () => {
    this.copySelectedParagraphs({filterEmptySelection: true});
  };

  private onMenuActivated = ({detail}: CustomEvent<{paragraph: HTMLElement}>) => {
    const {paragraph} = detail;
    this.undoUpdateParagraphs = this.toUpdateParagraphs([paragraph]);
  };

  private onSnapshotParagraph = ({target}: CustomEvent<void>) => {
    this.onEventUpdateParagraphs(target as Node);
  };

  private onMouseTouchDown = ({target}: MouseEvent | TouchEvent) => {
    this.onEventUpdateParagraphs(target as Node);
  };

  private onEventUpdateParagraphs(target: Node | undefined) {
    if (!target) {
      return;
    }

    const paragraph: HTMLElement | undefined = toHTMLElement(
      findParagraph({element: target as Node, container: containerStore.state.ref})
    );

    if (!paragraph) {
      return;
    }

    this.undoUpdateParagraphs = this.toUpdateParagraphs([paragraph]);
  }

  // Copy current paragraphs value to a local state so we can add it to the undo redo global store in case of modifications
  private copySelectedParagraphs({filterEmptySelection}: {filterEmptySelection: boolean}) {
    const paragraphs: HTMLElement[] | undefined = findSelectionParagraphs({
      container: containerStore.state.ref,
      filterEmptySelection
    });

    if (!paragraphs) {
      return;
    }

    this.undoUpdateParagraphs = this.toUpdateParagraphs(paragraphs);
  }

  private toUpdateParagraphs(paragraphs: HTMLElement[]): UndoUpdateParagraphs[] {
    return paragraphs.map((paragraph: HTMLElement) => ({
      outerHTML: paragraph.outerHTML,
      index: elementIndex(paragraph),
      paragraph
    }));
  }

  private onCharacterDataMutations(mutations: MutationRecord[]) {
    const characterMutations: MutationRecord[] = mutations.filter(
      ({oldValue}: MutationRecord) => oldValue !== null
    );

    // No character mutations
    if (characterMutations.length <= 0) {
      return;
    }

    if (!this.undoInputs) {
      this.undoInputs = characterMutations
        .map((mutation: MutationRecord) => this.toUndoInput(mutation))
        .filter((undoInput: UndoRedoInput | undefined) => undoInput !== undefined);
    }

    if (this.undoInputs.length <= 0) {
      this.undoInputs = undefined;
      return;
    }

    this.debounceUpdateInputs();
  }

  private toUndoInput(mutation: MutationRecord): UndoRedoInput | undefined {
    const target: Node = mutation.target;

    const newValue: string = target.nodeValue;

    // Firefox triggers a character mutation that has same previous and new value when we delete a range in deleteContentBackward
    if (newValue === mutation.oldValue) {
      return undefined;
    }

    const paragraph: HTMLElement | undefined = toHTMLElement(
      findParagraph({element: target, container: containerStore.state.ref})
    );

    if (!paragraph || !target.parentNode) {
      return undefined;
    }

    // We find the list of node indexes of the parent of the modified text
    const depths: number[] = nodeDepths({target, paragraph});

    return {
      oldValue: mutation.oldValue,
      offset: caretPosition({target}) + (mutation.oldValue.length - newValue.length),
      index: elementIndex(paragraph),
      indexDepths: depths
    };
  }

  private onMutation = (mutations: MutationRecord[]) => {
    const addRemoveParagraphs: UndoRedoAddRemoveParagraph[] = this.onParagraphsMutations(mutations);

    const updateParagraphs: UndoRedoUpdateParagraph[] = this.onNodesParagraphsMutation(mutations);

    stackUndoParagraphs({
      container: containerStore.state.ref,
      addRemoveParagraphs: addRemoveParagraphs,
      updateParagraphs,
      selection: this.undoSelection
    });

    // We assume that all paragraphs updates do contain attributes and input changes
    if (updateParagraphs.length > 0) {
      return;
    }

    this.onAttributesMutation(mutations);

    this.onCharacterDataMutations(mutations);
  };

  /**
   * Paragraphs added and removed
   */
  private onParagraphsMutations(mutations: MutationRecord[]): UndoRedoAddRemoveParagraph[] {
    const changes: UndoRedoAddRemoveParagraph[] = [];

    // New paragraph
    const addedParagraphs: HTMLElement[] = findAddedParagraphs({
      mutations,
      container: containerStore.state.ref
    });
    addedParagraphs.forEach((paragraph: HTMLElement) =>
      changes.push({
        outerHTML: this.cleanOuterHTML(paragraph),
        mutation: 'add',
        index: paragraph.previousElementSibling
          ? elementIndex(toHTMLElement(paragraph.previousElementSibling)) + 1
          : 0
      })
    );

    // Paragraphs removed
    const removedParagraphs: RemovedParagraph[] = findRemovedParagraphs({
      mutations,
      container: containerStore.state.ref
    });

    const lowerIndex: number = Math.min(
      ...removedParagraphs.map(({previousSibling}: RemovedParagraph) =>
        previousSibling ? elementIndex(toHTMLElement(previousSibling)) + 1 : 0
      )
    );

    removedParagraphs.forEach(({paragraph}: RemovedParagraph, index: number) => {
      const elementIndex: number = index + (Number.isFinite(lowerIndex) ? lowerIndex : 0);

      const undoParagraph: UndoUpdateParagraphs | undefined = this.undoUpdateParagraphs.find(
        ({index}: UndoUpdateParagraphs) => index === elementIndex
      );

      // cleanOuterHTML is only there as fallback, we should find the previous outerHTML value in undoUpdateParagraphs

      return changes.push({
        outerHTML: undoParagraph?.outerHTML || this.cleanOuterHTML(paragraph),
        mutation: 'remove',
        index: elementIndex
      });
    });

    return changes;
  }

  /**
   * Nodes within paragraphs added and removed.
   *
   * If we stack an update of the paragraph we shall not also stack an "input" update at the same time.
   *
   * @return did update
   */
  private onNodesParagraphsMutation(mutations: MutationRecord[]): UndoUpdateParagraphs[] {
    const addedNodesMutations: MutationRecord[] = findAddedNodesParagraphs({
      mutations,
      container: containerStore.state.ref
    });
    const removedNodesMutations: MutationRecord[] = findRemovedNodesParagraphs({
      mutations,
      container: containerStore.state.ref
    });

    const needsUpdate: boolean = addedNodesMutations.length > 0 || removedNodesMutations.length > 0;

    if (!needsUpdate) {
      return [];
    }

    if (this.undoUpdateParagraphs.length <= 0) {
      return [];
    }

    const addedParagraphs: HTMLElement[] = findAddedParagraphs({
      mutations,
      container: containerStore.state.ref
    });

    // Check that the nodes of the paragraphs to update were not already been added to the undoRedo store in `onParagraphsMutations`
    const filterUndoUpdateParagraphs: UndoUpdateParagraphs[] = this.undoUpdateParagraphs.filter(
      ({paragraph}: UndoUpdateParagraphs) =>
        paragraph.isConnected &&
        addedParagraphs.find((element: HTMLElement) => element.isEqualNode(paragraph)) === undefined
    );

    if (filterUndoUpdateParagraphs.length <= 0) {
      this.copySelectedParagraphs({filterEmptySelection: true});
      return [];
    }

    this.copySelectedParagraphs({filterEmptySelection: true});

    this.undoInputs = undefined;

    return filterUndoUpdateParagraphs;
  }

  private cleanOuterHTML(paragraph: HTMLElement): string {
    const clone: HTMLElement = paragraph.cloneNode(true) as HTMLElement;
    clone.removeAttribute('placeholder');
    return clone.outerHTML;
  }

  private onAttributesMutation(mutations: MutationRecord[]) {
    const updateParagraphs: HTMLElement[] = findUpdatedParagraphs({
      mutations: filterAttributesMutations({
        mutations,
        excludeAttributes: configStore.state.excludeAttributes
      }),
      container: containerStore.state.ref
    });

    if (updateParagraphs.length <= 0) {
      return;
    }

    if (this.undoUpdateParagraphs.length <= 0) {
      return;
    }

    stackUndoParagraphs({
      container: containerStore.state.ref,
      addRemoveParagraphs: [],
      updateParagraphs: this.undoUpdateParagraphs,
      selection: this.undoSelection
    });

    this.undoUpdateParagraphs = this.toUpdateParagraphs(updateParagraphs);
  }
}
