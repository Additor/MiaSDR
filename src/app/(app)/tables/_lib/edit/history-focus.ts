/**
 * The toolbar Undo and Redo buttons take focus when clicked, and a button that turns disabled afterwards drops it.
 * Ctrl or Cmd+Z only works while the grid itself has focus (data-grid.tsx), so the click hands focus back to the grid.
 */
export function withGridFocus(action: () => void, refocus: () => void): () => void {
  return () => {
    action();
    refocus();
  };
}
