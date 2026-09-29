# logical-tools: Mouldable AI tool frameworks

Nine bespoke plugins covering fundamental tools to create cohesive AI workflows, and each modifiable to your specific needs. Built to retain your custom behaviour between updates, while balancing performance, efficiency and cost. 

By [Nathan Wong](https://github.com/thelogicmatrix).

## Install

Add the marketplace, then install whichever plugins you want. They are independent.

```
/plugin marketplace add thelogicmatrix/logical-tools
/plugin install gtg@logical-tools
```

In Codex:

```
codex plugin marketplace add thelogicmatrix/logical-tools
codex plugin add gtg@logical-tools
```

Swap `gtg` for any plugin name below. Both harnesses run the same source, not copied ports. Most plugins are also a plain skill folder you can copy into `.claude/skills/` for a frozen copy that never updates.

## The plugins

### [gtg](gtg/README.md): todo list and handoffs for AI 
Say "gtg" and the agent writes a handoff a fresh session can resume from. Say "gtg <project>" next time and it carries on from the next action. The bookkeeping runs in a CLI, so it costs no tokens. 

Functionally, just a todo list with notes attached, made smart by handoffs and git. Simple in concept, magical in practice. **Extend it** with your own subcommands and after-handoff steps in `.gtg/`.

### [logical-projects](logical-projects/README.md): basic project tracking
A generated index of every project and one page each, and a `sync` that checks both against the repos so the table never quietly goes stale. No extension point yet, deliberately.

### [postman](postman/README.md): the ultimate email manager
Sends cold email and threaded replies from your own mailbox. If any reply in a batch cannot find its thread, nothing sends. **Extend it** with one identity per mailbox, each with its own signature, voice and password command.

### [jevtools](jevtools/README.md): primitive tools made for big work
A fast, cheap model reads a large body of text first and hands your agent only the parts worth its attention. **Extend it** with a new sweep, one JSON file each.

### [due-diligence](due-diligence/README.md): your harshest critic
`due-diligence` sends a critic after your work before anyone else sees it, and `cdd` hands you the same checklists (lenses) before you start. **Extend it** by adding or replacing a lens in `.dd/lenses/`.

### [logical-learning](logical-learning/README.md): your personal tutor
One subject, one project you want, one new concept per session, and a pass/fail gate at the end of each session that you don't get to mark yourself. **Extend it** with your own study tracks in `.learn/tracks/`.

### [runbooks](runbooks/README.md): immediate intelligent context injection
Short files of procedures, rules and lookup tables. On every prompt a cheap model picks the ones that apply and points the agent to them before it answers. **Extend it** with thresholds, lint rules and session-start lines in `.runbooks/`.

### [statusline](statusline/README.md): usage and context at a glance
Context fill and usage limits in the footer of Claude Code and Codex, with nothing running in the background, plus an on-demand session cost estimate in Codex.

### [logical-research](logical-research/README.md): research once, keep it usable 
Reads a question's sources, or a whole channel, book or doc set, in full, and writes context you can paste into a model later, with every claim graded and traced. **Extend it** with reading angles you reuse in `.lr/angles/`.

## How extending works

Every plugin has the same three layers.

| Layer | Where | Updates? |
|---|---|---|
| Core | the plugin | ships and updates with the plugin |
| Bundled defaults | the plugin | on by default, update with the plugin |
| Yours | a dot-folder in your repo (`.gtg/`, `.dd/`, `.lr/`, `.learn/`, `.postman/`, `.runbooks/`) | never touched by updates |

The plugin only reads your folder, so an update cannot overwrite your changes.

## License

See [LICENSE](LICENSE).
