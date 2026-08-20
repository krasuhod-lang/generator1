# Content Writer Quality Contract

## Purpose

InfoArticle and LinkArticle writers use an evidence-first contract. The model's `self_audit` is advisory; the rendered `article_html` is checked deterministically before publication readiness is calculated.

## Evidence-first discipline

Every technical, numeric, comparative, or time-sensitive claim is treated as one of three states:

| State | Writer behavior |
|---|---|
| `confirmed` | Use only when the claim is present in LAKB/IAKB/evidence or a supplied specification. |
| `bounded` | State the general principle together with conditions, limits, and a verification method. |
| `unknown` | Do not present it as a fact; direct the reader to the relevant manufacturer documentation, measurement, or additional source. |

The writer must not invent dates, percentages, torque values, clearances, named studies, brands, people, credentials, or case results. It must distinguish similar concepts rather than collapsing them into one claim. For example, a two-piece component is not automatically floating, and lower mass does not guarantee better cooling.

## Required HTML structure

The shared `articleHtmlContract` validator checks the final HTML for:

- one H1;
- one byline directly after H1, with a valid non-future `time` date;
- one `lead-answer` before the TOC;
- one TOC with no dead anchors and coverage of all planned H2 anchors;
- an `answer-lead` at the start of each main H2 section;
- exactly one anonymous-role `expert-opinion` block;
- one FAQ block with 4–6 questions before summary;
- one `section.summary` with 3–6 list items;
- one conclusion block;
- pipeline-specific anchor and image contracts.

A failed structural contract is written to the Quality Core as `html_contract` with `blocking=true`. The task can still be stored for review, but `canPublish=false` prevents treating malformed content as publication-ready.

## Repair behavior

The writer receives deterministic issue feedback for a corrective pass. The system never trusts a claimed `self_audit` flag when the HTML contradicts it. Persistent issues are retained in the validation report with categories such as `byline`, `toc`, `h2_anchor`, `answer_lead`, `expert_opinion`, `faq_block`, `summary_block`, `conclusion`, and `future_date`.

## Editorial principle

The layer follows the public evidence-first principles associated with professional SEO prompt practice: define the task and constraints, provide reliable inputs, separate facts from hypotheses, check outputs, and translate findings into implementation. It does not claim that LLM output alone proves a ranking factor or guarantees a top position.
