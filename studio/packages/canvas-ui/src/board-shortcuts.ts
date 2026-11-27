/** Dialog actions must never edit the board behind the dialog. */
export function boardShortcutsBlocked(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    event.isComposing ||
    !!document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]')
  );
}
