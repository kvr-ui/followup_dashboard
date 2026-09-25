import { leaveLead } from '../leadRoute';

// Placeholder for the full lead page at #/lead/<phoneKey>. The real page replaces it.
export default function LeadProfile({ phoneKey }) {
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          leaveLead();
        }}
      >
        ← Back
      </a>
      <h2 style={{ marginTop: 12 }}>{phoneKey}</h2>
    </div>
  );
}
