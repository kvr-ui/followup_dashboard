import { openLead } from '../leadRoute';

// A name or phone that opens the lead page, without triggering the row's own click.
// With no usable key it renders the text as-is — no link to nowhere.
export default function LeadLink({ phoneKey, children }) {
  if (!phoneKey) return children;
  return (
    <a
      href={`#/lead/${phoneKey}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        openLead(phoneKey);
      }}
    >
      {children}
    </a>
  );
}
