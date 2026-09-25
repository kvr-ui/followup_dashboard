// One labelled value in a `.fields` grid, plus the standard "nothing here" mark.

export function Field({ label, children }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-value">{children}</div>
    </div>
  );
}

export const dash = <span className="subtle">—</span>;

/** The value itself, or a muted dash when it is empty. */
export function value(v) {
  return v == null || v === '' ? dash : v;
}
