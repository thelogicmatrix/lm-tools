// gtg stats — bundled read-only command: a snapshot of the handoff store.
// Demonstrates the ctx contract (readStore + pure compute + print). No mutation.
export default ({ readStore }) => {
  const active = readStore('docs/handoffs/_active.json')?.handoffs ?? [];
  const backlog = readStore('docs/handoffs/_backlog.json')?.backlog ?? [];
  console.log(`${active.length} active, ${backlog.length} backlog`);

  if (active.length) {
    const byTier = {};
    for (const e of active) byTier[e.tier || '?'] = (byTier[e.tier || '?'] || 0) + 1;
    const tiers = Object.entries(byTier).sort().map(([t, n]) => `${t}:${n}`).join('  ');
    console.log(`tiers: ${tiers}`);

    const oldest = active.reduce((a, b) =>
      Date.parse(a.updated || 0) <= Date.parse(b.updated || 0) ? a : b);
    const days = Math.floor((Date.now() - Date.parse(oldest.updated || 0)) / 86400000);
    const age = Number.isFinite(days) ? `${days}d` : '?';
    console.log(`oldest active: ${oldest.project} (${age}, auto-shelf at 7d)`);
  }
};
