"use client";

export function TodaysHighlightCard() {
  return (
    <section className="kv-card kv-glass kv-highlight-card">
      <div className="kv-focus-head">
        <h2 className="kv-section-title kv-serif">Today&apos;s Highlight</h2>
        <span className="kv-badge">Priority</span>
      </div>
      <article className="kv-highlight-item">
        <div className="kv-row">
          <p className="kv-highlight-title">Resolve critical overdue invoices before 6 PM.</p>
          <span className="kv-badge-warning">In Progress</span>
        </div>
        <p className="kv-subtitle">
          Three invoices are past due and impacting today&apos;s cashflow confidence. Send reminders and
          confirm owner follow-up.
        </p>
      </article>
    </section>
  );
}

