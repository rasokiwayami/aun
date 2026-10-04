# AUN · 阿吽

### Forge an AI that gets you.

**Stop introducing yourself to AI.**

Your taste. Your limits. The reasons behind your decisions. The things you are tired of explaining.

You should not need a perfect prompt to be understood.

AUN is a local personal-context forge: talk through what matters, review what the AI thinks it learned, and carry the context you choose into your next conversation.

**Your story. Your rules. Your next AI.**

[日本語](README.ja.md) · [Get started](#get-started) · [Under the hood](#under-the-hood)

## Understanding should survive a new chat

In Japanese, *aun no kokyū* — 阿吽の呼吸 — describes being so in sync that little needs to be said. Shared rhythm. Unspoken understanding.

That is the ambition: an AI that knows the shape of your thinking before you finish explaining it. Something that feels less like briefing a stranger and more like picking up a conversation with someone who knows you.

We want “you get me” to become the starting point.

Today, AUN builds the context that could make that possible: preferences, priorities, boundaries, and the conditions that change your answer. You inspect that context, change it, and decide where it goes.

## Give your next AI a head start

*Illustrative example — not a recorded conversation or a generated result:*

> **You:** “For a weekend away, I'd rather stay somewhere quiet than near the nightlife. Unless I'm going with friends.”
>
> **A note to review:** Prefers quiet accommodation for solo weekend trips. Group trips need a separate check.
>
> **Reuse:** Include the approved note in a travel context pack, then paste it into the AI you want to plan with.

One answer becomes something you can use again. The exception stays attached. You decide whether the interpretation fits.

### Let the questions come to you

Open your vault and a concrete first question is waiting. Turn on the optional ChatGPT connection and sending consent for questions that respond to your answers. The 300-question bank provides starting points; you do not have to complete it. Skip, pause, and return to the same question later.

### Keep the final say on who you are

Your words and the AI's interpretations stay separate. Review a proposed note, defer it, or accept it for one task. Edit saved notes and trace them back to their sources. Correcting a source invalidates dependent notes so an old interpretation does not quietly keep speaking for you.

### Take your context with you

Choose a purpose, inspect the selected notes, and export Markdown or JSON. A pack can carry relevant preferences into another AI conversation without making you rebuild the whole introduction. Export is manual; AUN does not write to ChatGPT's built-in memory.

## Get started

**Early prototype.** The interface is currently Japanese and uses the earlier name, **ひとつずつ**. The repository slug remains `hitotsuzutsu`.

The local core needs **Node.js 26+**. Recording, reviewing, editing, and exporting work without a ChatGPT connection or native build.

```sh
git clone https://github.com/rasokiwayami/hitotsuzutsu.git
cd hitotsuzutsu
npm ci
npm start
```

Open [localhost:43127](http://127.0.0.1:43127/) and create a vault passphrase. If you create a recovery code, keep it somewhere safe and separate. Losing both the passphrase and recovery material means losing access.

1. Answer the opening question. With cloud sending off, answers stay local; use **別の問いへ** to move on.
2. Review proposed interpretations under **整理案** when using the optional AI connection. You can also create notes directly.
3. Open **使えるメモ → 用途に合わせて使う** to preview and export a context pack.
4. Choose **今日はここまで** to pause. Saved answers and your question position remain. Saving an unfinished draft is optional and lasts 24 hours.

### Optional ChatGPT connection and Mac voice

The optional sign-in DevKit has a separate **noncommercial license**. Read the [dependency and service terms](LICENSES/README.md) before installing it; the core's MIT license does not override them.

On macOS with Xcode Command Line Tools:

```sh
npm run setup:siwc -- --accept-noncommercial
npm run build
```

Connect through the app and enable sending when you want adaptive questions and proposed notes. Access depends on account eligibility and service limits. AUN does not import existing ChatGPT conversations or memories.

Mac voice uses on-device Japanese speech recognition. Start the microphone yourself; partial recognition stays a draft. Microphone startup and shutdown have been checked on a real Mac; transcription accuracy and a complete spoken conversation remain unverified.

## Your memory needs an off switch. And an edit button.

The vault is encrypted locally. Cloud inference is optional and requires consent; when enabled, it sends your current answer and selected permitted context to the provider. AUN is not an entirely offline AI.

Notes can carry purposes, conditions, expiry, and permissions for AI use and external disclosure. You can correct or delete them. Exported copies and information already sent to a provider cannot be recalled by AUN. Independent backups remain independent copies.

Read the [data protection model](SECURITY.md) for encryption, recovery, deletion, and the limits of protection on a compromised device.

## Under the hood

```text
your words → source record → proposed interpretation → your review
                                                           ↓
                                      purpose + conditions + permissions
                                                           ↓
                                             Markdown / JSON context pack
```

The engineering principle is simple: **a model's guess is not your identity.**

AUN keeps source evidence, interpretation, confirmation, and action permission separate. Its local core uses encrypted SQLite storage; the optional provider adapter handles conversation. A context pack supplies information, not permission to act on your behalf.

- [Implementation and limits](docs/CURRENT_STATE.md)
- [Acceptance criteria and verification scope](docs/ACCEPTANCE.md)
- [Question bank provenance](docs/question-bank-provenance.md)

For development:

```sh
npm test
npm run check:public
```

Long-term reductions in explanation effort and interpretation errors have not yet been established. The ambition is shared understanding; the current implementation is an inspectable prototype for building and reusing context.

Core code: [MIT](LICENSE). Optional DevKit and dependencies: [separate terms](LICENSES/README.md).

---

**AUN · Less briefing. More understanding.**
