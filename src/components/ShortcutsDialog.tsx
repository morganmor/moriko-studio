import { Modal } from './ui';

interface ShortcutRow {
  keys: string;
  label: string;
}

const GROUPS: { title: string; rows: ShortcutRow[] }[] = [
  {
    title: 'Global',
    rows: [
      { keys: 'Ctrl K', label: 'Search or jump — command palette' },
      { keys: 'Ctrl B', label: 'Toggle sidebar' },
      { keys: 'Ctrl .', label: 'Toggle configuration panel' },
      { keys: 'Alt N', label: 'New chat' },
      { keys: 'Alt A', label: 'Toggle agent mode' },
      { keys: 'F2', label: 'Rename the active chat' },
      { keys: '?', label: 'Open this shortcuts dialog' },
      { keys: 'Esc', label: 'Close panels, dialogs and drawers' },
    ],
  },
  {
    title: 'Composer',
    rows: [
      { keys: 'Enter', label: 'Send message (or steer the running generation)' },
      { keys: 'Shift Enter', label: 'New line' },
    ],
  },
];

/**
 * Keyboard shortcuts cheat-sheet. Lives inside the sidebar so the footer's
 * keyboard button and the global `?` key both open it; rendered through the
 * shared themed Modal (never a native browser dialog).
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Everything reachable without leaving the keyboard."
      size="sm"
    >
      <div className="kbd-groups">
        {GROUPS.map((group) => (
          <section key={group.title} className="kbd-group">
            <p className="sec-label">{group.title}</p>
            <ul className="kbd-list">
              {group.rows.map((row) => (
                <li key={row.keys} className="kbd-row">
                  <kbd>{row.keys}</kbd>
                  <span>{row.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
