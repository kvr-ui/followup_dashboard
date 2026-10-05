import { useState } from 'react';
import Section from '../ui/Section';

const TIMELINE_LABELS = {
  form: 'Form',
  task: 'Follow-up',
  status: 'Status',
  note: 'Note',
  whatsapp: 'WhatsApp',
  call: 'Call',
  deal: 'Deal',
};

const TIME_FMT = { hour: 'numeric', minute: '2-digit' };

/** "Today", "Yesterday", "25 Sep" — or "25 Sep 2025" outside this year. */
function dayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export default function LeadTimeline({ events }) {
  const [type, setType] = useState('all');
  // Only the types this lead actually has, in the label order.
  const types = Object.keys(TIMELINE_LABELS).filter((t) => events.some((e) => e.type === t));
  const shown = type === 'all' ? events : events.filter((e) => e.type === type);

  // Events arrive newest first; group consecutive ones under a day heading.
  const days = [];
  for (const ev of shown) {
    const label = dayLabel(ev.at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else days.push({ label, events: [ev] });
  }

  // The type filter sits in the card's title row, so it stays put while the days scroll.
  const chips =
    types.length > 1 ? (
      <div className="lp-chips">
        {['all', ...types].map((t) => (
          <button
            key={t}
            className={type === t ? 'lp-chip active' : 'lp-chip'}
            onClick={() => setType(t)}
          >
            {t === 'all' ? 'All' : TIMELINE_LABELS[t]}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <Section
      title="Timeline"
      meta={`${shown.length} ${shown.length === 1 ? 'event' : 'events'}`}
      actions={chips}
    >
      {days.map((day) => (
        <div key={day.label} className="lp-day">
          <div className="lp-day-label">{day.label}</div>
          <ul className="lp-timeline">
            {day.events.map((ev, i) => (
              <li key={`${ev.at}-${i}`} className={`lp-ev lp-ev-${ev.type}`}>
                <span className={`badge lp-type lp-type-${ev.type}`}>
                  {TIMELINE_LABELS[ev.type] || ev.type}
                </span>
                <div className="lp-ev-body">
                  <div className="lp-ev-text">{ev.text}</div>
                  <div className="lp-ev-meta">
                    {new Date(ev.at).toLocaleTimeString('en-IN', TIME_FMT)}
                    {ev.by && <> · {ev.by}</>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}
