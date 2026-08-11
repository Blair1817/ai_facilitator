import React, {
    useEffect,
    useRef,
    useState,
} from "react";
import { usePlayer, usePlayers, useGame, useRound, useStage} from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { MentionsInput, Mention } from 'react-mentions';
import ReactMentionsStyling from "./ReactMentionsStyling.jsx";
import reactStringReplace from "react-string-replace";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";



export function Chat({
    scope,
    attribute = "chat",
    loading: LoadingComp = Loading,
}) {
    const player = usePlayer();
    const msgs = scope.getAttribute(attribute)?.items || []




    const handleNewMessage = (text) => {
        scope.append(attribute, {
            text,
            ts: new Date().getTime(),
            sender: {
                id: player.id,
                name: player.get("name") || player.id,
                hexCode: player.get("hexCode"),
                avatar: player.get("name") != "Facilitator" ? `https://api.dicebear.com/8.x/identicon/svg?rowColor=${player.get("hexCode")}` : "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F",
            },
        });
    };

    return (
        <div className="h-full w-full flex flex-col">
            <Messages msgs={msgs} />
            {player.stage.get("newMessages") && <div className="text-center bg-red-500 text-white py-1 px-4 rounded shadow-lg">
                <p>Scroll to bottom to see latest messages...</p>
            </div>}
            <Input onNewMessage={handleNewMessage} />
        </div>
    );
}

function Messages(props) {
    const { msgs } = props;
    const scroller = useRef(null);
    const player = usePlayer();
    const playerRef = useRef(player);
    playerRef.current = player;
    const stage = useStage();
    const game = useGame();
    const [msgCount, setMsgCount] = useState(0);
    const { hiddenInfoCue } = game.get("treatment");

    // This first effect is to detect scrolling to the bottom.
    // Depends on msgs.length so it re-runs when the scrollable div first mounts
    // (msgs going from 0 to 1 swaps the empty state for the message list).
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = el;
            if (scrollHeight - scrollTop - clientHeight < 10) {
                playerRef.current.stage.set('newMessages', false);
            }
        };

        el.addEventListener('scroll', handleScroll);
        return () => el.removeEventListener('scroll', handleScroll);
    }, [msgs.length]);


    // This effect is to manage auto-scrolling and alerting
    useEffect(() => {
        if (!scroller.current) {
            return;
        }

        const { scrollTop, scrollHeight, clientHeight } = scroller.current;
        const nMessagesUnseen = (scrollHeight - scrollTop - clientHeight) / 63; // 63 is the height of a message

        if (msgCount !== msgs.length) {
            setMsgCount(msgs.length);
            if (nMessagesUnseen > 3) {
                player.stage.set("newMessages", true);
            }
            else {
                player.stage.set("newMessages", false);
                scroller.current.scrollTop = scroller.current.scrollHeight;
            }
        }
    }, [scroller, props, msgCount]);


    if (msgs.length === 0) {
        return (
            <div className="h-full w-full flex justify-center items-center">
                <div className="flex flex-col justify-center items-center w-2/3 space-y-2">
                    <div className="w-24 h-24 text-gray-200">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-full w-full fill-current"
                            viewBox="0 0 512 512"
                        >
                            <path d="M123.6 391.3c12.9-9.4 29.6-11.8 44.6-6.4c26.5 9.6 56.2 15.1 87.8 15.1c124.7 0 208-80.5 208-160s-83.3-160-208-160S48 160.5 48 240c0 32 12.4 62.8 35.7 89.2c8.6 9.7 12.8 22.5 11.8 35.5c-1.4 18.1-5.7 34.7-11.3 49.4c17-7.9 31.1-16.7 39.4-22.7zM21.2 431.9c1.8-2.7 3.5-5.4 5.1-8.1c10-16.6 19.5-38.4 21.4-62.9C17.7 326.8 0 285.1 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208s-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9c-11.9 8.7-31.3 20.6-54.3 30.6c-15.1 6.6-32.3 12.6-50.1 16.1c-.8 .2-1.6 .3-2.4 .5c-4.4 .8-8.7 1.5-13.2 1.9c-.2 0-.5 .1-.7 .1c-5.1 .5-10.2 .8-15.3 .8c-6.5 0-12.3-3.9-14.8-9.9c-2.5-6-1.1-12.8 3.4-17.4c4.1-4.2 7.8-8.7 11.3-13.5c1.7-2.3 3.3-4.6 4.8-6.9c.1-.2 .2-.3 .3-.5z" />
                        </svg>
                    </div>

                    {stage.get("name") == "Task" & hiddenInfoCue ? 
                    <>
                    <h4 className="text-gray-700 font-semibold">No messages sent yet.</h4>

                    <p className="text-gray-500 text-center">
                    People may have different information about what is being discussed in this meeting, so encourage everyone to share all of the relevant information they have.
                    </p>
                    </>
                    :
                    <>
                    <h4 className="text-gray-700 font-semibold">No messages sent yet.</h4>

                    <p className="text-gray-500 text-center">
                        Send a message to start the conversation.
                    </p>
                    </>
                    }                    
                </div>
            </div>
        );
    }

    return (
        <div className="h-full overflow-auto pl-2 pr-4 pb-2" ref={scroller}>
            
            {stage.get("name") == "Task" & hiddenInfoCue ?
            <>
            <div className="flex items-start my-5 ml-4 justify-center">
                <div className="ml-3 text-sm">
                    <p className="text-gray-400 group-hover:text-gray-800 pt-3px" style={{ whiteSpace: "pre-line" }}>{"People may have different information about what is being discussed in this meeting, so encourage everyone to share all of the relevant information they have."}</p>
                </div>
            </div>
            </>
            : <></>
            }

            {msgs.map((msg) => (
                <MessageComp key={msg.id} attribute={msg} />
            ))}
        </div>
    );
}

