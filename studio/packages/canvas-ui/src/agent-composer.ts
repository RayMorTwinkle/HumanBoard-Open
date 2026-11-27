/** A busy board must reject a send before the composer clears its draft. */
export async function submitAgentMessage(
  message: string,
  state: { configured: boolean; pending: boolean; editingLocked: boolean },
  send: (message: string) => void | boolean | Promise<void | boolean>,
): Promise<boolean> {
  const value = message.trim();
  if (!value || !state.configured || state.pending || state.editingLocked)
    return false;
  return (await send(value)) !== false;
}
