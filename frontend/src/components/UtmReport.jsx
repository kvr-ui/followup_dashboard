import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import SubTabs from './ui/SubTabs';
import DataTable from './ui/DataTable';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { defaultRange, formatCount, formatDay, formatPct, formatRupees } from '../adStats';

// The UTM Report tab — landing-page leads grouped by one tracking value at a
// time (utm_source … utm_term, cp1, cp2): Registrations → Demo completed → Sales
// → Revenue. Renders GET /api/ads/utm-report verbatim; one fetch carries every
// dimension, so switching tabs is client-side. The only maths here is the two
// rates. See backend services/utmReport for the rules: values merge
// case-insensitively, "demo completed" = a connected call or a deal exists, and
// revenue is the won deals' amount.

const TABS = [
  { id: 'source', label: 'UTM Source' },
  { id: 'medium', label: 'UTM Medium' },
  { id: 'campaign', label: 'UTM Campaign' },
  { id: 'content', label: 'UTM Content' },
  { id: 'term', label: 'UTM Term' },
  { id: 'cp1', label: 'CP 1' },
  { id: 'cp2', label: 'CP 2' },
];

const pct = (n, d) => (d > 0 ? (n / d) * 100 : null);

function Cells({ row }) {
  return (
    <>
      <td className="num">{formatCount(row.registrations)}</td>
      <td className="num">
        {formatCount(row.demo)} <span className="subtle">({formatPct(pct(row.demo, row.registrations))})</span>
      </td>
      <td className="num">{formatCount(row.sales)}</td>
      <td className="num">{formatPct(pct(row.sales, row.demo))}</td>
      <td className="num">{formatRupees(row.revenue)}</td>
    </>
  );
}

export default function UtmReport() {
  const [range, setRange] = useState(defaultRange);
  const [tab, setTab] = useState('source');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (r) => {
    setLoading(true);
    try {
      setData(await api(`/api/ads/utm-report?from=${r.from}&to=${r.to}`));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  const block = data && data.dimensions && data.dimensions[tab];
  const rows = (block && block.rows) || [];
  const header = TABS.find((t) => t.id === tab).label;

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar range={range} onChange={setRange}>
            <button onClick={() => load(range)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </DateRangeBar>
        }
      />

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="subtle">Loading UTM report…</p>}

      {data && (
        <>
          <SubTabs tabs={TABS} active={tab} onSelect={setTab} />
          <Section
            title={`By ${header}`}
            meta={`Web leads captured ${formatDay(range.from)} – ${formatDay(range.to)}`}
            flush={rows.length > 0}
          >
            {rows.length === 0 ? (
              <EmptyState title="No web leads in this window">Try a wider window.</EmptyState>
            ) : (
              <DataTable className="mkt-wide">
                <thead>
                  <tr>
                    <th>{header}</th>
                    <th className="num" title="Landing-page leads (one per person per row)">
                      Registrations
                    </th>
                    <th className="num" title="A connected call, or a Bigin deal exists — % of registrations">
                      Demo completed
                    </th>
                    <th className="num" title="Deal closed with sale">Sales</th>
                    <th className="num" title="Sales as % of demo completed">Conversion rate</th>
                    <th className="num" title="Won deals' amount">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <Cells row={row} />
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <Cells row={block.totals} />
                  </tr>
                </tfoot>
              </DataTable>
            )}
          </Section>
        </>
      )}
    </>
  );
}