function MessageComp({ attribute }) {
    const msg = attribute.value;
    const ts = attribute.createdAt;

    const renderMessageWithMentions = (text) => {
        return reactStringReplace(text, /@\[(\w+(?:\s+\w+)*)\]/g, (match, i) => (
            <span key={i} className="mention">
                @{match}
            </span>
        ));
    };

    let avatar = msg.sender.avatar;
    let hexCode = msg.sender.hexCode;

    let avatarImage = (
        <img
            className="inline-block h-9 w-9 rounded"
            src={avatar}
            alt={msg.sender.id}
        />
    );

    if (!avatar.startsWith("http")) {
        avatarImage = (
            <div className="inline-block h-9 w-9 rounded">{avatar}</div>
        );
    }

    return (
        <div className="flex items-start my-5 ml-4">
            <div className="flex-shrink-0">{avatarImage}</div>
            <div className="ml-3 text-sm">
                <p>
                    <span className="font-bold" style={{ color: "#" + hexCode }}>
                        {msg.sender.name}
                    </span>

                    <span className="pl-2 text-gray-400">{ts && relTime(ts)}</span>
                </p>
                <p className="text-gray-900 group-hover:text-gray-800 pt-3px" style={{ whiteSpace: "pre-line" }}>{renderMessageWithMentions(msg.text)}</p>
            </div>
        </div>
    );
}

