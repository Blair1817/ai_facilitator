import React from "react";
import { usePlayers, usePlayer, useGame, useRound } from "@empirica/core/player/classic/react";
import { Avatar } from "../components/Avatar";

export function PlayerList() {
    const players = usePlayers();
    const focalPlayer = usePlayer();
    const game = useGame();
    const round = useRound();
    // Phase 6.2 (Q10 = "不显示"): the v2 design dropped the
    // treatment-level `facilitation` factor (.empirica/treatments.yaml
    // no longer declares it; only the round-level value exists), so
    // reading from `game.get("treatment").facilitation` returned
    // undefined and the AI Facilitator card never rendered. Read from
    // the round instead. v2 design only has "static" and "adaptive" (both
    // AI), so the card shows in every practical case; the != "none"
    // guard is kept for the theoretical no-facilitator case.
    const facilitation = round?.get("facilitation");

    return (
        <div style={styles.container}>
            <div style={styles.headerContainer}>
                <div style={styles.header} className="text-md leading-6 font-medium text-gray-900">Who's in the meeting?</div>
            </div>
            <div style={styles.gridContainer}>
                {players.map((player) => (
                    <div key={player.id} style={styles.playerCard}>
                        <div style={styles.avatar}><Avatar player={player} /></div>
                        <div style={styles.playerInfo}>
                            <span style={{ ...styles.playerName, color: "#" + player.get("hexCode") }}>{player.get("name")}{player.id == focalPlayer.id ? " (You)" : ""}</span>
                        </div>
                    </div>
                ))}
                {facilitation != "none" && facilitation != "human" &&
                    <div style={styles.playerCard}>
                        <div style={styles.avatar}><img
                            className="h-full w-full rounded-md shadow bg-white p-1"
                            src= "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F"
                            alt="Avatar"
                        /></div>
                        <div style={styles.playerInfo}>
                            <span style={styles.playerName}>Facilitator</span>
                        </div>
                    </div>
                }
            </div>
        </div>
    );
};

const styles = {
    container: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "20px",
        marginTop: "10px"
    },
    headerContainer: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        marginTop: "-12px",
    },
    header: {
        textAlign: "center",
        marginBottom: "10px",
    },
    gridContainer: {
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(2, auto)",
        gap: "10px",
        marginTop: "-20px"
    },
    playerCard: {
        display: "flex",
        alignItems: "center",
        padding: "5px",
        border: "1px solid #e0e0e0",
        borderRadius: "4px",
        backgroundColor: "#f9f9f9",
    },
    avatar: {
        width: "1.5rem",
        height: "1.5rem",
        marginRight: "10px",
    },
    playerInfo: {
        display: "flex",
        alignItems: "center",
    },
    playerName: {
        fontWeight: "bold",
        fontSize: "0.7rem",
        marginRight: "5px"
    },
};
