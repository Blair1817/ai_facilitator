import React, { useEffect, useState } from "react";
import { usePlayer } from "@empirica/core/player/classic/react";
import { useTajribaConnected } from "@empirica/core/player/react";
import { Button } from "../components/Button";

export function Debriefing({ next }) {
  const player = usePlayer();
  const tajribaConnected = useTajribaConnected();
  const [advancing, setAdvancing] = useState(false);
  const participantId = player?.id || "Not available";

  useEffect(() => {
    if (!player.get("debriefingSeenAt")) {
      player.set("debriefingSeenAt", Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFinish = () => {
    if (advancing || !tajribaConnected) return;
    setAdvancing(true);
    next();
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 px-4 py-8 sm:px-8">
      <main className="mx-auto w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <article className="space-y-6 break-words text-base leading-7 text-gray-700">
          <div>
            <h1 className="text-2xl font-bold leading-8 text-gray-900">Thank you for taking part</h1>
            <p className="mt-2 font-semibold text-gray-700">Please scroll down to read the full debriefing.</p>
          </div>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">What was this study about?</h2>
            <p className="mt-2">This study investigates how different forms of AI facilitation may influence discussion and decision-making in small groups.</p>
            <p className="mt-2">During the study, you completed two group decision tasks. Group members received different task-relevant information. This design allows us to examine how groups share, discuss, and integrate information when reaching a joint decision.</p>
            <p className="mt-2">In different parts of the study, the AI facilitator may have used different fixed or discussion-responsive ways of supporting the conversation. The facilitator did not make decisions for the group. It was designed to encourage discussion and help organise information that had been raised in the group chat.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">Why was not all information explained in advance?</h2>
            <p className="mt-2">Some details about the allocation of information and the AI facilitation conditions were not explained fully before participation because knowing them in advance could change how people communicate and affect the validity of the study.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">How will my data be used?</h2>
            <p className="mt-2">We will analyse anonymised or pseudonymised responses, decision outcomes, questionnaire answers, and group-chat data for academic research purposes. Your name will not be included in research reports or publications. Data will be stored securely and handled in accordance with the study information provided during consent.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">Withdrawal</h2>
            <p className="mt-2">If you wish to withdraw your data, please contact <a className="break-all text-blue-700 underline sm:break-normal" href="mailto:jingnan.zhang.24@ucl.ac.uk">jingnan.zhang.24@ucl.ac.uk</a> by [withdrawal deadline]. Please include your participant ID: <strong className="break-all">{participantId}</strong>. After this date, withdrawal may no longer be possible because the data may have been anonymised and combined with other participants&apos; data.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">Questions or concerns</h2>
            <p className="mt-2">For questions about this study or to request withdrawal of your data, please contact:</p>
            <p className="mt-2"><strong>Jingnan Zhang</strong>, <a className="break-all text-blue-700 underline sm:break-normal" href="mailto:jingnan.zhang.24@ucl.ac.uk">jingnan.zhang.24@ucl.ac.uk</a></p>
            <p className="mt-2"><strong>Academic supervisor:</strong><br />[Supervisor name], [UCL email]</p>
            <p className="mt-4">Please do not discuss the specific task materials or AI conditions with people who may take part in this study later.</p>
          </section>
        </article>

        {!tajribaConnected && (
          <p className="mt-6 text-center text-sm text-gray-500">Reconnecting… please wait.</p>
        )}

        <div className="mt-8 flex justify-end border-t border-gray-100 pt-6">
          <Button handleClick={handleFinish} disabled={advancing || !tajribaConnected}>
            Finish study
          </Button>
        </div>
      </main>
    </div>
  );
}
