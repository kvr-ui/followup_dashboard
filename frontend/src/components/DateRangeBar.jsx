import { presetRanges } from '../adStats';

// The date selector both admin ad tabs open with: three presets plus a custom
// from/to pair. Shared by Marketing and Ad Leads so the two tabs cannot drift
// into offering different windows over the same data.
//
// A preset reads as active only when BOTH ends still match it, so nudging one
// date by hand drops the highlight and the range calls itself "Custom" —
// otherwise a picker can sit lit up on "Last 30 days" while showing 12.
export default function DateRangeBar({ range, onChange, children }) {
  const presets = presetRanges();
  // Two presets can describe the SAME window — on the 7th of a month, "Last 7
  // days" and "This month" are both 1st-to-today — so only the first match
  // lights up. Two highlighted buttons reads as a bug even when both are true.
  const activeIndex = presets.findIndex((p) => p.from === range.from && p.to === range.to);

  return (
    <div className="mkt-rangebar">
      <div className="mkt-presets">
        {presets.map((p, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={p.label}
              type="button"
              className={active ? 'mkt-preset mkt-preset-on' : 'mkt-preset'}
              onClick={() => onChange(p)}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="mkt-dates">
        <input
          type="date"
          value={range.from}
          max={range.to}
          onChange={(e) =>
            e.target.value && onChange({ ...range, from: e.target.value, label: 'Custom' })
          }
        />
        <span className="subtle">to</span>
        <input
          type="date"
          value={range.to}
          min={range.from}
          onChange={(e) =>
            e.target.value && onChange({ ...range, to: e.target.value, label: 'Custom' })
          }
        />
      </div>

      {children}
    </div>
  );
}
