# opening_message.md — Facilitator opening message (DRAFT, engineering-authored, NOT research-approved)

> **Status: draft, not part of the original Prompt source package.** Added
> 2026-08-08 at the user's request ("facilitator在每次group chat开始的时候
> 给一些instructions的内容"). Unlike every other file in this directory,
> this is NOT an LLM prompt -- nothing calls a model to produce it. It is
> the literal, fixed text posted as the Facilitator's very first chat
> message at the start of every Task-stage discussion, identical for
> Static and Adaptive (see `server/src/callbacks.js`'s `onStageStart`
> handler, and `IMPLEMENTATION_LOGIC.md`'s "Opening message" section for
> why it was built this way). It has NOT been reviewed by the research
> team -- review the wording below before running any real session, the
> same way `expander.md`/`challenger.md`/`synthesiser.md` were reviewed.
>
> Everything below the `---` is sent to participants verbatim, exactly as
> written -- no template variables, no per-round substitution, no
> markdown rendering assumed. Keep it plain text, one short paragraph, and
> consistent with `base.md`'s HARD CONSTRAINTS (neutral, no options
> favoured, no task-specific claims) even though this file is never
> combined with `base.md` or passed to a model.

---

Hi everyone! I'm here to help support your discussion today. Feel free to share what you know, explain your reasoning, and consider different perspectives from your groupmates. I may occasionally jump in with a short question to help things along.
