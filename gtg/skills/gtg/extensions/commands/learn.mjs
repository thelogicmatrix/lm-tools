// gtg learn - read-only view of learning sprints. The parent namespace it reads under is
// gtg.mjs's EXTENSIONS map, reached through ctx.ownEntries and never named here.
// ownEntries reads BOTH stores, so a shelved sprint still shows. No flags, no writes.
export default ({ args, ownEntries, countHandoffFiles }) => {
  const byProject = (a, b) => String(a.project).localeCompare(String(b.project));
  const { active: activeRaw, shelved: shelvedRaw } = ownEntries();
  const active = [...activeRaw].sort(byProject);
  const shelved = [...shelvedRaw].sort(byProject);

  if (!active.length && !shelved.length) {
    // ponytail: name the mechanism, not a doc. A path here is this repo's own convention
    // shipped to strangers, and it goes stale the moment that file is renamed.
    console.log('No learning sprints tracked. A sprint becomes one with `gtg handoff --parent learning`.');
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
      console.log(`GTG-DIRECTIVE: run gtg.mjs resume ${hit[0].slug} and follow the SKILL.md Resume Procedure.`);
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
    const state = isShelved ? `[shelved ${n}d ago]` : `(${n}d ago)`;
    console.log(`  • ${e.project} (${e.slug}) s${sessions} [${e.eta || '?'}] ${state}`);
    console.log(`     → ${e.next || '?'}`);
  };

  console.log(`Learning sprints (${active.length + shelved.length}):`);
  active.forEach((e) => show(e, false));
  shelved.forEach((e) => show(e, true));
  if (shelved.length) console.log('  Shelved = on the gtg backlog. Resume is unchanged: "let\'s continue <slug>" (or `gtg active <slug>`).');
};
