# Local Talk implementation plan
Goal: implement the three approved Talk screens using shared conversation records and accepted answer provenance.

Architecture: a four-operation speech port isolates device APIs. A controller owns ephemeral drafts, consent, cancellation generations and bounded dialogue. React renders accepted Chat answers and their exact sources. Technology: TypeScript, React, Vitest/jsdom.

1. Add fake-engine acceptance tests in `apps/web/components/Talk.test.ts` and locality tests in `apps/web/lib/speech.test.ts`; run focused Vitest and observe missing implementation failures.
2. Implement `SpeechEnginePort`, fake and verified local adapter in `apps/web/lib/speech.ts`. Require local recognition availability and a local synthesis voice; reject all other cases.
3. Implement `TalkController`, `RecognitionReview`, and `/talk`, sharing the existing ask endpoint and accepted answer presenter. Cancel synchronously, invalidate pending work, and require confirmation before any low/unknown-confidence submission.
4. Test pointer/keyboard release, transcript provenance, all five states, consent, bounded dialogue and cancellation races. Run `pnpm test` before submission; report any unresolved findings.

Owned screens: Talk transcript and push-to-talk; Talk capability and active provider state; Talk recognition review; shared Answer and Why / sources panel.
Entities: shared Conversation, ConversationTurn, AnswerProvenance, current VoiceSettings; ephemeral RecognitionDraft.