function Input({ onNewMessage }) {
    const player = usePlayer();
    const game = useGame();
    const round = useRound();
    const messageDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "chat", field: "message" });
    const [text, setText] = usePersistentDraft(messageDraftKey, "");
    // Phase 6.2 (Q10 = "不显示"): the v2 design dropped the
    // treatment-level `facilitation` factor; the round-level value is
    // what gates the @Facilitator mention option today. v2 design only
    // has "static" and "adaptive" (both AI), so the @Facilitator option
    // is available in every practical case; the != "none" guard is kept
    // for the theoretical no-facilitator case.
    const facilitation = round?.get("facilitation");

    const mentionUsers = usePlayers().map((player) => ({
        id: player.id,
        display: player.get("name"),
    }));

    if (facilitation != "none") {
        mentionUsers.push({
            id: "ai",
            display: "Facilitator",
        });
    }



    const resize = (e) => {
        const target = e.target;
        target.style.height = "inherit";
        target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
    };

    const handleSubmit = (e) => {
        e.preventDefault();

        const txt = text.trim();
        if (txt === "") {
            return;
        }

        if (txt.length > 1024) {
            e.preventDefault();

            alert("Max message length is 1024");

            return;
        }

        onNewMessage(txt);
        player.set("isTyping", false);
        setText("");
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter" && e.shiftKey === false) {
            handleSubmit(e);
            resize(e);
        }
        if (!player.get("isTyping") && !(e.key === "Enter")) {
            player.set("isTyping", true);
            setTimeout(() => {
                player.set("isTyping", false);
            }, 1500);
        }
    };

    const handleBackspace = (e) => {
        if (e.key === "Backspace") {
            const { selectionStart } = e.target;
            const lastChar = text.slice(selectionStart - 1, selectionStart);

            // If the last character is part of a mention (indicated by @), remove the entire mention
            if (lastChar === "@") {
                const mentionStart = text.lastIndexOf(" ", selectionStart - 2);
                const mentionEnd = text.indexOf(" ", selectionStart) + 1 || text.length;
                const beforeMention = text.slice(0, mentionStart);
                const afterMention = text.slice(mentionEnd);

                setText(beforeMention + afterMention);
                e.preventDefault();
            }
        }
    };

    const handleKeyUp = (e) => {
        resize(e);
    };

    const svgContent = "M498.1 5.6c10.1 7 15.4 19.1 13.5 31.2l-64 416c-1.5 9.7-7.4 18.2-16 23s-18.9 5.4-28 1.6L284 427.7l-68.5 74.1c-8.9 9.7-22.9 12.9-35.2 8.1S160 493.2 160 480V396.4c0-4 1.5-7.8 4.2-10.7L331.8 202.8c5.8-6.3 5.6-16-.4-22s-15.7-6.4-22-.7L106 360.8 17.7 316.6C7.1 311.3 .3 300.7 0 288.9s5.9-22.8 16.1-28.7l448-256c10.7-6.1 23.9-5.5 34 1.4z"

    return (
        <form
            className="p-2 flex gap-2 border-t max-h-50%  position-relative resize-none"
            onSubmit={handleSubmit}
        >
            <div className="flex-col w-full">
                <MentionsInput
                    value={text}
                    onKeyDown={(e) => {
                        handleKeyDown(e);
                        handleBackspace(e);
                    }}
                    onChange={(e) => setText(e.target.value)}
                    style={ReactMentionsStyling}
                    placeholder="Write a message... (enter to submit, shift+enter for new line, @ to tag someone)"
                    forceSuggestionsAboveCursor={true}
                    multiline="true"
                    className="w-full"
                >
                    <Mention
                        trigger="@"
                        data={mentionUsers}
                        style={{ backgroundColor: "#daf4fa" }}
                        appendSpaceOnAdd={true}
                        markup="@[__display__]"
                    />
                </MentionsInput>
                <div style={{ height: "1rem" }}>
                    <TypingIndicator />
                </div>
            </div>


            <button
                type="button"
                className="rounded-md bg-gray-100 w-9 h-9 p-2 text-sm font-semibold text-gray-500 shadow-sm hover:bg-gray-200 hover:text-empirica-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-empirica-500"
                onClick={handleSubmit}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-full w-full fill-current"
                    viewBox="0 0 512 512"
                >
                    <path d={svgContent} />
                </svg>
            </button>
        </form>
    );
}

function relTime(date) {
    const difference = (new Date().getTime() - date.getTime()) / 1000;

    if (difference < 60) {
        return `now`;
    } else if (difference < 3600) {
        return `${Math.floor(difference / 60)}m`;
    } else if (difference < 86400) {
        return `${Math.floor(difference / 3600)}h`;
    } else if (difference < 2620800) {
        return `${Math.floor(difference / 86400)} days ago`;
    } else if (difference < 31449600) {
        return `${Math.floor(difference / 2620800)} months ago`;
    } else {
        return `${Math.floor(difference / 31449600)} years ago`;
    }
}

export function TypingIndicator() {
    const players = usePlayers();
    const typingPlayers = players.filter(player => player.get("isTyping"));

    if (typingPlayers.length === 0) {
        return null;
    }

    const typingNames = typingPlayers.map(player => player.get("name"));

    let message = '';
    if (typingNames.length === 1) {
        message = `${typingNames[0]} is typing...`;
    } else if (typingNames.length === 2) {
        message = `${typingNames[0]} and ${typingNames[1]} are typing...`;
    } else {
        const lastTypingName = typingNames.pop();
        message = `${typingNames.join(', ')}, and ${lastTypingName} are typing...`;
    }

    return <p style={{ fontStyle: "italic", color: "#888", fontSize: "0.75rem" }}>{message}</p>;
}
