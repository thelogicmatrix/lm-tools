// gtg learn - read-only view of learning sprints (entries with parent: "learning").
// ownEntries reads BOTH stores: an entry idle >7d is auto-shelved onto the backlog by
// `gtg list` (gtg.mjs autoShelf), so an active-only read would report "no
// learning sprints" for a sprint that exists. No flags, no writes.
export default ({ args, ownEntries, countHandoffFiles }) => {
  const byProject = (a, b) => String(a.project).localeCompare(String(b.project));
  const { active: activeRaw, shelved: shelvedRaw } = ownEntries();
  const active = [...activeRaw].sort(byProject);
  const shelved = [...shelvedRaw].sort(byProject);

  if (!active.length && !shelved.length) {
    console.log('No learning sprints active. Phase 1.5 of docs/runbooks/learning-code.md creates one.');
    return;
  }

  // `gtg learn <topic>` = resume that sprint. GTG-DIRECTIVE hands control back to the
  // skill's Resume Procedure rather than duplicating consume/hooks here.
  const topic = args?.join(' ').trim().toLowerCase();
  if (topic) {
    const hit = [...active, ...shelved].filter(
      (e) => `${e.slug} ${e.project}`.toLowerCase().includes(topic),
    );
    if (hit.length === 1) {
      console.log(`GTG-DIRECTIVE: resume ${hit[0].slug} - read references/resume.md and follow it.`);
      return;
    }
    console.log(
      hit.length
        ? `"${topic}" matches ${hit.length} sprints - name one.`
        : `No learning sprint matches "${topic}".`,
    );
  }

  // ponytail: plain text, no ANSI - `c()` isn't in the extension ctx and a private
  // copy of gtg's colour helper is more code than the colour is worth. Bullets, not
  // digits: `gtg back <n>` numbers a different subset, so a row number here would
  // invite a destructive mis-action.
  const show = (e, isShelved) => {
    const sessions = e.sessions ?? countHandoffFiles(e.slug); // legacy entries predate the field
    const d = (Date.now() - Date.parse(e.updated)) / 86400000;
    const n = Number.isFinite(d) ? Math.floor(d) : '?';
    // autoShelf restamps `updated` to the shelf date, so the same field means
    // "idle for" while active and "shelved" once parked.
    const state = isShelved
      ? `[shelved ${n}d ago]`
      : `(${n}d ago)${d > 6 ? ' ⚠ auto-shelves within a day' : ''}`;
    console.log(`  • ${e.project} (${e.slug}) s${sessions} [${e.eta || '?'}] ${state}`);
    console.log(`     → ${e.next || '?'}`);
  };

  console.log(`Learning sprints (${active.length + shelved.length}):`);
  active.forEach((e) => show(e, false));
  shelved.forEach((e) => show(e, true));
  if (shelved.length) console.log('  Shelved = idle >7d, auto-parked on the gtg backlog. Resume is unchanged: "let\'s continue <slug>" (or `gtg active <slug>`).');
};
