import { matchStopWord } from "../lib/stop-words.js";
import { isOwnerSource } from "../lib/delegate-marker.js";
import { answerContent, answersGoToAgent, answerTarget, askDb, AskRejected, asksDeps, ownerPresence, publishAsk, sendCalm } from "./asks.js";
import { configureSharedAskRuntime } from "./shared-ledger-v2-asks.js";
import { turnCuts } from "./turn-cuts.js";

/** A separate wiring leaf keeps commitAnswer's thin hook free of a runtime import cycle. */
export function initSharedAskWiring(): void {
  configureSharedAskRuntime({ db: askDb, publish: publishAsk, rejected: (status, code, message) => new AskRejected(status, code, message), async answered(input, view) {
    if (isOwnerSource(input.from)) ownerPresence.touch();
    publishAsk(view);
    if (!answersGoToAgent(view)) return;
    const to = await answerTarget(view);
    if (isOwnerSource(input.from)) turnCuts.noteHuman(to.channelId, matchStopWord(input.original ?? input.text).stop);
    await sendCalm(input.from, to, "response", answerContent(view, input.picks, input.text, input.original, to), view.id, "ask_answer");
    const deps = asksDeps();
    if (input.via !== "discord" && view.discordMessageIds.length && deps?.editDiscord) {
      void deps.editDiscord(view, input.picks.map((p) => p.label).join("、") || input.text)
        .catch((e: Error) => console.error(`shared ask Discord display update failed: ${e.message}`));
    }
  } });
}
